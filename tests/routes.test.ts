import { describe, it, expect } from 'vitest';
import { buildDryQuoteBody, dryQuoteFull, IntentsError } from '../src/near/intents';
import { planRoutes, validateAddress, MAINNET_ASSETS, type RouteInput } from '../src/near/routes';
import { OutLayerClient } from '../src/near/outlayer';
import { LiveDryRunOutLayer, DryRunBlocked, dryRunDecision } from '../worker/adapters/live-dryrun';
import { MandateTerms, MAINNET_TOKENS } from '../src/engine/schema';
import type { Rng } from '../src/engine/planner';

const W = MAINNET_ASSETS.wNEAR.id;
const USDC = MAINNET_ASSETS.USDC;
const IMPLICIT = '36842e2f73d0b7b2f2af6e0d94a7a997398c2c09d9cf09ca3fa23b5426fccf88';
const SOL = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const EVM = '0x1111111111111111111111111111111111111111';

type Call = { url: string; method: string; body: any; headers: Record<string, string> };
/** fake 1Click: answers every dry quote at `rate` (out = in * rate in smallest units), records every call */
function fake1Click(opts: { rate?: number; failFor?: (b: any) => { status: number; text: string; headers?: Record<string, string> } | null; calls?: Call[] } = {}) {
  const calls: Call[] = opts.calls ?? [];
  const f = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method: String(init?.method ?? 'GET'), body, headers: init?.headers ?? {} });
    const fail = opts.failFor?.(body);
    if (fail) return new Response(fail.text, { status: fail.status, headers: fail.headers });
    const out = BigInt(Math.floor(Number(body.amount) * (opts.rate ?? 1)));
    return new Response(JSON.stringify({ quote: { amountIn: body.amount, amountInFormatted: 'x', amountOut: out.toString(), amountOutFormatted: 'y', minAmountOut: ((out * 99n) / 100n).toString(), minAmountIn: body.amount, timeEstimate: 20, refundFee: '4190', withdrawFee: '5300', deadline: body.deadline } }), { status: 201 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const input: RouteInput = {
  sellAmount: (5n * 10n ** 24n).toString(), treasuryAccount: IMPLICIT,
  payouts: [
    { label: 'alice', chain: 'solana', address: SOL, percent: 25 },
    { label: 'bob', chain: 'base', address: EVM, percent: 50 },
    { label: 'erin', chain: 'near', address: 'contributor.near', percent: 25 },
  ],
};

describe('1Click dry quote', () => {
  it('body is ALWAYS dry:true with the documented fields', () => {
    const b = buildDryQuoteBody({ originAsset: W, destinationAsset: USDC.near, amount: '1', recipient: IMPLICIT, refundTo: IMPLICIT, nowS: () => 1000 });
    expect(b.dry).toBe(true);
    expect(b).toMatchObject({ swapType: 'EXACT_INPUT', depositType: 'ORIGIN_CHAIN', recipientType: 'DESTINATION_CHAIN', refundType: 'ORIGIN_CHAIN' });
    expect(b.deadline).toBe(new Date(1600 * 1000).toISOString());
  });
  it('retries 429 honouring retry-after, then succeeds', async () => {
    let n = 0; const sleeps: number[] = [];
    const { f } = fake1Click({ failFor: () => (n++ < 2 ? { status: 429, text: 'slow down', headers: { 'retry-after': '2' } } : null) });
    const q = await dryQuoteFull({ originAsset: W, destinationAsset: USDC.near, amount: '1000', recipient: IMPLICIT, refundTo: IMPLICIT, fetch: f, sleep: async (ms) => { sleeps.push(ms); } });
    expect(q.amountOut).toBe('1000'); expect(sleeps).toEqual([2000, 2000]);
  });
  it('does not retry a 400 and keeps the API error text verbatim', async () => {
    const { f, calls } = fake1Click({ failFor: () => ({ status: 400, text: '{"message":"Amount is too low for bridge, try at least 1000000"}' }) });
    await expect(dryQuoteFull({ originAsset: W, destinationAsset: USDC.near, amount: '1', recipient: IMPLICIT, refundTo: IMPLICIT, fetch: f, sleep: async () => {} }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('Amount is too low for bridge') });
    expect(calls).toHaveLength(1);
  });
  it('gives up after the retry budget on persistent 5xx', async () => {
    const { f, calls } = fake1Click({ failFor: () => ({ status: 503, text: 'down' }) });
    await expect(dryQuoteFull({ originAsset: W, destinationAsset: USDC.near, amount: '1', recipient: IMPLICIT, refundTo: IMPLICIT, fetch: f, sleep: async () => {}, retries: 2 })).rejects.toBeInstanceOf(IntentsError);
    expect(calls).toHaveLength(3);
  });
});

describe('address validation', () => {
  it('accepts well-formed addresses per chain', () => {
    expect(validateAddress('solana', SOL)).toBeNull();
    expect(validateAddress('base', EVM)).toBeNull(); expect(validateAddress('arbitrum', EVM)).toBeNull(); expect(validateAddress('ethereum', EVM)).toBeNull();
    expect(validateAddress('near', 'alice.near')).toBeNull(); expect(validateAddress('near', IMPLICIT)).toBeNull();
  });
  it('rejects malformed ones', () => {
    expect(validateAddress('solana', EVM)).toMatch(/base58/);
    expect(validateAddress('base', SOL)).toMatch(/0x/);
    expect(validateAddress('base', '0x123')).toMatch(/0x/);
    expect(validateAddress('near', 'Alice.NEAR')).toMatch(/NEAR/);
    expect(validateAddress('near', '')).toMatch(/NEAR/);
  });
});

describe('route planner', () => {
  it('quotes the sell leg and every cross-chain payout leg with the right assets, amounts and addresses', async () => {
    const { f, calls } = fake1Click({ rate: 3.3e-18 }); // wNEAR(24 dec) -> USDC(6 dec) ~ 3.3: use a rate that maps 5e24 -> 16.5e6
    const plan = await planRoutes(input, { fetch: f, sleep: async () => {}, nowS: () => 1_800_000_000 });
    const [sell, alice, bob, erin] = plan.legs;
    expect(sell.quote?.amountOut).toBe(String(Math.floor(5e24 * 3.3e-18)));
    expect(calls[0].body).toMatchObject({ originAsset: W, destinationAsset: USDC.near, recipient: IMPLICIT, refundTo: IMPLICIT, amount: input.sellAmount, dry: true });
    // payout amounts = percent of the QUOTED sell proceeds
    const proceeds = BigInt(sell.quote!.amountOut);
    expect(alice.amountIn).toBe(((proceeds * 2500n) / 10000n).toString());
    expect(bob.amountIn).toBe(((proceeds * 5000n) / 10000n).toString());
    expect(calls[1].body).toMatchObject({ originAsset: USDC.near, destinationAsset: USDC.solana, recipient: SOL, refundTo: IMPLICIT });
    expect(calls[2].body).toMatchObject({ originAsset: USDC.near, destinationAsset: USDC.base, recipient: EVM });
    // USDC already on NEAR: plain withdraw, no quote requested
    expect(erin.needsSwap).toBe(false); expect(erin.quote).toBeUndefined(); expect(erin.skipped).toMatch(/plain Intents withdraw/);
    expect(plan.summary).toEqual({ quoted: 3, errors: 0, skipped: 1 });
    expect(plan.legs.every((l) => l.source === 'api')).toBe(true);
  });
  it('NEVER calls anything except POST /v0/quote with dry:true (cannot move money)', async () => {
    const { f, calls } = fake1Click({ rate: 1 });
    await planRoutes(input, { fetch: f, sleep: async () => {} });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) { expect(c.method).toBe('POST'); expect(new URL(c.url).pathname).toBe('/v0/quote'); expect(c.body.dry).toBe(true); }
  });
  it('records an API error verbatim and skips the percent legs that depend on it', async () => {
    const { f, calls } = fake1Click({ failFor: () => ({ status: 400, text: '{"message":"Internal server error"}' }) });
    const plan = await planRoutes(input, { fetch: f, sleep: async () => {} });
    expect(plan.legs[0].error).toEqual({ status: 400, message: expect.stringContaining('Internal server error') });
    expect(plan.legs.slice(1).every((l) => l.skipped && !l.quote)).toBe(true);
    expect(calls).toHaveLength(1);
  });
  it('skips (and never quotes) a payout with a malformed address, other legs still quote', async () => {
    const { f, calls } = fake1Click({ rate: 1 });
    const bad: RouteInput = { ...input, payouts: [{ label: 'x', chain: 'solana', address: EVM, percent: 10 }, { label: 'y', chain: 'base', address: EVM, percent: 10 }] };
    const plan = await planRoutes(bad, { fetch: f, sleep: async () => {} });
    expect(plan.legs[1].skipped).toMatch(/base58/); expect(plan.legs[2].quote).toBeDefined();
    expect(calls.map((c) => c.body.destinationAsset)).toEqual([USDC.near, USDC.base]);
  });
  it('fixed-amount payouts work without a sell quote', async () => {
    const { f } = fake1Click({ rate: 1, failFor: (b) => (b.originAsset === W ? { status: 400, text: 'x' } : null) });
    const plan = await planRoutes({ ...input, payouts: [{ label: 'a', chain: 'ethereum', address: EVM, amount: '2000000' }] }, { fetch: f, sleep: async () => {} });
    expect(plan.legs[1].quote?.amountIn).toBe('2000000');
  });
});

describe('OutLayerClient request shapes match the OutLayer docs (agent-custody references)', () => {
  const mk = () => {
    const calls: Call[] = [];
    const f = (async (url: any, init: any) => { calls.push({ url: String(url), method: String(init?.method ?? 'GET'), body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers ?? {} }); return new Response(JSON.stringify({ request_id: 'r1', status: 'pending_deposit' }), { status: 200 }); }) as unknown as typeof fetch;
    return { c: new OutLayerClient({ apiKey: 'wk_test', fetch: f }), calls };
  };
  const H = { authorization: 'Bearer wk_test', 'content-type': 'application/json' };
  it('confidential swap: POST /wallet/v1/confidential/swap, exact body, auth + idempotency headers', async () => {
    const { c, calls } = mk();
    await c.confidentialSwap({ token_in: W, token_out: USDC.near, amount_in: '1', min_amount_out: '2' }, 'idem-1');
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.outlayer.ai/wallet/v1/confidential/swap', body: { token_in: W, token_out: USDC.near, amount_in: '1', min_amount_out: '2' }, headers: { ...H, 'x-idempotency-key': 'idem-1' } });
  });
  it('confidential withdraw (+dry-run), shield, unshield and cross-chain deposit: paths and bodies', async () => {
    const { c, calls } = mk();
    await c.confidentialWithdraw({ chain: 'solana', to: SOL, amount: '500000', token: USDC.solana }, 'i2');
    await c.confidentialWithdrawDryRun({ chain: 'solana', to: SOL, amount: '500000', token: USDC.solana });
    await c.confidentialShield({ token: W, amount: '1' }, 'i3');
    await c.confidentialUnshield({ token: W, amount: '1' }, 'i4');
    await c.confidentialDepositCrossChain({ source_asset: USDC.solana, amount: '500000' });
    expect(calls.map((x) => `${x.method} ${x.url.replace('https://api.outlayer.ai', '')}`)).toEqual([
      'POST /wallet/v1/confidential/withdraw', 'POST /wallet/v1/confidential/withdraw/dry-run', 'POST /wallet/v1/confidential/shield', 'POST /wallet/v1/confidential/unshield', 'POST /wallet/v1/confidential/deposit/cross-chain',
    ]);
    expect(calls[0].body).toEqual({ chain: 'solana', to: SOL, amount: '500000', token: USDC.solana });
    expect(calls[2].body).toEqual({ token: W, amount: '1' });
    expect(calls[4].body).toEqual({ source_asset: USDC.solana, amount: '500000' });
    expect(calls[0].headers['x-idempotency-key']).toBe('i2'); expect(calls[1].headers['x-idempotency-key']).toBeUndefined(); expect(calls[4].headers['x-idempotency-key']).toBeUndefined();
  });
  it('public intents swap/withdraw (async cross-chain per docs) and reads', async () => {
    const { c, calls } = mk();
    await c.intentsSwap({ token_in: W, token_out: USDC.near, amount_in: '1', min_amount_out: '2' }, 'i5');
    await c.intentsWithdraw({ chain: 'ethereum', to: EVM, amount: '100000000', token: USDC.ethereum, async: true }, 'i6');
    await c.intentsBalance(W); await c.confidentialBalance(W); await c.request('abc');
    expect(calls[0].url).toBe('https://api.outlayer.ai/wallet/v1/intents/swap');
    expect(calls[1]).toMatchObject({ url: 'https://api.outlayer.ai/wallet/v1/intents/withdraw', body: { chain: 'ethereum', to: EVM, amount: '100000000', token: USDC.ethereum, async: true } });
    expect(calls[2]).toMatchObject({ method: 'GET', url: `https://api.outlayer.ai/wallet/v1/balance?token=${encodeURIComponent(W)}&source=intents` });
    expect(calls[3].url).toBe(`https://api.outlayer.ai/wallet/v1/confidential/balance?token=${encodeURIComponent(W)}`);
    expect(calls[4].url).toBe('https://api.outlayer.ai/wallet/v1/requests/abc');
  });
  it('every money-moving call carries an idempotency key even when the caller gives none', async () => {
    const { c, calls } = mk();
    await c.confidentialSwap({ token_in: W, token_out: USDC.near, amount_in: '1' }); await c.confidentialWithdraw({ chain: 'base', to: EVM, amount: '1', token: USDC.base }); await c.intentsWithdraw({ to: EVM, amount: '1' });
    for (const x of calls) expect(x.headers['x-idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('live-dryrun adapter: the live decision path with every money-moving call blocked', () => {
  const terms = MandateTerms.parse({
    dao: 'dao.near', treasurer: 'alice.near', sellToken: W, buyToken: USDC.near, maxSellAmount: (5n * 10n ** 24n).toString(), minPrice: '3.0',
    startTs: 1_800_000_000, endTs: 1_800_000_000 + 86400, chunkMin: (10n ** 24n).toString(), chunkMax: (10n ** 24n).toString(), intervalMinS: 600, intervalMaxS: 600,
    payouts: [], feeBps: 0, returnTo: 'dao.near', sealed: false,
  });
  const rng: Rng = { below: () => 0 };
  const FORBIDDEN = /\/wallet\/v1\/|\/v0\/(deposit|generate-intent|submit-intent|orders)/;

  it('a quote above the floor produces the exact OutLayer request that WOULD be sent, and sends nothing', async () => {
    const { f, calls } = fake1Click({ rate: 3.3e-18 }); // 1 wNEAR -> 3.3 USDC (floor 3.0)
    const ad = new LiveDryRunOutLayer({ recipient: IMPLICIT, fetch: f, sleep: async () => {} });
    const d = await dryRunDecision(terms, { adapter: ad, nowS: 1_800_000_100, remaining: BigInt(terms.maxSellAmount), idem: '7:0', rng });
    expect(d.floorOk).toBe(true);
    expect(d.wouldSend).toMatchObject({ method: 'POST', url: 'https://api.outlayer.ai/wallet/v1/confidential/swap', body: { token_in: W, token_out: USDC.near, amount_in: (10n ** 24n).toString(), min_amount_out: '3000000' }, headers: { 'x-idempotency-key': '7:0', authorization: 'Bearer wk_***' } });
    // the only network traffic is the public DRY quote
    for (const c of calls) { expect(new URL(c.url).pathname).toBe('/v0/quote'); expect(c.body.dry).toBe(true); expect(c.url).not.toMatch(FORBIDDEN); }
    expect(ad.captured).toHaveLength(1);
  });
  it('a quote below the floor is refused: no request is even built', async () => {
    const { f } = fake1Click({ rate: 2.5e-18 }); // 2.5 USDC < 3.0 floor
    const ad = new LiveDryRunOutLayer({ recipient: IMPLICIT, fetch: f, sleep: async () => {} });
    const d = await dryRunDecision(terms, { adapter: ad, nowS: 1_800_000_100, remaining: BigInt(terms.maxSellAmount), idem: '7:0', rng });
    expect(d.floorOk).toBe(false); expect(d.wouldSend).toBeUndefined(); expect(ad.captured).toHaveLength(0);
  });
  it('waits before the window opens and reports done after it closes', async () => {
    const { f } = fake1Click();
    const ad = new LiveDryRunOutLayer({ recipient: IMPLICIT, fetch: f });
    expect((await dryRunDecision(terms, { adapter: ad, nowS: 1_700_000_000, remaining: 1n, idem: 'x', rng })).plan.kind).toBe('wait');
    expect((await dryRunDecision(terms, { adapter: ad, nowS: 1_900_000_000, remaining: 1n, idem: 'x', rng })).plan.kind).toBe('done');
  });
  it('every money-moving port method throws DryRunBlocked and never uses the network fetch', async () => {
    const { f, calls } = fake1Click();
    const ad = new LiveDryRunOutLayer({ recipient: IMPLICIT, fetch: f });
    await expect(ad.confidentialSwap({ token_in: W, token_out: USDC.near, amount_in: '1' }, 'k')).rejects.toBeInstanceOf(DryRunBlocked);
    await expect(ad.confidentialWithdraw({ chain: 'base', to: EVM, amount: '1', token: USDC.base }, 'k')).rejects.toBeInstanceOf(DryRunBlocked);
    await expect(ad.confidentialShield({ token: W, amount: '1' }, 'k')).rejects.toBeInstanceOf(DryRunBlocked);
    expect(calls).toHaveLength(0); // nothing left the process
    expect(ad.captured.map((c) => new URL(c.url).pathname)).toEqual(['/wallet/v1/confidential/swap', '/wallet/v1/confidential/withdraw', '/wallet/v1/confidential/shield']);
    expect(JSON.stringify(ad.captured)).not.toMatch(/wk_dryrun_placeholder/); // credential never appears in logs
    expect(await ad.intentsBalance()).toEqual({ balance: '0' });
    await expect(ad.request()).rejects.toThrow(/DRY-RUN/);
  });
  it('mainnet token profile is what the dry-run path uses', () => { expect(Object.keys(MAINNET_TOKENS)).toContain(W); });
});
