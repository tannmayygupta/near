import { describe, expect, it, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Executor, defaultConfig } from '../../worker/executor';
import { State } from '../../worker/state';
import { GuardError, assertDestination, assertSwap, requiredApprovals } from '../../worker/guards';
import { nep413Hash, verifySignature } from '../../worker/auth';
import { runAttack } from '../../worker/redteam';
import { OutLayerError } from '../../src/near/outlayer';
import { commit } from '../../src/engine/hash';
import { BUY, FakeChain, FakeClock, FakeOutLayer, NEAR1, SELL, makeTerms } from './fakes';

let clock: FakeClock, chain: FakeChain, ol: FakeOutLayer, state: State, exec: Executor;
const key = randomBytes(32);
function rig(cfg: Partial<ReturnType<typeof defaultConfig>> = {}) {
  clock = new FakeClock(); chain = new FakeChain(clock); ol = new FakeOutLayer(); state = new State(':memory:', key);
  ol.conf[SELL] = 5n * NEAR1;
  exec = new Executor({ outlayer: ol, chain, state, clock, rng: { below: (n) => (n > 1 ? 1 : 0) } }, { ...defaultConfig('dao.near'), itemBackoffS: 1, ...cfg });
}
async function run(until: () => boolean, max = 400) { for (let i = 0; i < max && !until(); i++) { await exec.tick(); clock.now += 3; } }
const done = (id = 0) => () => state.runtime(id).phase === 'done';
beforeEach(() => rig());

describe('happy path', () => {
  it('executes chunks, pays out, returns leftovers, anchors report', async () => {
    chain.add(makeTerms(clock));
    await run(done());
    const m = (await chain.getMandate(0))!;
    expect(m.status).toBe('Completed');
    expect(BigInt(m.sold)).toBeLessThanOrEqual(5n * NEAR1);
    expect(BigInt(m.sold)).toBe(5n * NEAR1); // budget exhausted exactly
    expect(m.chunks).toBe(state.chunks(0).filter((c) => c.status === 'success').length);
    expect(m.report_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(chain.trust.get('alice.near')).toBe(1);
    const kinds = ol.withdrawals.map((w) => w.to);
    expect(kinds).toContain('ops.near'); expect(kinds).toContain('SoLaddrAlice1111111111111111111111111111111');
    expect(ol.conf[SELL]).toBe(0n); // nothing stranded
    expect(ol.conf[BUY]).toBe(0n);
    expect(state.report(0).floorRespected).toBe(true);
  });
  it('never submits a swap above the remaining budget and every swap carries min_amount_out', async () => {
    chain.add(makeTerms(clock)); await run(done());
    expect(ol.swaps.every((s) => BigInt(s.amountIn) <= 2n * NEAR1 && !!s.minOut)).toBe(true);
  });
  it('idempotency keys are mandate:chunk:attempt and unique', async () => {
    chain.add(makeTerms(clock)); await run(done());
    const keys = ol.swaps.map((s) => s.idem); expect(new Set(keys).size).toBe(keys.length); expect(keys[0]).toBe('0:0:0');
  });
});

describe('price floor', () => {
  it('floor never met: no swaps, budget returned, mandate still settles', async () => {
    ol.price = 2.0; chain.add(makeTerms(clock));
    await run(() => clock.now > 1_800_000_000 + 3700 || done()(), 2000);
    await run(done(), 100);
    expect(ol.swaps.length).toBe(0);
    expect(state.runtime(0).floor_misses).toBeGreaterThan(0);
    expect((await chain.getMandate(0))!.status).toBe('Completed');
    expect(ol.withdrawals.some((w) => w.token === SELL && w.to === 'dao.near' && w.amount === (5n * NEAR1).toString())).toBe(true);
  });
});

describe('refunded / failed swaps', () => {
  it('refunded swap is retried with a NEW idempotency key and does not consume budget', async () => {
    ol.failSwaps = ['refunded']; chain.add(makeTerms(clock)); await run(done());
    const keys = ol.swaps.map((s) => s.idem);
    expect(keys.slice(0, 2)).toEqual(['0:0:0', '0:0:1']);
    expect(BigInt((await chain.getMandate(0))!.sold)).toBe(5n * NEAR1);
  });
  it('stops trading after maxChunkAttempts failures and still settles', async () => {
    ol.failSwaps = ['failed', 'failed', 'failed', 'failed', 'failed']; chain.add(makeTerms(clock)); await run(done());
    expect(state.runtime(0).stop_reason).toMatch(/failed/);
    expect((await chain.getMandate(0))!.status).toBe('Completed');
    expect(BigInt((await chain.getMandate(0))!.sold)).toBe(0n);
  });
});

describe('kill switch', () => {
  it('DAO cancel mid-run stops trading, returns everything, no payouts', async () => {
    chain.add(makeTerms(clock));
    await run(() => state.chunks(0).filter((c) => c.status === 'success').length >= 2);
    const swapsBefore = ol.swaps.length; chain.cancel(0);
    await run(done());
    expect(ol.swaps.length).toBe(swapsBefore); // nothing after cancel
    expect(ol.withdrawals.every((w) => w.to === 'dao.near')).toBe(true);
    expect(ol.withdrawals.some((w) => w.to === 'ops.near' || w.to.startsWith('SoL'))).toBe(false);
    expect(ol.conf[SELL]).toBe(0n); expect(ol.conf[BUY]).toBe(0n);
    expect(state.runtime(0).stop_reason).toMatch(/cancelled/);
  });
  it('cancel while a swap is in flight waits for it, then returns its proceeds too', async () => {
    ol.hold = true; chain.add(makeTerms(clock));
    for (let i = 0; i < 6; i++) { await exec.tick(); clock.now += 3; } // funded + chunk submitted, held
    chain.cancel(0); await exec.tick(); // in flight: must not complete yet
    expect(state.runtime(0).phase).not.toBe('done');
    const c = state.chunks(0)[0]; ol.release(c.request_id!, BigInt(c.size));
    await run(done());
    expect(ol.conf[BUY] ?? 0n).toBe(0n); expect(ol.conf[SELL]).toBe(0n);
  });
});

describe('crash / resume', () => {
  it('a restarted executor never double-executes an in-flight chunk', async () => {
    ol.hold = true; chain.add(makeTerms(clock));
    for (let i = 0; i < 5; i++) { await exec.tick(); clock.now += 3; }
    expect(ol.swaps.length).toBe(1);
    const exec2 = new Executor({ outlayer: ol, chain, state, clock, rng: { below: (n) => (n > 1 ? 1 : 0) } }, { ...defaultConfig('dao.near'), itemBackoffS: 1 }); // "restart": same db
    await exec2.tick(); await exec2.tick();
    expect(ol.swaps.length).toBe(1);
    const c = state.chunks(0)[0]; ol.hold = false; ol.release(c.request_id!, BigInt(c.size));
    exec = exec2; await run(done());
    expect((await chain.getMandate(0))!.status).toBe('Completed');
    expect(new Set(ol.swaps.map((s) => s.idem)).size).toBe(ol.swaps.length);
  });
  it('crash between planning and submit: replay uses the same idempotency key (one swap)', async () => {
    chain.add(makeTerms(clock));
    for (let i = 0; i < 2; i++) { await exec.tick(); clock.now += 3; } // funded, then first chunk executes
    const first = state.chunks(0)[0];
    // simulate losing the DB write of status/request id: roll the row back to 'planned'
    state.patchChunk(0, 0, { status: 'planned', request_id: null, recorded: 0 });
    // and the chain forgot it too (not recorded yet)
    const m = chain.mandates.get(0)!; m.chunks = 0; m.sold = '0'; m.status = 'Funded';
    const before = ol.swaps.length;
    await exec.tick();
    expect(ol.swaps.length).toBe(before); // OutLayer replayed the same request, no second swap
    expect(state.chunk(0, 0)!.idem_key).toBe(first.idem_key);
  });
  it('record_chunk failure is retried and the swap is NOT repeated', async () => {
    chain.recordFails = 1; chain.add(makeTerms(clock)); await run(done());
    expect(ol.swaps.length).toBe(state.chunks(0).filter((c) => c.status === 'success').length);
    expect((await chain.getMandate(0))!.status).toBe('Completed');
  });
});

describe('tiers (F13)', () => {
  it('large tier with 2 of 3 approvals is refused and nothing is funded or traded', async () => {
    chain.approvals = { proposalId: 0, status: 'Approved', approvals: 2 }; chain.add(makeTerms(clock), 'large');
    for (let i = 0; i < 8; i++) { await exec.tick(); clock.now += 3; }
    expect(ol.swaps.length).toBe(0); expect(chain.calls).not.toContain('markFunded');
    expect(state.events(0).some((e) => e.kind === 'tier_refusal')).toBe(true);
    chain.approvals = { proposalId: 0, status: 'Approved', approvals: 3 }; // full council approves
    await run(done()); expect((await chain.getMandate(0))!.status).toBe('Completed');
  });
  it('requiredApprovals: small=1, mid=majority, large=all; low trust bumps small to mid', () => {
    expect(requiredApprovals('small', 5, 0)).toBe(1); expect(requiredApprovals('mid', 5, 0)).toBe(3); expect(requiredApprovals('large', 5, 0)).toBe(5);
    expect(requiredApprovals('small', 5, 0, { smallMinTrust: 2 })).toBe(3); expect(requiredApprovals('small', 5, 2, { smallMinTrust: 2 })).toBe(1);
  });
  it('proposal not yet Approved: waits', async () => {
    chain.approvals = { proposalId: 0, status: 'InProgress', approvals: 1 }; chain.add(makeTerms(clock));
    for (let i = 0; i < 4; i++) { await exec.tick(); clock.now += 3; }
    expect(ol.swaps.length).toBe(0); expect(state.runtime(0).phase).toBe('awaiting_approval');
  });
});

describe('verification', () => {
  it('terms that do not match the on-chain hash are refused', async () => {
    const m = chain.add(makeTerms(clock)); chain.mandates.get(0)!.terms_json = JSON.stringify({ ...JSON.parse(m.terms_json!), minPrice: '0.01' });
    await exec.tick();
    expect(state.runtime(0).phase).toBe('refused'); expect(state.runtime(0).stop_reason).toMatch(/hash/); expect(ol.swaps.length).toBe(0);
  });
  it('sealed terms: hash is a salted commitment, unavailable terms wait, delivered terms run and are revealed on completion', async () => {
    const terms = makeTerms(clock, { sealed: true }); const salt = 'a-long-random-salt-value';
    const h = commit(terms, salt);
    chain.add(terms, 'small', { terms_json: null, terms_hash: h });
    await exec.tick(); expect(state.runtime(0).phase).toBe('new');
    state.saveTerms(h, JSON.stringify({ salt, terms }), true);
    await run(done());
    const m = (await chain.getMandate(0))!; expect(m.status).toBe('Completed');
    const o = JSON.parse(m.revealed_terms!); expect(commit(o.terms, o.salt)).toBe(h);
  });
  it('payout in a non-buy token is refused (never silently skipped)', async () => {
    const t = makeTerms(clock, { payouts: [{ label: 'x', chain: 'near', address: 'x.near', token: SELL, amount: '1' }] });
    chain.add(t); await exec.tick(); expect(state.runtime(0).phase).toBe('refused');
  });
});

describe('payouts', () => {
  it('a failing payout is retried with backoff and eventually succeeds', async () => {
    ol.failWithdraws['SoLaddrAlice1111111111111111111111111111111'] = 2; chain.add(makeTerms(clock));
    await run(done(), 800);
    expect((await chain.getMandate(0))!.status).toBe('Completed');
    expect(state.items(0).find((i) => i.key === 'payout:0')!.attempts).toBe(2);
  });
  it('a permanently failing payout becomes needs_human and the mandate is NOT completed', async () => {
    ol.failWithdraws['SoLaddrAlice1111111111111111111111111111111'] = 99; chain.add(makeTerms(clock));
    await run(() => state.items(0).some((i) => i.status === 'needs_review'), 800);
    for (let i = 0; i < 5; i++) { await exec.tick(); clock.now += 3; }
    expect(state.items(0).find((i) => i.key === 'payout:0')!.status).toBe('needs_review');
    expect((await chain.getMandate(0))!.status).toBe('Settling');
    expect(state.events(0).some((e) => e.kind === 'needs_human')).toBe(true);
  });
  it('shortfall: fixed payouts larger than proceeds are capped and flagged, never over-paid', async () => {
    const t = makeTerms(clock, { payouts: [{ label: 'big', chain: 'base', address: '0x00000000000000000000000000000000000B0B01', token: BUY, amount: '999999999999' }], feeBps: 0 });
    chain.add(t); await run(done());
    const it = state.items(0).find((i) => i.key === 'payout:0')!; expect(it.note).toMatch(/shortfall/);
    expect(ol.conf[BUY]).toBe(0n);
  });
});

describe('funding', () => {
  it('waits for funds, then shields public balance and starts', async () => {
    ol.conf[SELL] = 0n; chain.add(makeTerms(clock));
    for (let i = 0; i < 3; i++) { await exec.tick(); clock.now += 3; }
    expect(chain.calls).not.toContain('markFunded');
    ol.pub[SELL] = 5n * NEAR1; await run(done());
    expect((await chain.getMandate(0))!.status).toBe('Completed');
  });
  it('wallet policy denial stops the mandate from trading and is surfaced', async () => {
    chain.add(makeTerms(clock)); ol.throwOnSwap = new OutLayerError('policy_denied', 403, { error: 'policy_denied' });
    for (let i = 0; i < 6; i++) { await exec.tick(); clock.now += 3; }
    expect(state.runtime(0).stop_reason).toMatch(/policy_denied/); expect(ol.swaps.length).toBe(0);
  });
  it('rate limit pauses until retry_after', async () => {
    chain.add(makeTerms(clock)); ol.throwOnSwap = new OutLayerError('operation_limit_reached', 429, {}, 120);
    for (let i = 0; i < 4; i++) { await exec.tick(); clock.now += 3; }
    expect(state.runtime(0).next_at).toBeGreaterThan(clock.now);
  });
});

describe('guards + redteam + state + auth', () => {
  const t = () => makeTerms(new FakeClock());
  it('guards: over budget, wrong token, unlisted destination', () => {
    expect(() => assertSwap(t(), 10n, { tokenIn: SELL, tokenOut: BUY, amountIn: 11n })).toThrow(GuardError);
    expect(() => assertSwap(t(), 10n, { tokenIn: SELL, tokenOut: 'nep141:evil.near', amountIn: 1n })).toThrow(/buy token/);
    expect(() => assertDestination(t(), 'near', 'attacker.near')).toThrow(/not in the mandate/);
    expect(() => assertDestination(t(), 'near', 'DAO.near')).not.toThrow();
  });
  it('redteam: all five attacks are really blocked and name the layer', async () => {
    chain.add(makeTerms(clock)); await exec.tick(); await exec.tick(); // funded
    const deps = { chain, outlayer: ol, termsFor: async (m: any) => JSON.parse(m.terms_json), nowS: () => clock.now };
    for (const a of ['over_budget', 'wrong_token', 'after_expiry', 'unlisted_payout', 'non_dao_create']) {
      const r = await runAttack(a, undefined, deps as any);
      expect(r.blocked, `${a}: ${r.error}`).toBe(true); expect(r.layer).toMatch(/^(A|B)/); expect(r.error.length).toBeGreaterThan(5);
    }
  });
  it('redteam reports blocked:false when the system would accept (honest)', async () => {
    chain.add(makeTerms(clock)); chain.attackCreateAsAgent = async () => ({});
    const r = await runAttack('non_dao_create', undefined, { chain, outlayer: ol, termsFor: async () => null, nowS: () => 0 } as any);
    expect(r.blocked).toBe(false);
  });
  it('sealed terms store: AES-GCM round trip, tamper and wrong key fail', () => {
    state.saveTerms('h1', '{"secret":1}', true);
    expect(state.loadTerms('h1')).toBe('{"secret":1}');
    const raw = state.db.prepare('SELECT body FROM terms WHERE terms_hash=?').get('h1') as any; expect(Buffer.from(raw.body).toString()).not.toContain('secret');
    const other = new State(':memory:', randomBytes(32)); other.db.exec('CREATE TABLE IF NOT EXISTS x(a)');
    state.db.prepare('UPDATE terms SET body=? WHERE terms_hash=?').run(Buffer.from('tampered-bytes!'), 'h1'); expect(() => state.loadTerms('h1')).toThrow();
  });
  it('NEP-413: valid signature verifies, altered message fails', () => {
    const sk = ed25519.utils.randomSecretKey(); const pk = ed25519.getPublicKey(sk);
    const nonce = randomBytes(32); const message = `quiet-treasury:terms:0:${Date.now()}`;
    const sig = ed25519.sign(nep413Hash(message, nonce, 'quiet-treasury.worker'), sk);
    const b58 = (b: Uint8Array) => { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = BigInt('0x' + Buffer.from(b).toString('hex')), s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x === 0) s = '1' + s; else break; } return s; };
    const h = { accountId: 'a.near', publicKey: 'ed25519:' + b58(pk), signature: Buffer.from(sig).toString('base64'), message, nonce: nonce.toString('base64'), recipient: 'quiet-treasury.worker' };
    expect(verifySignature(h)).toBe(true);
    expect(verifySignature({ ...h, message: message + 'x' })).toBe(false);
  });
});
