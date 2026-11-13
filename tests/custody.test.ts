import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { policyRulesFor, MandatePolicy } from '../worker/adapters/mandate-policy';
import { OutLayerCustodySigner, KeySigner, idemUuid, txOfResponse } from '../worker/adapters/signers';
import { RefTestnetAdapter } from '../worker/adapters/ref-testnet';
import { OutLayerError } from '../src/near/outlayer';
import { PolicyApiError } from '../src/near/outlayer-policy';
import { Executor, defaultConfig } from '../worker/executor';
import { State } from '../worker/state';
import { BUY, FakeChain, FakeClock, FakeOutLayer, NEAR1, SELL, makeTerms } from './worker/fakes';

const DEX = 'ref-finance-101.testnet';
const terms = () => ({
  sellToken: 'nep141:wrap.testnet', buyToken: 'nep141:usdt.fakes.testnet', maxSellAmount: (4n * 10n ** 23n).toString(), chunkMin: (5n * 10n ** 22n).toString(), returnTo: 'dao.sputnikv2.testnet', feeRecipient: 'ops.testnet',
  payouts: [
    { label: 'alice', chain: 'near' as const, address: 'alice.testnet', token: 'nep141:usdt.fakes.testnet', percent: 50 },
    { label: 'bob', chain: 'solana' as const, address: 'SoLaddrBob11111111111111111111111111111111', token: 'nep141:usdt.fakes.testnet', percent: 20 },
  ],
});

describe('Layer A policy derived from DAO-approved terms', () => {
  it('whitelists exactly: sell + buy token contracts, the DEX and the DAO. Payees are NOT listed (token payouts are /call ft_transfers, so a payee list would be a protection Layer A does not provide)', () => {
    const { rules } = policyRulesFor(terms() as any, DEX);
    expect(new Set(rules.addresses.list)).toEqual(new Set(['wrap.testnet', 'usdt.fakes.testnet', DEX, 'dao.sputnikv2.testnet']));
    expect(rules.addresses.list).not.toContain('alice.testnet');
    expect(rules.addresses.mode).toBe('whitelist');
    expect(rules.transaction_types).toEqual(['call', 'transfer']);
  });
  it('caps native NEAR per transaction at the mandate budget (never below a 0.05 NEAR gas/storage floor) and scales the rate limit with the chunk count', () => {
    expect(policyRulesFor(terms() as any, DEX).rules.limits.per_transaction.native).toBe((4n * 10n ** 23n).toString());
    const tiny = policyRulesFor({ ...terms(), maxSellAmount: '1000' } as any, DEX).rules;
    expect(tiny.limits.per_transaction.native).toBe((5n * 10n ** 22n).toString());
    expect(tiny.rate_limit.max_per_hour).toBeGreaterThanOrEqual(60);
  });
  it('is deterministic: same terms -> same rules (so a restart does not rewrite the policy)', () => {
    expect(JSON.stringify(policyRulesFor(terms() as any, DEX))).toBe(JSON.stringify(policyRulesFor(terms() as any, DEX)));
  });
});

describe('MandatePolicy.ensure', () => {
  const mk = () => {
    const dir = mkdtempSync(join(tmpdir(), 'qt-pol-')); const calls: any[] = [];
    const wallet: any = { setPolicy: async (_o: unknown, p: unknown, id: string) => { calls.push({ p, id }); return { txHash: `tx${calls.length}`.padEnd(44, 'x'), version: calls.length }; } };
    const pol = new MandatePolicy({ wallet, owner: {} as any, walletId: 'w1', dex: DEX, path: join(dir, 'p.json') });
    return { dir, calls, pol, wallet };
  };
  it('writes once per mandate, reuses on the same terms, rewrites when the rules change, and survives a restart', async () => {
    const { dir, calls, pol, wallet } = mk();
    const a = await pol.ensure(7, terms() as any); expect(a.reused).toBe(false); expect(calls.length).toBe(1);
    expect((await pol.ensure(7, terms() as any)).reused).toBe(true); expect(calls.length).toBe(1);
    const changed = await pol.ensure(7, { ...terms(), maxSellAmount: (9n * 10n ** 23n).toString() } as any); expect(changed.reused).toBe(false); expect(calls.length).toBe(2);
    const again = new MandatePolicy({ wallet, owner: {} as any, walletId: 'w1', dex: DEX, path: join(dir, 'p.json') });
    expect((await again.ensure(7, { ...terms(), maxSellAmount: (9n * 10n ** 23n).toString() } as any)).reused).toBe(true); expect(calls.length).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('OutLayer custody signer', () => {
  const mkSigner = (wallet: any) => new OutLayerCustodySigner(wallet, 'a'.repeat(64), 'http://127.0.0.1:1', async () => {});
  const denied = new PolicyApiError(403, { error: 'policy_denied', message: "Address 'evil.testnet' is not in whitelist" }, 'POST /wallet/v1/call -> 403');
  it('a policy refusal on /call surfaces as OutLayerError policy_denied (never as a generic failure)', async () => {
    const s = mkSigner({ call: async () => { throw denied; } });
    await expect(s.call('evil.testnet', 'x', {}, 1n, 0n)).rejects.toMatchObject({ name: 'OutLayerError', kind: 'policy_denied', status: 403 });
  });
  it('token payouts are ft_transfer CALLS (never /transfer with a `token` field: OutLayer ignores it and sends yoctoNEAR dust); native returns use /transfer', async () => {
    const calls: any[] = [], transfers: any[] = [];
    const s = mkSigner({
      call: async (b: any, idem?: string) => { calls.push({ b, idem }); throw denied; },
      transfer: async (b: any, idem?: string) => { transfers.push({ b, idem }); throw denied; },
    });
    await expect(s.sendToken('usdt.fakes.testnet', 'evil.testnet', 5n, 'memo', '1:0:0:ft')).rejects.toMatchObject({ kind: 'policy_denied' });
    await expect(s.sendNative('evil.testnet', 5n, '1:0:0:native')).rejects.toMatchObject({ kind: 'policy_denied' });
    expect(transfers.length).toBe(1); expect(transfers[0].b).toEqual({ to: 'evil.testnet', amount: '5' }); // the token path never touched /transfer
    expect(calls[0].b).toMatchObject({ receiver_id: 'usdt.fakes.testnet', method_name: 'ft_transfer', args: { receiver_id: 'evil.testnet', amount: '5', memo: 'memo' }, deposit: '1' });
    expect(calls[0].idem).toBe(idemUuid('1:0:0:ft')); expect(transfers[0].idem).toBe(idemUuid('1:0:0:native'));
  });
  it('a 422 on-chain failure keeps its message and is not mislabelled as a policy denial', async () => {
    const s = mkSigner({ call: async () => { throw new PolicyApiError(422, { error: 'onchain_tx_failed', message: 'Smart contract panicked: not registered' }, 'x'); } });
    const e: any = await s.call('t.testnet', 'ft_transfer', {}, 1n, 1n).catch((x) => x);
    expect(e).toBeInstanceOf(OutLayerError); expect(e.kind).not.toBe('policy_denied');
  });
  it('a REPLAYED idempotency key answers with the original request: the tx hash is read from result.tx_hash (observed on OutLayer testnet), not only from the top level', () => {
    expect(txOfResponse({ status: 'success', tx_hash: 'AAA' })).toBe('AAA');
    expect(txOfResponse({ error: 'duplicate_idempotency_key', status: 'success', result: { result: '0', tx_hash: 'BBB' } })).toBe('BBB');
    expect(txOfResponse({ status: 'success' })).toBeUndefined();
  });
  it('idempotency keys are stable, UUID-shaped and different per step', () => {
    expect(idemUuid('3:1:0:swap')).toBe(idemUuid('3:1:0:swap'));
    expect(idemUuid('3:1:0:swap')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(idemUuid('3:1:0:swap')).not.toBe(idemUuid('3:1:0:wrap'));
  });
});

describe('adapter wiring', () => {
  it('requires a signer or a vault, reports its custody kind, and only writes policies when a policy manager is given', async () => {
    expect(() => new RefTestnetAdapter({ rpc: 'http://x', reserveYocto: 0n } as any)).toThrow();
    const signer = new OutLayerCustodySigner({} as any, 'b'.repeat(64), 'http://x');
    const a = new RefTestnetAdapter({ signer, rpc: 'http://x', reserveYocto: 0n });
    expect(a.custody).toBe('outlayer-custody'); expect(a.vaultId).toBe('b'.repeat(64));
    expect(await a.prepareMandate(1, makeTerms(new FakeClock()))).toEqual({});
    const k = new RefTestnetAdapter({ vault: { accountId: 'v.testnet' } as any, rpc: 'http://x', reserveYocto: 0n });
    expect(k.custody).toBe('key'); expect(new KeySigner({ accountId: 'v.testnet' } as any).kind).toBe('key');
  });
});

describe('executor prepare hook (Layer A is written BEFORE the first trade)', () => {
  const rig = (prepare: Executor extends never ? never : any) => {
    const clock = new FakeClock(), chain = new FakeChain(clock), ol = new FakeOutLayer(), state = new State(':memory:', randomBytes(32));
    ol.conf[SELL] = 5n * NEAR1;
    const exec = new Executor({ outlayer: ol, chain, state, clock, prepare, rng: { below: (n: number) => (n > 1 ? 1 : 0) } }, { ...defaultConfig('dao.near'), itemBackoffS: 1 });
    chain.add(makeTerms(clock));
    return { clock, chain, ol, state, exec };
  };
  it('no trade and no markFunded while prepare fails; the mandate trades once it succeeds, and prepare runs once', async () => {
    let n = 0; let fails = 2;
    const { clock, chain, ol, exec, state } = rig(async () => { n++; if (fails-- > 0) throw new Error('policy store failed'); return { policyTx: 'tx' }; });
    for (let i = 0; i < 2; i++) { await exec.tick(); clock.now += 3; }
    expect((await chain.getMandate(0))!.status).toBe('Approved'); expect(ol.swaps.length).toBe(0);
    expect(state.events(0).some((e) => e.kind === 'prepare_error')).toBe(true);
    for (let i = 0; i < 400 && state.runtime(0).phase !== 'done'; i++) { await exec.tick(); clock.now += 3; }
    expect((await chain.getMandate(0))!.status).toBe('Completed'); expect(ol.swaps.length).toBeGreaterThan(0);
    expect(n).toBe(3); // 2 failures + 1 success: not once per tick
    expect(state.events(0).some((e) => e.kind === 'prepared')).toBe(true);
  });
});

void BUY;
