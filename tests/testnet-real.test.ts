// Tests for the testnet-real work: token profiles, honest token aliases, AMM math against real Ref numbers, one-shot baseline in reports.
import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { BOUNDS, MandateTerms, tokenProfile } from '../src/engine/schema';
import { ParseError, parseIntent } from '../src/engine/parser';
import { cpmmOut } from '../src/engine/benchmark';
import { Executor, defaultConfig, srcOf } from '../worker/executor';
import { State } from '../worker/state';
import { isTxHash } from '../worker/adapters/ref-testnet';
import { FakeChain, FakeClock, FakeOutLayer, NEAR1, SELL, makeTerms } from './worker/fakes';

const WRAP = 'nep141:wrap.testnet', USDT = 'nep141:usdt.fakes.testnet';
afterEach(() => { delete process.env.TOKEN_PROFILE; });
const draft = (sell: string, buy: string) => JSON.stringify({ sellToken: sell, buyToken: buy, maxSellAmount: '1', minPrice: '3', durationHours: 1, chunkMin: '0.1', chunkMax: '0.2', intervalMinS: 5, intervalMaxS: 8, payouts: [] });
const ctx = (llm: (s: string, u: string) => Promise<string>) => ({ dao: 'dao.testnet', treasurer: 't.testnet', nowS: 1_800_000_000, llm, maxRepairs: 0 });

describe('token profiles', () => {
  it('defaults to mainnet tokens and rejects testnet token ids', () => {
    expect(tokenProfile()).toBe('mainnet');
    expect(Object.keys(BOUNDS.allowedTokens)).toContain('nep141:wrap.near');
    expect(() => MandateTerms.parse({ ...makeTerms(new FakeClock()), sellToken: WRAP })).toThrow();
  });
  it('TOKEN_PROFILE=testnet switches to wNEAR / USDT.e and rejects mainnet ids', () => {
    process.env.TOKEN_PROFILE = 'testnet';
    expect(Object.keys(BOUNDS.allowedTokens).sort()).toEqual([USDT, WRAP]);
    expect(BOUNDS.allowedTokens[USDT]).toEqual({ symbol: 'USDT.e', decimals: 6 });
    expect(() => makeTerms(new FakeClock())).toThrow(); // mainnet ids not allowed on the testnet profile
  });
  it('NEAR_NETWORK=testnet also selects the testnet profile', () => {
    const prev = process.env.NEAR_NETWORK; process.env.NEAR_NETWORK = 'testnet';
    try { expect(tokenProfile()).toBe('testnet'); } finally { if (prev === undefined) delete process.env.NEAR_NETWORK; else process.env.NEAR_NETWORK = prev; }
  });
});

describe('parser aliases (honest only)', () => {
  it('testnet: NEAR -> wNEAR and USDT -> USDT.e', async () => {
    process.env.TOKEN_PROFILE = 'testnet';
    const r = await parseIntent('Sell 1 NEAR for USDT over one hour please', ctx(async () => draft('NEAR', 'USDT')));
    expect(r.terms.sellToken).toBe(WRAP); expect(r.terms.buyToken).toBe(USDT);
  });
  it('testnet: USDC is never silently mapped to USDT.e', async () => {
    process.env.TOKEN_PROFILE = 'testnet';
    await expect(parseIntent('Sell 1 NEAR for USDC over one hour please', ctx(async () => draft('wNEAR', 'USDC')))).rejects.toMatchObject({ code: 'UNKNOWN_TOKEN' });
  });
  it('mainnet: USDT.e does not exist', async () => {
    await expect(parseIntent('Sell 1 NEAR for USDT over one hour please', ctx(async () => draft('wNEAR', 'USDT')))).rejects.toBeInstanceOf(ParseError);
  });
});

describe('cpmmOut matches the real Ref Finance testnet pool #57', () => {
  // reserves and results observed from the live pool in the same probe (get_pool + get_return)
  const rIn = 1644463568647335802780375n, rOut = 12200855n;
  it('0.05 NEAR -> 358972 USDT.e units', () => expect(cpmmOut(rIn, rOut, 5n * 10n ** 22n, 30)).toBe(358972n));
  it('0.5 NEAR -> 2838184 USDT.e units (visible price impact)', () => expect(cpmmOut(rIn, rOut, 5n * 10n ** 23n, 30)).toBe(2838184n));
  it('splitting a trade never beats one swap in a constant-product pool (path independence minus fees)', () => {
    const one = cpmmOut(rIn, rOut, 5n * 10n ** 23n, 30);
    let a = rIn, b = rOut, got = 0n;
    for (let i = 0; i < 10; i++) { const o = cpmmOut(a, b, 5n * 10n ** 22n, 30); got += o; a += 5n * 10n ** 22n; b -= o; }
    expect(got <= one).toBe(true);
  });
  it('zero/invalid inputs give 0', () => { expect(cpmmOut(0n, 5n, 5n, 30)).toBe(0n); expect(cpmmOut(5n, 5n, 0n, 30)).toBe(0n); });
});

describe('source tags', () => {
  it('a NEAR tx hash is "chain", sim- is "simulated", anything else "api"', () => {
    expect(srcOf('3uZBubvF8sqL38TWjG4UrLpKcdKu9hkZ56gFGbN2UxGm')).toBe('chain');
    expect(srcOf('sim-4')).toBe('simulated');
    expect(srcOf('req-12')).toBe('api');
    expect(srcOf(null)).toBe('api');
    expect(isTxHash('3uZBubvF8sqL38TWjG4UrLpKcdKu9hkZ56gFGbN2UxGm')).toBe(true);
    expect(isTxHash('not a hash')).toBe(false);
  });
});

describe('one-shot baseline in the settlement report', () => {
  it('stores the pool snapshot before the first chunk and reports chunked vs one-shot honestly', async () => {
    const clock = new FakeClock(), chain = new FakeChain(clock), ol = new FakeOutLayer(), state = new State(':memory:', randomBytes(32));
    ol.conf[SELL] = 5n * NEAR1;
    let snaps = 0;
    const snap = { poolId: 57, reserveIn: (100n * NEAR1).toString(), reserveOut: '700000000', feeBps: 30, ts: clock.now };
    const exec = new Executor({ outlayer: ol, chain, state, clock, rng: { below: (n) => (n > 1 ? 1 : 0) }, poolSnapshot: async () => { snaps++; return snap; } }, { ...defaultConfig('dao.near'), itemBackoffS: 1 });
    chain.add(makeTerms(clock));
    for (let i = 0; i < 400 && state.runtime(0).phase !== 'done'; i++) { await exec.tick(); clock.now += 3; }
    expect(snaps).toBe(1); // exactly one baseline per mandate
    const r = state.report(0);
    expect(r.oneShot).toBeTruthy();
    expect(r.oneShot.poolId).toBe(57);
    const sold = 5n * NEAR1;
    expect(r.oneShot.amountOut).toBe(cpmmOut(100n * NEAR1, 700000000n, sold, 30).toString());
    const got = r.fills.reduce((s: bigint, f: any) => s + BigInt(f.amountOut), 0n);
    expect(r.oneShot.chunkedVsOneShotBps).toBe(Number(((got - BigInt(r.oneShot.amountOut)) * 10000n) / BigInt(r.oneShot.amountOut)));
    expect(r.oneShot.source).toBe('chain');
    // fake request ids (req-N) are not tx hashes, so the fills stay "api" here (the real adapter's tx-hash ids become "chain")
    expect(r.fills.every((f: any) => f.source === 'api')).toBe(true);
  });
  it('no snapshot dependency -> no oneShot field (mainnet/simulated behaviour unchanged)', async () => {
    const clock = new FakeClock(), chain = new FakeChain(clock), ol = new FakeOutLayer(), state = new State(':memory:', randomBytes(32));
    ol.conf[SELL] = 5n * NEAR1;
    const exec = new Executor({ outlayer: ol, chain, state, clock, rng: { below: (n) => (n > 1 ? 1 : 0) } }, { ...defaultConfig('dao.near'), itemBackoffS: 1 });
    chain.add(makeTerms(clock));
    for (let i = 0; i < 400 && state.runtime(0).phase !== 'done'; i++) { await exec.tick(); clock.now += 3; }
    expect(state.report(0).oneShot).toBeUndefined();
  });
});
