// OutLayer-custody data: the committed recorded runs (provenance). Nothing is invented: every figure is from
// app/public/demo-run/custody-run.json, restart-run.json (recorded) and testnet-outlayer-findings.json.
import { asset } from './data';
import type { Result } from './types';

export type CustodyPolicy = { mandate: number; storeTx: string; explorer: string; rules: { transaction_types: string[]; addresses: { mode: string; list: string[] }; limits: { per_transaction: { native: string } }; rate_limit: { max_per_hour: number } } };
export type CustodyRun = {
  recordedAt: string; network: string; custody: string; note: string;
  ids: { dao: string; mandateContract: string; vault: string };
  layerA: { wallet: { id: string; address: string; explorer: string }; policies: CustodyPolicy[]; probes: { name: string; blocked: boolean; status?: number | null; detail: string }[]; note: string };
  protocolScope?: { account: string; key: { publicKey: string; receiver: string; methods: string[]; allowanceNear: string; addTx: string; explorer: string | null }; probes: { name: string; expect: string; layer: string; result: string; ok: boolean; detail: string }[]; note: string };
  redteam: { attack: string; blocked: boolean; layer: string; error: string }[];
  real: { swaps: { index: number; tx: string; explorer: string; in: string; out: string }[]; payouts: { kind: string; label: string; to: string; amount: string; status: string; tx: string; explorer: string | null }[] };
  txs: { label: string; txHash: string }[];
  verifier: { ok: boolean; checks: { name: string; ok: boolean }[] };
  results: { name: string; ok: boolean; note?: string }[];
};
export type RestartRun = {
  recordedAt: string; mandateId: number; wallet: string; note: string;
  crash: { swapTx: string | null; explorer: string | null; chunksRecordedOnChainAtCrash: number };
  swaps: { index: number; tx: string; explorer: string; in: string; out: string }[];
  results: { name: string; ok: boolean; note?: string }[];
};
export type Finding = { id: string; result: string; claim: string; consequence?: string; evidence?: Record<string, unknown> };
export type Findings = { what: string; wallet: { id: string; address: string }; findings: Finding[] };

async function load<T>(path: string, label: string): Promise<Result<T>> {
  try {
    const r = await fetch(asset(path), { cache: 'no-store' });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status} loading ${label} (app/public${path})` };
    return { ok: true, data: (await r.json()) as T, source: 'recorded' };
  } catch (e) { return { ok: false, error: `Could not load ${label}: ${(e as Error).message}` }; }
}
export const getCustodyRun = () => load<CustodyRun>('/demo-run/custody-run.json', 'the recorded custody run');
export const getRestartRun = () => load<RestartRun>('/demo-run/restart-run.json', 'the recorded crash-restart run');
export const getFindings = () => load<Findings>('/demo-run/outlayer-findings.json', 'the OutLayer policy findings');
