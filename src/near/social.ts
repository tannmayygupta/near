// near.social client (standard "social-kv/1" on FastData KV). Verified 2026-11-12 against https://api2.near.social/standard.md and skill.md.
//
// Writes are a plain FunctionCall `__fastdata_kv` on the account `social` (mainnet) / `social.testnet` (testnet), gas 1, deposit 0.
// The receipt ALWAYS fails with CodeDoesNotExist (no contract on that account) - that is expected; the FastData indexer still stores the data.
// Reads come from FastData KV: `${kv}/v0/latest/{receiver}/{predecessor}` (POST {key_prefix}) and `.../{key}` (GET). Mainnet also has the
// near.social indexer (api2.near.social) which understands the standard keys (post/, profile/, graph/, like/ ...) and ignores unknown keys;
// our reputation namespace `quiettreasury/v1/...` is therefore stored (and publicly readable) in FastData but not rendered by the near.social UI.
import type { Account } from 'near-api-js';

export type SocialNet = 'mainnet' | 'testnet';
export interface SocialCfg { receiver: string; kv: string; api?: string; explorerTx: string; viewer: string }

export const SOCIAL: Record<SocialNet, SocialCfg> = {
  mainnet: { receiver: 'social', kv: 'https://kv.main.fastnear.com', api: 'https://api2.near.social', explorerTx: 'https://nearblocks.io/txns/', viewer: 'https://near.social/' },
  testnet: { receiver: 'social.testnet', kv: 'https://kv.test.fastnear.com', explorerTx: 'https://testnet.nearblocks.io/txns/', viewer: 'https://kv.test.fastnear.com/v0/latest/social.testnet/' },
};

export const REPUTATION_NS = 'quiettreasury/v1/reputation';

export interface KvEntry { predecessor_id?: string; current_account_id?: string; key: string; value: unknown; block_height?: number; block_timestamp?: number; tx_hash?: string; receipt_id?: string }

/** Post ids: decimal integer 1..2^53-1. Deterministic ids make publishing idempotent (same mandate+kind => same post id). */
export const postId = (mandateId: number, kind: 'announce' | 'complete'): string => String(1_700_000_000_000_000 + mandateId * 10 + (kind === 'announce' ? 1 : 2));

export const postArgs = (id: string, text: string) => ({ [`post/${id}`]: { text } });
export const profileArgs = (p: { name?: string; about?: string; website?: string }) => ({
  ...(p.name ? { 'profile/name': p.name } : {}),
  ...(p.about ? { 'profile/about': p.about } : {}),
  ...(p.website ? { 'profile/links/website': p.website } : {}),
});

export interface ReputationEntry {
  treasurer: string;
  settled: number; // contract trust score: mandates settled with zero violations
  mandates: Array<{ id: number; reportHash: string; terms_hash: string; anchorTx?: string; contract: string; dao: string }>;
  updatedBlock?: string;
}
export const reputationArgs = (e: ReputationEntry) => ({ [`${REPUTATION_NS}/${e.treasurer}`]: e });

export function assertKvArgs(args: Record<string, unknown>): void {
  const keys = Object.keys(args);
  if (keys.length === 0 || keys.length > 256) throw new Error('args must have 1..256 keys');
  for (const k of keys) {
    if (!/^[\x21-\x7e]+$/.test(k)) throw new Error(`key must be ASCII: ${k}`);
    if (Buffer.byteLength(k) > 1024) throw new Error(`key too long: ${k.slice(0, 40)}`);
    if (Buffer.byteLength(JSON.stringify(args[k])) > 262_144) throw new Error(`value too large: ${k}`);
  }
}

export type KvSender = (receiver: string, args: Record<string, unknown>) => Promise<string>;

/** Send a FastData KV write with a NEAR account. Returns the tx hash. The receipt failure (CodeDoesNotExist) is expected and swallowed. */
export function senderFor(acc: Account): KvSender {
  return async (receiver, args) => {
    try {
      const o: any = await acc.callFunctionRaw({ contractId: receiver, methodName: '__fastdata_kv', args, gas: 1n, deposit: 0n });
      return o.transaction?.hash ?? o.transaction_outcome?.id ?? '';
    } catch (e: any) {
      const h = e?.transactionResult?.transaction?.hash ?? e?.transactionResult?.transaction_outcome?.id ?? e?.transaction_outcome?.id;
      if (h) return String(h); // expected: the call lands, the receipt fails with CodeDoesNotExist
      throw e;
    }
  };
}

export async function writeKv(net: SocialNet, send: KvSender, args: Record<string, unknown>): Promise<{ txHash: string; explorer: string }> {
  assertKvArgs(args);
  const txHash = await send(SOCIAL[net].receiver, args);
  return { txHash, explorer: SOCIAL[net].explorerTx + txHash };
}

type F = typeof fetch;
export async function readKv(net: SocialNet, predecessor: string, keyPrefix: string, f: F = fetch): Promise<KvEntry[]> {
  const c = SOCIAL[net];
  const r = await f(`${c.kv}/v0/latest/${c.receiver}/${predecessor}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key_prefix: keyPrefix }) });
  if (!r.ok) throw new Error(`FastData KV ${r.status}`);
  const j: any = await r.json();
  return Array.isArray(j?.entries) ? j.entries : [];
}

export async function readKey(net: SocialNet, predecessor: string, key: string, f: F = fetch): Promise<KvEntry | null> {
  const es = await readKv(net, predecessor, key, f);
  return es.find((e) => e.key === key) ?? null;
}

/** Wait until FastData has indexed a key written by `predecessor` (polls). Mainnet may also use api2 /v1/tx/{hash}. */
export async function waitIndexed(net: SocialNet, predecessor: string, key: string, o: { tries?: number; delayMs?: number; f?: F; sleep?: (ms: number) => Promise<void> } = {}): Promise<KvEntry | null> {
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < (o.tries ?? 20); i++) {
    const e = await readKey(net, predecessor, key, o.f).catch(() => null);
    if (e) return e;
    await sleep(o.delayMs ?? 2000);
  }
  return null;
}

export async function txIndexedMainnet(txHash: string, f: F = fetch): Promise<{ indexed: boolean; raw: unknown }> {
  const r = await f(`${SOCIAL.mainnet.api}/v1/tx/${txHash}`);
  const j: any = await r.json();
  return { indexed: !!j?.indexed, raw: j };
}

export const nearSocialPostUrl = (account: string, id: string) => `https://near.social/${account}/post/${id}`;
