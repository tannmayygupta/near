import { describe, expect, it } from 'vitest';
import { explorerAddress, validateMandate, validateStats, verifyContract, type ChainReader, type VerifyExpect } from '../src/near/contract-verify';

const E: VerifyExpect = { network: 'mainnet', contract: 'qt-mandate.owner.near', dao: 'quietdao-1.sputnik-dao.near', agent: 'qt-agent.owner.near', localHash: 'HASH', scopedKey: { publicKey: 'ed25519:SCOPED', methods: ['mark_funded', 'record_chunk', 'begin_settlement', 'complete', 'expire'] } };
const STATS = { version: 2, paused: false, dao: E.dao, agent: E.agent, pending_dao: null, mandates: 1, approved: 0, funded: 0, executing: 0, settling: 0, completed: 1, cancelled: 0, expired: 0, chunks_recorded: 3, treasurers_with_trust: 1 };

function reader(over: Partial<Record<string, any>> = {}): ChainReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async chainId() { calls.push('chainId'); return over.chain ?? 'mainnet'; },
    async viewAccount(id) { calls.push(`acct:${id}`); if (id === E.contract) return over.contract === null ? null : { codeHash: over.hash ?? 'HASH' }; return { codeHash: '' }; },
    async view(c, m) { calls.push(`view:${c}:${m}`); if (m === 'get_version') return over.version ?? 2; if (m === 'get_stats') return over.stats ?? STATS; if (m === 'get_config') return over.config ?? [STATS.dao, STATS.agent, 1]; if (m === 'is_paused') return over.paused ?? false; if (m === 'get_policy') return { roles: [{ name: 'council' }] }; throw new Error(`unexpected ${m}`); },
    async accessKeys(id) { calls.push(`keys:${id}`); if (id === E.contract) return over.contractKeys ?? []; return over.agentKeys ?? [{ publicKey: 'ed25519:SCOPED', permission: { FunctionCall: { receiver_id: E.contract, method_names: [...E.scopedKey!.methods], allowance: '1' } } }]; },
  };
}
const failing = (r: Awaited<ReturnType<typeof verifyContract>>) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe('read-only contract verification', () => {
  it('a correctly deployed contract passes every check and yields a real explorer URL', async () => {
    const r = await verifyContract(reader(), E);
    expect(failing(r)).toEqual([]); expect(r.checks.length).toBeGreaterThanOrEqual(13);
    expect(r.explorer).toBe('https://nearblocks.io/address/qt-mandate.owner.near'); expect(r.onChainHash).toBe('HASH');
  });
  it('a different deployed code hash fails', async () => { expect(failing(await verifyContract(reader({ hash: 'EVIL' }), E))).toContain('deployed code hash equals the committed wasm'); });
  it('a missing contract account fails and stops', async () => { const r = await verifyContract(reader({ contract: null }), E); expect(failing(r)).toContain('contract account exists'); expect(r.checks.some((c) => c.name.includes('version'))).toBe(false); });
  it('the wrong network fails immediately and reads nothing else (never mistake testnet state for mainnet)', async () => { const rd = reader({ chain: 'testnet' }); const r = await verifyContract(rd, E); expect(failing(r)).toEqual(['network identity']); expect(rd.calls).toEqual(['chainId']); });
  it('a contract initialised for another DAO or agent fails', async () => {
    expect(failing(await verifyContract(reader({ stats: { ...STATS, dao: 'attacker.near' }, config: ['attacker.near', STATS.agent, 1] }), E))).toContain('DAO configured as intended');
    expect(failing(await verifyContract(reader({ stats: { ...STATS, agent: 'attacker.near' }, config: [STATS.dao, 'attacker.near', 1] }), E))).toContain('agent configured as intended');
  });
  it('an uninitialised contract (get_stats panics) fails', async () => { const rd = reader(); const v0 = rd.view; rd.view = async (c, m, a) => { if (m === 'get_stats') throw new Error('contract not initialised'); return v0(c, m, a); }; expect(failing(await verifyContract(rd, E))).toContain('contract is initialised and get_stats is well-formed'); });
  it('a wrong contract version fails', async () => { expect(failing(await verifyContract(reader({ version: 1 }), E))).toContain('contract version is 2'); });
  it('a pending DAO handover is reported', async () => { expect(failing(await verifyContract(reader({ stats: { ...STATS, pending_dao: 'x.near' } }), E))).toContain('no DAO handover pending'); });
  it('inconsistent views fail (get_config vs get_stats, is_paused vs stats)', async () => {
    expect(failing(await verifyContract(reader({ config: ['a.near', 'b.near', 9] }), E))).toContain('get_config agrees with get_stats');
    expect(failing(await verifyContract(reader({ paused: true }), E))).toContain('is_paused agrees with get_stats');
  });
  it('an agent key that is FULL ACCESS instead of function-call-only fails', async () => {
    const r = await verifyContract(reader({ agentKeys: [{ publicKey: 'ed25519:SCOPED', permission: 'FullAccess' }] }), E);
    expect(failing(r)).toContain('agent signs with a function-call key limited to the contract and its 5 methods');
  });
  it('an agent key with a wider method list fails', async () => {
    const r = await verifyContract(reader({ agentKeys: [{ publicKey: 'ed25519:SCOPED', permission: { FunctionCall: { receiver_id: E.contract, method_names: [...E.scopedKey!.methods, 'create_mandate'], allowance: '1' } } }] }), E);
    expect(failing(r)).toContain('agent signs with a function-call key limited to the contract and its 5 methods');
  });
  it('reports (as information) how many full-access keys the contract account still has', async () => {
    const r = await verifyContract(reader({ contractKeys: [{ publicKey: 'k', permission: 'FullAccess' }] }), E);
    expect(r.checks.find((c) => c.name.startsWith('contract account keys'))!.detail).toMatch(/1 full-access/);
  });
  it('never sends anything: the reader interface has no write method', () => { expect(Object.keys(reader())).toEqual(expect.not.arrayContaining(['send', 'sign', 'call', 'deploy'])); });
});

describe('response validators', () => {
  it('validateStats accepts a real shape and rejects broken ones', () => {
    expect(validateStats(STATS)).toEqual([]);
    expect(validateStats({ ...STATS, completed: 5 })[0]).toMatch(/add up/);
    expect(validateStats({ ...STATS, paused: 'no' })).toContain('paused is not a boolean');
    expect(validateStats({ ...STATS, pending_dao: 3 })[0]).toMatch(/pending_dao/);
    expect(validateStats(null)).toEqual(['get_stats did not return an object']);
    expect(validateStats({ ...STATS, mandates: -1 }).length).toBeGreaterThan(0);
  });
  const M = { id: 0, treasurer: 'bob.near', terms_hash: 'a'.repeat(64), terms_json: null, sell_token: 'wrap.near', max_sell: '600', start_ns: 1, end_ns: 2, tier: 'small', status: 'Completed', sold: '600', chunks: 3, created_ns: 1, report_hash: 'b'.repeat(64), revealed_terms: null };
  it('validateMandate accepts a real shape and rejects broken ones', () => {
    expect(validateMandate(M)).toEqual([]);
    expect(validateMandate({ ...M, sold: '700' })).toContain('sold exceeds max_sell');
    expect(validateMandate({ ...M, status: 'Weird' })[0]).toMatch(/status/);
    expect(validateMandate({ ...M, terms_hash: 'x' })[0]).toMatch(/terms_hash/);
    expect(validateMandate({ ...M, max_sell: 600 })[0]).toMatch(/max_sell/);
    expect(validateMandate(undefined)).toEqual(['not an object']);
  });
  it('explorer URLs are per network', () => { expect(explorerAddress('testnet', 'a.testnet')).toBe('https://explorer.testnet.near.org/accounts/a.testnet'); });
});
