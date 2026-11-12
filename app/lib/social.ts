// near.social (FastData KV, standard social-kv/1) reads + explorer helpers. Source tag for everything here is 'chain' (indexed chain data).
// Mainnet: receiver `social`, kv.main.fastnear.com. Testnet: receiver `social.testnet`, kv.test.fastnear.com.
import { ENV } from './data';
import type { Result } from './types';

export const SOCIAL = ENV.network === 'mainnet'
  ? { receiver: 'social', kv: 'https://kv.main.fastnear.com', viewer: (a: string) => `https://near.social/${a}`, explorerTx: (h: string) => `https://nearblocks.io/txns/${h}`, explorerAccount: (a: string) => `https://nearblocks.io/address/${a}` }
  : { receiver: 'social.testnet', kv: 'https://kv.test.fastnear.com', viewer: (a: string) => `https://kv.test.fastnear.com/v0/latest/social.testnet/${a}`, explorerTx: (h: string) => `https://explorer.testnet.near.org/transactions/${h}`, explorerAccount: (a: string) => `https://explorer.testnet.near.org/accounts/${a}` };

export const REPUTATION_NS = 'quiettreasury/v1/reputation';

export interface KvEntry { predecessor_id?: string; key: string; value: any; block_height?: number; block_timestamp?: number; tx_hash?: string }
export interface RepMandate { id: number; reportHash: string; terms_hash: string; anchorTx?: string; contract: string; dao: string }
export interface RepEntry { treasurer: string; settled: number; mandates: RepMandate[] }

export const kvUrl = (predecessor: string) => `${SOCIAL.kv}/v0/latest/${SOCIAL.receiver}/${predecessor}`;

export async function readKv(predecessor: string, keyPrefix: string): Promise<Result<KvEntry[]>> {
  if (!predecessor) return { ok: false, error: 'No account configured for near.social reads.' };
  try {
    const r = await fetch(kvUrl(predecessor), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key_prefix: keyPrefix }), cache: 'no-store' });
    if (!r.ok) return { ok: false, error: `FastData KV HTTP ${r.status} (${kvUrl(predecessor)})` };
    const j = await r.json();
    return { ok: true, data: Array.isArray(j?.entries) ? (j.entries as KvEntry[]) : [], source: 'chain' };
  } catch (e) {
    return { ok: false, error: `${(e as Error).message} (${kvUrl(predecessor)})` };
  }
}

export const getReputation = async (publisher: string): Promise<Result<RepEntry[]>> => {
  const r = await readKv(publisher, `${REPUTATION_NS}/`);
  if (!r.ok) return r;
  return { ok: true, source: 'chain', data: r.data.map((e) => e.value).filter((v) => v && typeof v === 'object' && Array.isArray(v.mandates)) as RepEntry[] };
};
export const getPosts = async (account: string): Promise<Result<KvEntry[]>> => {
  const r = await readKv(account, 'post/');
  if (!r.ok) return r;
  return { ok: true, source: 'chain', data: r.data.filter((e) => e.value && typeof e.value.text === 'string').sort((a, b) => Number(b.block_timestamp ?? 0) - Number(a.block_timestamp ?? 0)) };
};
export const getProfile = async (account: string): Promise<Result<Record<string, string>>> => {
  const r = await readKv(account, 'profile/');
  if (!r.ok) return r;
  return { ok: true, source: 'chain', data: Object.fromEntries(r.data.map((e) => [e.key.replace('profile/', ''), String(e.value)])) };
};

/** Council members (named accounts) from the Sputnik policy roles. */
export const councilFromPolicy = (policy: Record<string, any> | undefined): Array<{ role: string; members: string[] }> =>
  ((policy?.roles ?? []) as any[]).filter((r) => r?.kind && typeof r.kind === 'object' && Array.isArray(r.kind.Group)).map((r) => ({ role: String(r.name), members: r.kind.Group as string[] }));

export const isNamed = (id: string) => !/^[0-9a-f]{64}$/.test(id);
export const tsFromNs = (ns?: number | string) => (ns ? new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '');
