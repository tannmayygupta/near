import { describe, it, expect } from 'vitest';
import { OutLayerClient, OutLayerError, classify } from '../src/near/outlayer';
import { dryQuote, quoteToSample, IntentsError } from '../src/near/intents';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const mk = (handler: (url: string, init: any) => Response | Promise<Response>) =>
  new OutLayerClient({ apiKey: 'wk_test', baseUrl: 'https://x', fetch: (async (u: any, i: any) => handler(String(u), i)) as any });

describe('OutLayer client', () => {
  it('sends bearer + idempotency key on money-moving calls', async () => {
    let seen: any;
    const c = mk((u, i) => { seen = { u, i }; return json(200, { request_id: 'r1', status: 'pending_deposit' }); });
    await c.confidentialSwap({ token_in: 'a', token_out: 'b', amount_in: '1' }, 'idem-1');
    expect(seen.u).toBe('https://x/wallet/v1/confidential/swap');
    expect(seen.i.headers.authorization).toBe('Bearer wk_test');
    expect(seen.i.headers['x-idempotency-key']).toBe('idem-1');
  });
  it('auto-generates an idempotency key', async () => {
    let h: any;
    const c = mk((_u, i) => { h = i.headers; return json(200, { request_id: 'r', status: 'pending_deposit' }); });
    await c.confidentialWithdraw({ chain: 'solana', to: 'x', amount: '1', token: 't' });
    expect(h['x-idempotency-key']).toMatch(/[0-9a-f-]{36}/);
  });
  it('maps documented errors to typed kinds', async () => {
    const cases: Array<[number, any, string]> = [
      [403, { error: 'policy_denied' }, 'policy_denied'],
      [403, { error: 'wallet_frozen' }, 'wallet_frozen'],
      [429, { error: 'operation_limit_reached', retry_after_seconds: 42 }, 'operation_limit_reached'],
      [503, { error: 'confidential_unavailable' }, 'confidential_unavailable'],
      [401, {}, 'unauthorized'], [400, { error: 'bad_request' }, 'bad_request'], [502, {}, 'upstream'],
    ];
    for (const [s, b, kind] of cases) {
      const c = mk(() => json(s, b));
      await expect(c.confidentialBalance()).rejects.toMatchObject({ kind });
    }
    expect(classify(429, { retry_after_seconds: 42 }).retryAfterS).toBe(42);
  });
  it('fails closed with unauthorized when no key is set', async () => {
    const c = new OutLayerClient({ baseUrl: 'https://x', fetch: (async () => json(200, {})) as any, apiKey: '' });
    await expect(c.address()).rejects.toBeInstanceOf(OutLayerError);
  });
  it('polls through pending_deposit/processing to a terminal status', async () => {
    const seq = ['pending_deposit', 'processing', 'success'];
    let n = 0, slept = 0;
    const c = mk(() => json(200, { status: seq[n++], result: { amount_out: '5' } }));
    const rec = await c.waitForRequest('r1', { sleep: async () => { slept++; } });
    expect(rec.status).toBe('success');
    expect(slept).toBe(2);
  });
  it('treats refunded and failed as terminal, times out otherwise without retrying the action', async () => {
    expect((await mk(() => json(200, { status: 'refunded' })).waitForRequest('r', { sleep: async () => {} })).status).toBe('refunded');
    await expect(mk(() => json(200, { status: 'processing' })).waitForRequest('r', { intervalMs: 1000, timeoutMs: 2000, sleep: async () => {} })).rejects.toThrow(/do NOT retry/);
  });
  it('register needs no auth', async () => {
    let h: any;
    const c = new OutLayerClient({ baseUrl: 'https://x', apiKey: '', fetch: (async (_u: any, i: any) => { h = i.headers; return json(200, { api_key: 'wk_1', wallet_id: 'w', near_account_id: 'n' }); }) as any });
    await c.register();
    expect(h.authorization).toBeUndefined();
  });
});

describe('1Click dry quote', () => {
  const q = { quote: { amountIn: '1000000000000000000000000', amountOut: '3700000', minAmountOut: '3660000', amountInUsd: '3.7', amountOutUsd: '3.7', timeEstimate: 12 } };
  it('sends dry:true and no auth, tags source api', async () => {
    let body: any, headers: any;
    const f = (async (_u: any, i: any) => { body = JSON.parse(i.body); headers = i.headers; return json(201, q); }) as any;
    const r = await dryQuote({ originAsset: 'nep141:wrap.near', destinationAsset: 'nep141:u', amount: '1', recipient: 'r', refundTo: 'r', fetch: f, nowS: () => 1000 });
    expect(body.dry).toBe(true);
    expect(headers.authorization).toBeUndefined();
    expect(r.source).toBe('api');
    const s = quoteToSample(r, 'nep141:wrap.near', 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1');
    expect(s.price).toBeCloseTo(3.7, 6);
    expect(s.source).toBe('api');
  });
  it('surfaces upstream failures', async () => {
    const f = (async () => json(400, { message: 'bad' })) as any;
    await expect(dryQuote({ originAsset: 'a', destinationAsset: 'b', amount: '1', recipient: 'r', refundTo: 'r', fetch: f })).rejects.toBeInstanceOf(IntentsError);
  });
});
