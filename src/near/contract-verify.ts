// Read-only verification of a deployed mandate contract. Pure logic over injected chain readers, so tests can feed fakes and the CLI feeds real RPC.
// Nothing here can send a transaction.
export interface Check { name: string; ok: boolean; detail: string }
export interface ChainReader {
  chainId(): Promise<string>;
  viewAccount(id: string): Promise<{ codeHash: string } | null>;
  view(contract: string, method: string, args?: object): Promise<unknown>;
  accessKeys?(id: string): Promise<Array<{ publicKey: string; permission: unknown }>>;
}
export interface VerifyExpect { network: 'mainnet' | 'testnet'; contract: string; dao: string; agent: string; localHash: string; scopedKey?: { publicKey: string; methods: string[] } }

export const STATS_NUMBERS = ['version', 'mandates', 'approved', 'funded', 'executing', 'settling', 'completed', 'cancelled', 'expired', 'chunks_recorded', 'treasurers_with_trust'] as const;
/** Problems with a get_stats result; empty list = well-formed and internally consistent. */
export function validateStats(s: any): string[] {
  const p: string[] = [];
  if (!s || typeof s !== 'object') return ['get_stats did not return an object'];
  for (const k of STATS_NUMBERS) if (typeof s[k] !== 'number' || !Number.isInteger(s[k]) || s[k] < 0) p.push(`${k} is not a non-negative integer (${JSON.stringify(s[k])})`);
  if (typeof s.paused !== 'boolean') p.push('paused is not a boolean');
  if (typeof s.dao !== 'string' || !s.dao) p.push('dao is not an account id');
  if (typeof s.agent !== 'string' || !s.agent) p.push('agent is not an account id');
  if (s.pending_dao !== null && typeof s.pending_dao !== 'string') p.push('pending_dao is neither null nor an account id');
  if (!p.length) {
    const sum = s.approved + s.funded + s.executing + s.settling + s.completed + s.cancelled + s.expired;
    if (sum !== s.mandates) p.push(`status counts add up to ${sum} but mandates is ${s.mandates}`);
  }
  return p;
}

export const STATUSES = ['Approved', 'Funded', 'Executing', 'Settling', 'Completed', 'Cancelled', 'Expired'];
/** Problems with one Mandate as returned by get_mandate / list_mandates; empty = well-formed. */
export function validateMandate(m: any): string[] {
  const p: string[] = [];
  if (!m || typeof m !== 'object') return ['not an object'];
  if (!Number.isInteger(m.id) || m.id < 0) p.push('id');
  if (typeof m.treasurer !== 'string' || !m.treasurer) p.push('treasurer');
  if (typeof m.terms_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(m.terms_hash)) p.push('terms_hash is not 64 hex chars');
  if (typeof m.sell_token !== 'string') p.push('sell_token');
  for (const k of ['max_sell', 'sold']) if (typeof m[k] !== 'string' || !/^\d+$/.test(m[k])) p.push(`${k} is not a decimal string (U128)`);
  for (const k of ['start_ns', 'end_ns', 'created_ns']) if (typeof m[k] !== 'number' || m[k] < 0) p.push(k);
  if (!Number.isInteger(m.chunks) || m.chunks < 0) p.push('chunks');
  if (!STATUSES.includes(m.status)) p.push(`status "${m.status}" is not one of ${STATUSES.join('/')}`);
  if (!p.length && BigInt(m.sold) > BigInt(m.max_sell)) p.push('sold exceeds max_sell');
  if (!p.length && m.end_ns <= m.start_ns) p.push('end_ns is not after start_ns');
  return p;
}

/** Both near-api-js spellings of a function-call permission. */
export function functionCallPermission(perm: unknown): { receiver: string; methods: string[]; allowance: string | null } | null {
  const fc: any = (perm as any)?.FunctionCall ?? (perm as any)?.functionCall;
  if (!fc) return null;
  return { receiver: fc.receiver_id ?? fc.receiverId, methods: [...(fc.method_names ?? fc.methodNames ?? [])].sort(), allowance: fc.allowance ?? null };
}
export const isFullAccess = (perm: unknown) => perm === 'FullAccess' || (perm as any)?.FullAccess !== undefined || (perm as any)?.fullAccess !== undefined;

export const explorerAddress = (net: 'mainnet' | 'testnet', id: string) => (net === 'mainnet' ? `https://nearblocks.io/address/${id}` : `https://explorer.testnet.near.org/accounts/${id}`);

export async function verifyContract(r: ChainReader, e: VerifyExpect): Promise<{ checks: Check[]; explorer: string; onChainHash: string | null; stats: unknown }> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const safe = async <T>(f: () => Promise<T>): Promise<{ v?: T; err?: string }> => { try { return { v: await f() }; } catch (x) { return { err: String((x as Error).message ?? x).slice(0, 160) }; } };

  const cid = await safe(() => r.chainId());
  add('network identity', cid.v === e.network, `RPC reports chain_id "${cid.v ?? cid.err}", expected "${e.network}"`);
  if (cid.v !== e.network) return { checks, explorer: explorerAddress(e.network, e.contract), onChainHash: null, stats: null }; // never read a different network's state as if it were ours

  const acc = await safe(() => r.viewAccount(e.contract));
  const exists = !!acc.v;
  add('contract account exists', exists, exists ? e.contract : `${e.contract} not found${acc.err ? ` (${acc.err})` : ''}`);
  const onChainHash = acc.v?.codeHash ?? null;
  add('deployed code hash equals the committed wasm', !!onChainHash && onChainHash === e.localHash, `on chain ${onChainHash ?? 'none'} | local wasm ${e.localHash}`);
  if (!exists) return { checks, explorer: explorerAddress(e.network, e.contract), onChainHash, stats: null };

  const ver = await safe(() => r.view(e.contract, 'get_version'));
  add('contract version is 2', ver.v === 2, `get_version = ${JSON.stringify(ver.v ?? ver.err)}`);
  const st = await safe(() => r.view(e.contract, 'get_stats'));
  const problems = st.err ? [st.err] : validateStats(st.v);
  add('contract is initialised and get_stats is well-formed', problems.length === 0, problems.length ? problems.join('; ') : `mandates ${(st.v as any).mandates}, chunks ${(st.v as any).chunks_recorded}, completed ${(st.v as any).completed}`);
  const s: any = st.v;
  if (s && !problems.length) {
    add('DAO configured as intended', s.dao === e.dao, `contract dao ${s.dao} | expected ${e.dao}`);
    add('agent configured as intended', s.agent === e.agent, `contract agent ${s.agent} | expected ${e.agent}`);
    add('no DAO handover pending', s.pending_dao === null, `pending_dao = ${JSON.stringify(s.pending_dao)}`);
    const cfg = await safe(() => r.view(e.contract, 'get_config'));
    const c = cfg.v as any;
    add('get_config agrees with get_stats', Array.isArray(c) && c[0] === s.dao && c[1] === s.agent && c[2] === s.mandates, `get_config = ${JSON.stringify(cfg.v ?? cfg.err)}`);
    const pz = await safe(() => r.view(e.contract, 'is_paused'));
    add('is_paused agrees with get_stats', pz.v === s.paused, `is_paused = ${JSON.stringify(pz.v ?? pz.err)} | stats.paused = ${s.paused}`);
  }
  const dao = await safe(() => r.viewAccount(e.dao));
  add('DAO account exists', !!dao.v, e.dao);
  const pol = await safe(() => r.view(e.dao, 'get_policy'));
  const roles = (pol.v as any)?.roles;
  add('DAO answers get_policy with roles', Array.isArray(roles) && roles.length > 0, pol.err ?? `roles: ${(roles ?? []).map((x: any) => x.name).join(', ')}`);
  const ag = await safe(() => r.viewAccount(e.agent));
  add('agent account exists', !!ag.v, e.agent);

  if (r.accessKeys) {
    const keys = await safe(() => r.accessKeys!(e.contract));
    if (keys.v) {
      const full = keys.v.filter((k) => isFullAccess(k.permission)).length;
      add('contract account keys (info: 0 full-access keys = locked, immutable)', true, `${full} full-access key(s), ${keys.v.length - full} function-call key(s)`);
    }
    if (e.scopedKey) {
      const ak = await safe(() => r.accessKeys!(e.agent));
      const k = ak.v?.find((x) => x.publicKey === e.scopedKey!.publicKey);
      const fc = k ? functionCallPermission(k.permission) : null;
      const want = [...e.scopedKey.methods].sort().join(',');
      const ok = !!fc && fc.receiver === e.contract && fc.methods.join(',') === want;
      add('agent signs with a function-call key limited to the contract and its 5 methods', ok, k ? (fc ? `receiver ${fc.receiver}, methods ${fc.methods.join(',')}` : 'the key is FULL ACCESS (unexpected)') : 'the scoped key is not on the agent account');
    }
  }
  return { checks, explorer: explorerAddress(e.network, e.contract), onChainHash, stats: st.v ?? null };
}
