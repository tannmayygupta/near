// Sealed-mandate data: the committed recorded run (provenance) + live reads of the on-chain mandate.
// Nothing is invented: every figure is from app/public/demo-run/sealed-run.json (recorded) or from NEAR RPC (chain).
import { asset, getMandate, sha256Hex } from './data';
import { canonical } from './canon';
import type { OnchainMandate, Result } from './types';

export type SealedCheck = { name: string; ok: boolean; detail?: string };
export type SealedRun = {
  recordedAt: string;
  mode: string;
  network: string;
  mandateId: number;
  ids: { dao: string; mandateContract: string; council: string[]; vault: string; dex: string };
  commitment: {
    hash: string;
    saltLength: number;
    publicBeforeCompletion: { terms_json: string | null; revealed_terms: string | null };
    forbiddenStrings: string[];
  };
  intent: string;
  parse: { summary: string[]; attempts: number; model: string; floorFromLivePool?: { poolId: number; spot: number; floor: string } };
  mandate: Record<string, unknown>;
  proposals: { id: number; status: string; description: string; kind: string }[];
  swaps: { index: number; tx: string; explorer: string; in: string; out: string }[];
  payouts: { kind: string; label: string; to: string; token: string; amount: string; status: string; tx: string; explorer: string }[];
  revealOnChain: { revealed_terms_bytes: number; terms: Record<string, unknown> };
  verifier: { ok: boolean; checks: SealedCheck[] };
  txs: { label: string; txHash: string; explorer?: string }[];
  results: { name: string; ok: boolean; note?: string }[];
};

export async function getSealedRun(): Promise<Result<SealedRun>> {
  try {
    const r = await fetch(asset('/demo-run/sealed-run.json'), { cache: 'no-store' });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status} loading the committed sealed run (app/public/demo-run/sealed-run.json)` };
    return { ok: true, data: (await r.json()) as SealedRun, source: 'recorded' };
  } catch (e) {
    return { ok: false, error: `Could not load the committed sealed run: ${(e as Error).message}` };
  }
}

export const getLiveSealedMandate = (id: number) => getMandate(id);

/** What the chain stores after settlement: revealed_terms = JSON {salt, terms}. */
export type Reveal = { salt: string; terms: Record<string, unknown> };
export function parseReveal(m: OnchainMandate | null): Reveal | null {
  if (!m?.revealed_terms) return null;
  try {
    const j = JSON.parse(m.revealed_terms) as Partial<Reveal>;
    return typeof j.salt === 'string' && j.terms && typeof j.terms === 'object' ? { salt: j.salt, terms: j.terms } : null;
  } catch {
    return null;
  }
}

/** commit = sha256(salt | canonicalJson(terms)) — identical to src/engine/hash.ts `commit`. */
export const commitOf = (terms: unknown, salt: string) => sha256Hex(`${salt}|${canonical(terms)}`);

/** Explorer rows we show by label (the full 30-tx list is in the committed run). */
export const KEY_TX_PATTERNS: { title: string; re: RegExp }[] = [
  { title: 'Seal: DAO proposal (terms_json = null, commitment only)', re: /DAO proposal: create_mandate/i },
  { title: 'Seal: council vote 2/3 executes it', re: /vote 2\/3 approve \(council2\)/i },
  { title: 'Fund: DAO Transfer proposal', re: /DAO proposal: Transfer budget/i },
  { title: 'Fund: vote 2/3 executes the real transfer', re: /funding vote 2\/3/i },
  { title: 'Trade: first real swap on Ref Finance', re: /wrap\.testnet\.ft_transfer_call/i },
  { title: 'Settle: first payout', re: /usdt\.fakes\.testnet\.ft_transfer/i },
  { title: 'Reveal: complete() anchors the report and reveals the terms', re: /complete #12/i },
];
