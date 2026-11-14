import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { KeyPair, baseDecode } from 'near-api-js';
import { buildDryQuoteBody, dryQuote, dryQuoteFull, IntentsError } from '../src/near/intents';
import {
  LiveGuardError, SPEND_CAP_YOCTO, assertQuoteSane, buildLiveQuoteBody, checkSettleGuards, getStatus, implicitAccountId, liveQuote, parseNearAmount, parseStatus,
  quoteValidUntilS, submitDeposit, waitForStatus, type LiveQuote,
} from '../src/near/intents-live';
import { GAS_FLOAT, ORIGIN_ASSET, DEST_ASSET, USDC, WRAP, runSettlement, type Journal, type SettlePort } from '../src/near/intents-settle';

const W = ORIGIN_ASSET;
const IMPLICIT = '36842e2f73d0b7b2f2af6e0d94a7a997398c2c09d9cf09ca3fa23b5426fccf88';
const DEPOSIT = '5bf9af59c3043f08855f43de6f724ea4aaec57f1ba0d00dfbc5a80f4fc610f04';
const HALF = (5n * 10n ** 23n).toString(); // 0.5 wNEAR
const NOW = 1_800_000_000;

type Call = { url: string; method: string; body: any; headers: Record<string, string> };

/** The real response shape of POST /v0/quote (dry:false), recorded 2026-11-14. */
const quoteJson = (body: any, over: Record<string, unknown> = {}) => ({
  correlationId: 'f4d51444-1b80-4ac3-a4c3-92978cb949f1', timestamp: '2027-01-15T08:00:00.000Z', signature: 'sig-from-1click', quoteRequest: body,
  quote: {
    depositAddress: DEPOSIT, amountIn: body.amount, amountInFormatted: '0.5', amountInUsd: '1.660000000000', amountOut: '1629769', amountOutFormatted: '1.629769', amountOutUsd: '1.629165985470',
    minAmountOut: '1613471', deadline: new Date((NOW + 3 * 86400) * 1000).toISOString(), timeWhenInactive: new Date((NOW + 3 * 86400) * 1000).toISOString(), timeEstimate: 22, refundFee: '0', withdrawFee: '4152', ...over,
  },
});

/** fake 1Click: records every call; `quote` answers POST /v0/quote, `statuses` is the scripted sequence of GET /v0/status answers (last one repeats) */
function fake1Click(o: { quoteOver?: Record<string, unknown>; failQuote?: Array<{ status: number; text: string; headers?: Record<string, string> }>; statuses?: Array<{ status?: string; http?: number; text?: string }>; calls?: Call[] } = {}) {
  const calls: Call[] = o.calls ?? [];
  let si = 0; const failQ = [...(o.failQuote ?? [])];
  const f = (async (url: any, init: any) => {
    const u = new URL(String(url));
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method: String(init?.method ?? 'GET'), body, headers: init?.headers ?? {} });
    if (u.pathname === '/v0/quote') {
      const fail = failQ.shift(); if (fail) return new Response(fail.text, { status: fail.status, headers: fail.headers });
      return new Response(JSON.stringify(quoteJson(body, o.quoteOver)), { status: 201 });
    }
    if (u.pathname === '/v0/status') {
      const s = (o.statuses ?? [{ status: 'SUCCESS' }])[Math.min(si++, (o.statuses ?? [{}]).length - 1)];
      if (s.http && s.http !== 200) return new Response(s.text ?? '{"message":"x"}', { status: s.http });
      return new Response(JSON.stringify({ correlationId: 'c', status: s.status, updatedAt: 'now', swapDetails: { amountIn: null, intentHashes: ['i1'], nearTxHashes: ['n1'], originChainTxHashes: [{ hash: 'o1', explorerUrl: 'https://x/o1' }], destinationChainTxHashes: [{ hash: 'd1', explorerUrl: 'https://x/d1' }], refundedAmount: '0', refundReason: null } }), { status: 200 });
    }
    if (u.pathname === '/v0/deposit/submit') return new Response(JSON.stringify({ correlationId: 'c', status: 'PENDING_DEPOSIT', updatedAt: 'now', swapDetails: {} }), { status: 200 });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('live quote request (dry:false)', () => {
  const base = { originAsset: W, destinationAsset: DEST_ASSET, amount: HALF, recipient: IMPLICIT, refundTo: IMPLICIT, nowS: () => NOW };

  it('builds the documented body with dry:false, implicit recipient and refund, ORIGIN_CHAIN deposit and a deadline', () => {
    const b = buildLiveQuoteBody(base);
    expect(b.dry).toBe(false);
    expect(b).toMatchObject({ swapType: 'EXACT_INPUT', depositType: 'ORIGIN_CHAIN', refundType: 'ORIGIN_CHAIN', recipientType: 'DESTINATION_CHAIN', originAsset: W, destinationAsset: DEST_ASSET, amount: HALF, recipient: IMPLICIT, refundTo: IMPLICIT, slippageTolerance: 100 });
    expect(b.deadline).toBe(new Date((NOW + 1200) * 1000).toISOString());
    expect(buildLiveQuoteBody({ ...base, slippageBps: 50, deadlineS: 600 })).toMatchObject({ slippageTolerance: 50, deadline: new Date((NOW + 600) * 1000).toISOString() });
  });
  it('rejects inputs that could move a wrong amount or leave no refund address', () => {
    for (const amount of ['0', '-1', '0.5', '1e24', '', ' 5']) expect(() => buildLiveQuoteBody({ ...base, amount }), amount).toThrow(LiveGuardError);
    expect(() => buildLiveQuoteBody({ ...base, slippageBps: 0 })).toThrow(/slippageBps/);
    expect(() => buildLiveQuoteBody({ ...base, slippageBps: 501 })).toThrow(/slippageBps/);
    expect(() => buildLiveQuoteBody({ ...base, deadlineS: 60 })).toThrow(/deadlineS/);
    expect(() => buildLiveQuoteBody({ ...base, deadlineS: 4000 })).toThrow(/deadlineS/);
    expect(() => buildLiveQuoteBody({ ...base, refundTo: '' })).toThrow(/refundTo/);
  });
  it('POSTs /v0/quote with dry:false and parses the real response shape', async () => {
    const { f, calls } = fake1Click();
    const q = await liveQuote({ ...base, fetch: f });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://1click.chaindefuser.com/v0/quote', body: { dry: false, recipient: IMPLICIT, refundTo: IMPLICIT, amount: HALF } });
    expect(calls[0].headers['x-api-key']).toBeUndefined();
    expect(q).toMatchObject({ depositAddress: DEPOSIT, amountIn: HALF, amountOut: '1629769', minAmountOut: '1613471', timeEstimateS: 22, withdrawFee: '4152', correlationId: 'f4d51444-1b80-4ac3-a4c3-92978cb949f1', source: 'api', requestedAtS: NOW });
    expect(q.request.dry).toBe(false);
    // the quote's deadline is the deposit address validity (days); the refund deadline we sent is 20 minutes: the safe horizon is the earlier one
    expect(quoteValidUntilS(q)).toBe(NOW + 1200);
  });
  it('sends the partner JWT as X-API-Key only when given, and never echoes it in an error', async () => {
    const { f, calls } = fake1Click();
    await liveQuote({ ...base, fetch: f, jwt: 'jwt-secret-value' });
    expect(calls[0].headers['x-api-key']).toBe('jwt-secret-value');
    const bad = fake1Click({ failQuote: [{ status: 401, text: '{"message":"Unauthorized"}' }] });
    const err = await liveQuote({ ...base, fetch: bad.f, jwt: 'jwt-secret-value' }).catch((e) => e);
    expect(err).toMatchObject({ status: 401 }); expect(String(err.message)).not.toContain('jwt-secret-value');
  });
  it('fails closed on a response without a deposit address, without minAmountOut, or with a different amountIn', async () => {
    const noAddr = fake1Click({ quoteOver: { depositAddress: undefined } });
    await expect(liveQuote({ ...base, fetch: noAddr.f })).rejects.toThrow(/no depositAddress/);
    const noMin = fake1Click({ quoteOver: { minAmountOut: undefined } });
    await expect(liveQuote({ ...base, fetch: noMin.f })).rejects.toThrow(/amountOut\/minAmountOut/);
    const other = fake1Click({ quoteOver: { amountIn: '1' } });
    await expect(liveQuote({ ...base, fetch: other.f })).rejects.toThrow(/refusing/);
  });
  it('keeps a 400 verbatim without retrying; retries 429 (retry-after) and 5xx a bounded number of times', async () => {
    const four = fake1Click({ failQuote: [{ status: 400, text: '{"message":"Amount is too low for bridge, try at least 0"}' }] });
    await expect(liveQuote({ ...base, fetch: four.f, sleep: async () => {} })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Amount is too low for bridge') });
    expect(four.calls).toHaveLength(1);
    const sleeps: number[] = [];
    const slow = fake1Click({ failQuote: [{ status: 429, text: 'slow', headers: { 'retry-after': '2' } }, { status: 503, text: 'down' }] });
    const q = await liveQuote({ ...base, fetch: slow.f, sleep: async (ms) => { sleeps.push(ms); } });
    expect(q.depositAddress).toBe(DEPOSIT); expect(slow.calls).toHaveLength(3); expect(sleeps).toEqual([2000, 1000]);
    const dead = fake1Click({ failQuote: Array(5).fill({ status: 500, text: 'boom' }) });
    await expect(liveQuote({ ...base, fetch: dead.f, sleep: async () => {} })).rejects.toBeInstanceOf(IntentsError);
    expect(dead.calls).toHaveLength(3);
  });
});

describe('the dry client can still never ask for a real quote', () => {
  it('buildDryQuoteBody, dryQuote and dryQuoteFull always send dry:true', async () => {
    expect(buildDryQuoteBody({ originAsset: W, destinationAsset: DEST_ASSET, amount: '1', recipient: IMPLICIT, refundTo: IMPLICIT }).dry).toBe(true);
    const { f, calls } = fake1Click();
    await dryQuoteFull({ originAsset: W, destinationAsset: DEST_ASSET, amount: HALF, recipient: IMPLICIT, refundTo: IMPLICIT, fetch: f });
    await dryQuote({ originAsset: W, destinationAsset: DEST_ASSET, amount: HALF, recipient: IMPLICIT, refundTo: IMPLICIT, fetch: f });
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.body.dry).toBe(true);
  });
  it('src/near/intents.ts has no dry:false, and only the settlement script reaches intents-live / intents-settle (not the worker, the planner or the dashboard code)', () => {
    expect(readFileSync('src/near/intents.ts', 'utf8')).not.toMatch(/dry\s*:\s*false/);
    const walk = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.parentPath.includes('node_modules')).map((e) => `${e.parentPath}/${e.name}`);
    for (const file of [...walk('src'), ...walk('worker')]) {
      if (/intents-live\.ts$|intents-settle\.ts$/.test(file)) continue;
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/intents-live|intents-settle/);
    }
  });
});

describe('deposit submit and status', () => {
  it('submitDeposit POSTs {txHash, depositAddress, nearSenderAccount} and keeps an error verbatim', async () => {
    const { f, calls } = fake1Click();
    const s = await submitDeposit({ txHash: 'tx1', depositAddress: DEPOSIT, nearSenderAccount: IMPLICIT, fetch: f });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://1click.chaindefuser.com/v0/deposit/submit', body: { txHash: 'tx1', depositAddress: DEPOSIT, nearSenderAccount: IMPLICIT } });
    expect(s.status).toBe('PENDING_DEPOSIT');
    const bad = (async () => new Response('{"message":"tx not found"}', { status: 400 })) as unknown as typeof fetch;
    await expect(submitDeposit({ txHash: 'x', depositAddress: DEPOSIT, fetch: bad })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('tx not found') });
  });
  it('parses a status response (nulls become undefined) and refuses one without a status', () => {
    const s = parseStatus({ correlationId: 'c', status: 'SUCCESS', updatedAt: 'u', swapDetails: { amountIn: null, intentHashes: ['i'], originChainTxHashes: [{ hash: 'o', explorerUrl: 'e' }], destinationChainTxHashes: [] } });
    expect(s.status).toBe('SUCCESS'); expect(s.swapDetails.amountIn).toBeUndefined(); expect(s.swapDetails.originChainTxHashes).toEqual([{ hash: 'o', explorerUrl: 'e' }]);
    expect(() => parseStatus({ correlationId: 'c' })).toThrow(/no status/);
  });
  it('getStatus GETs /v0/status?depositAddress=...', async () => {
    const { f, calls } = fake1Click({ statuses: [{ status: 'PENDING_DEPOSIT' }] });
    await getStatus({ depositAddress: DEPOSIT, fetch: f });
    expect(calls[0]).toMatchObject({ method: 'GET', url: `https://1click.chaindefuser.com/v0/status?depositAddress=${DEPOSIT}` });
  });

  /** fake clock: sleep advances time */
  const clock = () => { let t = 0; return { nowMs: () => t, sleep: async (ms: number) => { t += ms; } }; };

  it('PENDING_DEPOSIT -> PROCESSING -> SUCCESS ends on SUCCESS with the full history and swap details', async () => {
    const { f, calls } = fake1Click({ statuses: [{ status: 'PENDING_DEPOSIT' }, { status: 'PENDING_DEPOSIT' }, { status: 'PROCESSING' }, { status: 'SUCCESS' }] });
    const seen: string[] = [];
    const w = await waitForStatus({ depositAddress: DEPOSIT, fetch: f, pollMs: 1000, timeoutMs: 60_000, ...clock(), onUpdate: (s) => seen.push(s.status) });
    expect(w.status).toBe('SUCCESS'); expect(w.polls).toBe(4); expect(calls).toHaveLength(4);
    expect(w.history.map((h) => h.status)).toEqual(['PENDING_DEPOSIT', 'PROCESSING', 'SUCCESS']); expect(seen).toEqual(['PENDING_DEPOSIT', 'PROCESSING', 'SUCCESS']);
    expect(w.last?.swapDetails.destinationChainTxHashes[0].hash).toBe('d1');
  });
  it('stops at REFUNDED and at FAILED', async () => {
    for (const status of ['REFUNDED', 'FAILED']) {
      const { f } = fake1Click({ statuses: [{ status: 'PROCESSING' }, { status }] });
      expect((await waitForStatus({ depositAddress: DEPOSIT, fetch: f, ...clock() })).status).toBe(status);
    }
  });
  it('returns TIMEOUT (never a guess) when no final status arrives, and keeps the last status seen', async () => {
    const { f } = fake1Click({ statuses: [{ status: 'PROCESSING' }] });
    const w = await waitForStatus({ depositAddress: DEPOSIT, fetch: f, pollMs: 1000, timeoutMs: 5000, ...clock() });
    expect(w.status).toBe('TIMEOUT'); expect(w.last?.status).toBe('PROCESSING'); expect(w.polls).toBe(6);
  });
  it('treats INCOMPLETE_DEPOSIT and unknown status strings as non-final', async () => {
    const { f } = fake1Click({ statuses: [{ status: 'INCOMPLETE_DEPOSIT' }, { status: 'SOMETHING_NEW' }, { status: 'SUCCESS' }] });
    const w = await waitForStatus({ depositAddress: DEPOSIT, fetch: f, ...clock() });
    expect(w.status).toBe('SUCCESS'); expect(w.history.map((h) => h.status)).toEqual(['INCOMPLETE_DEPOSIT', 'SOMETHING_NEW', 'SUCCESS']);
  });
  it('polls through 404 / 429 / 5xx but throws at once on a 400 or 401', async () => {
    const { f } = fake1Click({ statuses: [{ http: 404, text: '{"message":"not found"}' }, { http: 429, text: 'slow' }, { http: 503, text: 'down' }, { status: 'SUCCESS' }] });
    const w = await waitForStatus({ depositAddress: DEPOSIT, fetch: f, ...clock() });
    expect(w.status).toBe('SUCCESS'); expect(w.transient).toHaveLength(3); expect(w.transient[0]).toMatch(/^404/);
    for (const http of [400, 401]) {
      const bad = fake1Click({ statuses: [{ http, text: '{"message":"nope"}' }] });
      await expect(waitForStatus({ depositAddress: DEPOSIT, fetch: bad.f, ...clock() })).rejects.toMatchObject({ status: http });
    }
  });
});

describe('spend guards', () => {
  const ok = { ALLOW_MAINNET: '1', CONFIRM_INTENTS_SPEND: '0.5' };
  it('parseNearAmount is exact and strict', () => {
    expect(parseNearAmount('0.5')).toBe(5n * 10n ** 23n); expect(parseNearAmount('1')).toBe(10n ** 24n); expect(parseNearAmount('0.000000000000000000000001')).toBe(1n);
    for (const bad of ['', 'abc', '-1', '+1', '1e3', '0.5 ', '.5', '1.', '1,5', '0.0000000000000000000000001']) expect(() => parseNearAmount(bad), bad).toThrow(LiveGuardError);
  });
  it('passes only with ALLOW_MAINNET=1 and a CONFIRM_INTENTS_SPEND equal to the amount', () => {
    expect(checkSettleGuards(ok, '0.5')).toBe(5n * 10n ** 23n);
    expect(checkSettleGuards({ ...ok, CONFIRM_INTENTS_SPEND: '0.50' }, '0.5')).toBe(5n * 10n ** 23n); // same number typed differently
    expect(() => checkSettleGuards({ CONFIRM_INTENTS_SPEND: '0.5' }, '0.5')).toThrow(/ALLOW_MAINNET=1/);
    expect(() => checkSettleGuards({ ...ok, ALLOW_MAINNET: 'true' }, '0.5')).toThrow(/ALLOW_MAINNET=1/);
    expect(() => checkSettleGuards({ ...ok, ALLOW_MAINNET: '0' }, '0.5')).toThrow(/ALLOW_MAINNET=1/);
    expect(() => checkSettleGuards({ ALLOW_MAINNET: '1' }, '0.5')).toThrow(/CONFIRM_INTENTS_SPEND=0.5/);
    expect(() => checkSettleGuards({ ALLOW_MAINNET: '1', CONFIRM_INTENTS_SPEND: '' }, '0.5')).toThrow(/CONFIRM_INTENTS_SPEND/);
    expect(() => checkSettleGuards({ ...ok, CONFIRM_INTENTS_SPEND: '0.4' }, '0.5')).toThrow(/does not equal/);
    expect(() => checkSettleGuards({ ...ok, CONFIRM_INTENTS_SPEND: 'yes' }, '0.5')).toThrow(LiveGuardError);
  });
  it('enforces the 1 NEAR hard cap even when the confirmation matches', () => {
    expect(SPEND_CAP_YOCTO).toBe(10n ** 24n);
    expect(checkSettleGuards({ ALLOW_MAINNET: '1', CONFIRM_INTENTS_SPEND: '1' }, '1')).toBe(10n ** 24n);
    for (const a of ['1.000000000000000000000001', '1.5', '2', '100']) expect(() => checkSettleGuards({ ALLOW_MAINNET: '1', CONFIRM_INTENTS_SPEND: a }, a), a).toThrow(/hard cap/);
  });
  it('refuses zero and malformed amounts', () => {
    expect(() => checkSettleGuards({ ALLOW_MAINNET: '1', CONFIRM_INTENTS_SPEND: '0' }, '0')).toThrow(/greater than zero/);
    expect(() => checkSettleGuards({ ALLOW_MAINNET: '1', CONFIRM_INTENTS_SPEND: '0.5' }, '0.5.1')).toThrow(LiveGuardError);
    expect(() => checkSettleGuards({ ALLOW_MAINNET: '1', CONFIRM_INTENTS_SPEND: '-1' }, '-1')).toThrow(LiveGuardError);
  });
});

describe('implicit account id', () => {
  it('is the lowercase hex of the ed25519 public key (matches near-api-js)', () => {
    const kp = KeyPair.fromRandom('ed25519');
    const id = implicitAccountId(kp.getPublicKey().data);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).toBe(Buffer.from(baseDecode(kp.getPublicKey().toString().replace('ed25519:', ''))).toString('hex'));
    expect(implicitAccountId(Uint8Array.from({ length: 32 }, (_, i) => i))).toBe('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    expect(() => implicitAccountId(new Uint8Array(31))).toThrow(LiveGuardError);
  });
});

describe('quote sanity band', () => {
  const quote = async (over: Record<string, unknown> = {}): Promise<LiveQuote> => liveQuote({ originAsset: W, destinationAsset: DEST_ASSET, amount: HALF, recipient: IMPLICIT, refundTo: IMPLICIT, nowS: () => NOW, fetch: fake1Click({ quoteOver: over }).f });
  it('accepts a normal quote', async () => { assertQuoteSane(await quote(), { nowS: NOW }); });
  it('refuses a memo, a zero floor, a short deadline (either of the two), a loss above 5%, and missing USD values', async () => {
    assertQuoteSane(await quote({ amountOutUsd: '1.58' }), { nowS: NOW }); // 4.8% below: inside the band
    await expect((async () => assertQuoteSane(await quote({ depositMemo: 'abc' }), { nowS: NOW }))()).rejects.toThrow(/memo/);
    await expect((async () => assertQuoteSane(await quote({ minAmountOut: '0' }), { nowS: NOW }))()).rejects.toThrow(/zero/);
    await expect((async () => assertQuoteSane(await quote({ amountOutUsd: '1.50' }), { nowS: NOW }))()).rejects.toThrow(/loses more than 500 bps/);
    await expect((async () => assertQuoteSane(await quote({ amountOutUsd: undefined }), { nowS: NOW }))()).rejects.toThrow(/no usable/);
    const q = await quote();
    expect(() => assertQuoteSane(q, { nowS: NOW + 1200 - 100 })).toThrow(/only valid for 100s/); // the 20 minute refund deadline we sent counts, not the 3 day address validity
    expect(() => assertQuoteSane({ ...q, deadline: new Date((NOW + 60) * 1000).toISOString() }, { nowS: NOW })).toThrow(/only valid for 60s/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the settlement order of operations, with a fake chain and a fake 1Click
// ---------------------------------------------------------------------------------------------------------------------------------
const FUNDER = 'owner.near';
const TX = (n: number) => `${'1'.repeat(40)}${String(n).padStart(4, '0')}`.replace(/0/g, 'A'); // 44 base58 chars

function world(opts: { funderNear?: bigint; finalStatus?: 'SUCCESS' | 'REFUNDED' | 'FAILED' | 'TIMEOUT'; payout?: bigint; quote?: Partial<LiveQuote> | (() => Promise<LiveQuote>); throwOn?: string[]; depositThrows?: boolean } = {}) {
  let clockS = NOW;
  const near = new Map<string, bigint>([[FUNDER, opts.funderNear ?? 10n * 10n ** 24n]]);
  const ft = new Map<string, bigint>(); // `${token}|${account}`
  const registered = new Set<string>();
  const log: string[] = [];
  let hashN = 0, journal: Journal | undefined, quotes = 0;
  const fg = (t: string, a: string) => ft.get(`${t}|${a}`) ?? 0n;
  const fs = (t: string, a: string, v: bigint) => ft.set(`${t}|${a}`, v);
  const state = { depositCalls: 0, depositThrows: opts.depositThrows ?? false, finalStatus: opts.finalStatus ?? 'SUCCESS', payout: opts.payout, throwOn: new Set(opts.throwOn ?? []) };
  const guard = (what: string) => { if (state.throwOn.has(what)) throw new Error(`boom at ${what}`); };
  const port: SettlePort = {
    nowS: () => clockS, sleep: async (ms) => { clockS += Math.ceil(ms / 1000); }, log: () => {},
    nearBalance: async (a) => near.get(a) ?? null,
    ftBalance: async (t, a) => fg(t, a),
    storageRegistered: async (t, a) => registered.has(`${t}|${a}`),
    storageMin: async () => 1250000000000000000000n,
    transferNear: async (to, amt) => { guard('fund'); near.set(FUNDER, near.get(FUNDER)! - amt); near.set(to, (near.get(to) ?? 0n) + amt); log.push(`fund ${amt}`); return TX(++hashN); },
    storageDeposit: async (t, forA, amt) => { guard(`register:${forA === DEPOSIT ? 'deposit' : t}`); near.set(IMPLICIT, near.get(IMPLICIT)! - amt); registered.add(`${t}|${forA}`); log.push(`register ${t === WRAP ? 'wrap' : 'usdc'} ${forA === DEPOSIT ? 'depositAddress' : 'self'}`); return TX(++hashN); },
    nearDeposit: async (amt) => { guard('wrap'); near.set(IMPLICIT, near.get(IMPLICIT)! - amt); fs(WRAP, IMPLICIT, fg(WRAP, IMPLICIT) + amt); log.push(`wrap ${amt}`); return TX(++hashN); },
    ftTransfer: async (t, to, amt) => {
      state.depositCalls++; log.push(`DEPOSIT ${amt} -> ${to}`);
      if (state.depositThrows) throw new Error('RPC timeout');
      fs(t, IMPLICIT, fg(t, IMPLICIT) - amt); fs(t, to, fg(t, to) + amt); return TX(++hashN);
    },
    liveQuote: async (i) => {
      guard('quote'); quotes++; log.push('quote');
      if (typeof opts.quote === 'function') return opts.quote();
      const body = buildLiveQuoteBody({ ...i, nowS: () => clockS });
      return { ...(await (async () => { const { f } = fake1Click(); return liveQuote({ ...i, nowS: () => clockS, fetch: f }); })()), request: body, ...(opts.quote ?? {}) } as LiveQuote;
    },
    submitDeposit: async () => { log.push('submit'); guard('submit'); return { status: 'PENDING_DEPOSIT', correlationId: 'c', swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [] } }; },
    waitForStatus: async () => {
      log.push('status');
      if (state.finalStatus === 'SUCCESS') fs(USDC, IMPLICIT, fg(USDC, IMPLICIT) + (state.payout ?? 1629769n));
      return { status: state.finalStatus, history: [{ atMs: 0, status: state.finalStatus }], polls: 1, transient: [], last: { status: state.finalStatus, correlationId: 'c', swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [] } } } as any;
    },
    loadJournal: () => (journal ? structuredClone(journal) : undefined),
    saveJournal: (j) => { journal = structuredClone(j); },
  };
  return { port, log, near, ft, fg, state, quotes: () => quotes, journal: () => journal, setJournal: (j: Journal) => { journal = j; }, advance: (s: number) => { clockS += s; }, clock: () => clockS };
}
const cfg = { implicit: IMPLICIT, funder: FUNDER, amount: BigInt(HALF), pollMs: 1, statusTimeoutMs: 1000, verifyTimeoutMs: 1000 };
const sends = (log: string[]) => log.filter((l) => /^(fund|register|wrap|DEPOSIT)/.test(l));

describe('settlement order of operations (fake chain, fake 1Click)', () => {
  it('happy path: fund, register, wrap, register, quote, register the deposit address, ONE deposit, submit, status, verify', async () => {
    const w = world();
    const j = await runSettlement(w.port, cfg);
    expect(j.outcome).toBe('settled');
    expect(w.log).toEqual([`fund ${BigInt(HALF) + GAS_FLOAT}`, 'register wrap self', `wrap ${HALF}`, 'register usdc self', 'quote', 'register wrap depositAddress', `DEPOSIT ${HALF} -> ${DEPOSIT}`, 'submit', 'status']);
    expect(w.state.depositCalls).toBe(1);
    expect(j.verification).toEqual({ deltaUsdc: '1629769', minAmountOut: '1613471', ok: true });
    expect(j.balancesBefore!.usdc).toBe('0'); expect(j.balancesAfter!.usdc).toBe('1629769'); expect(j.balancesAfter!.wnear).toBe('0');
    expect(j.txs.map((t) => t.label)).toEqual(['fund the implicit account from the funder', 'register on wrap.near', 'wrap NEAR (wrap.near near_deposit)', 'register on USDC', 'register the deposit address on wrap.near', 'DEPOSIT: wNEAR ft_transfer to the 1Click deposit address']);
    for (const t of j.txs) expect(t.explorer).toBe(`https://nearblocks.io/txns/${t.txHash}`);
    expect(w.fg(WRAP, DEPOSIT)).toBe(BigInt(HALF)); // the wNEAR is at the deposit address
  });

  it('a re-run after success sends nothing again (no fund, no wrap, no second deposit)', async () => {
    const w = world();
    await runSettlement(w.port, cfg);
    const before = sends(w.log).length;
    const again = await runSettlement(w.port, cfg);
    expect(again.outcome).toBe('settled');
    expect(sends(w.log)).toHaveLength(before); expect(w.state.depositCalls).toBe(1); expect(w.quotes()).toBe(1);
  });

  it('REFUNDED: reported as refunded, never as settled, still exactly one deposit', async () => {
    const w = world({ finalStatus: 'REFUNDED' });
    const j = await runSettlement(w.port, cfg);
    expect(j.outcome).toBe('refunded'); expect(j.verification).toBeUndefined(); expect(w.state.depositCalls).toBe(1);
  });
  it('FAILED: reported as failed with the correlation id to quote to support, no retry', async () => {
    const w = world({ finalStatus: 'FAILED' });
    const j = await runSettlement(w.port, cfg);
    expect(j.outcome).toBe('failed'); expect(j.outcomeNote).toContain('f4d51444'); expect(w.state.depositCalls).toBe(1);
  });

  it('TIMEOUT after the deposit: outcome unknown, and a re-run never deposits again', async () => {
    const w = world({ finalStatus: 'TIMEOUT' });
    const j = await runSettlement(w.port, cfg);
    expect(j.outcome).toBe('unknown'); expect(j.deposit?.txHash).toBeTruthy(); expect(w.state.depositCalls).toBe(1);
    w.state.finalStatus = 'SUCCESS';
    const again = await runSettlement(w.port, cfg);
    expect(again.outcome).toBe('settled'); expect(w.state.depositCalls).toBe(1); // the late success is picked up from the status, not by depositing again
  });

  it('a deposit call that throws is PARKED: outcome unknown, journal holds the attempt, and a re-run does not repeat it', async () => {
    const w = world({ depositThrows: true });
    const j = await runSettlement(w.port, cfg);
    expect(j.outcome).toBe('unknown'); expect(j.depositAttempt?.depositAddress).toBe(DEPOSIT); expect(j.deposit).toBeUndefined(); expect(j.outcomeNote).toContain('NOT sent again');
    expect(w.state.depositCalls).toBe(1);
    w.state.depositThrows = false;
    const again = await runSettlement(w.port, cfg);
    expect(again.outcome).toBe('unknown'); expect(again.outcomeNote).toMatch(/INTENTS_DEPOSIT_TX/); expect(w.state.depositCalls).toBe(1); // still 1: parked, not retried
    expect(w.log.filter((l) => l === 'status')).toHaveLength(0);
  });
  it('a parked deposit continues from the tx hash the owner found, still without a second deposit', async () => {
    const w = world({ depositThrows: true });
    await runSettlement(w.port, cfg);
    w.state.depositThrows = false;
    const j = await runSettlement(w.port, { ...cfg, recoveredDepositTx: 'not-a-hash' }).catch((e) => e);
    expect(j).toBeInstanceOf(LiveGuardError);
    const ok = await runSettlement(w.port, { ...cfg, recoveredDepositTx: TX(99) });
    expect(ok.outcome).toBe('settled'); expect(ok.deposit).toMatchObject({ txHash: TX(99), recoveredManually: true }); expect(w.state.depositCalls).toBe(1);
  });

  it('SUCCESS from 1Click but too little USDC on chain: verification_failed, not settled', async () => {
    const w = world({ payout: 1_000_000n }); // min is 1613471
    const j = await runSettlement(w.port, cfg);
    expect(j.outcome).toBe('verification_failed'); expect(j.verification).toMatchObject({ ok: false, deltaUsdc: '1000000' });
  });
  it('the USDC delta is measured against the balance BEFORE the swap (a pre-existing balance does not count)', async () => {
    const w = world({ payout: 100n });
    w.ft.set(`${USDC}|${IMPLICIT}`, 50_000_000n);
    const j = await runSettlement(w.port, cfg);
    expect(j.outcome).toBe('verification_failed'); expect(j.verification!.deltaUsdc).toBe('100');
  });

  it('an error before the deposit stops with nothing deposited; the re-run resumes without funding or wrapping again', async () => {
    const w = world({ throwOn: ['quote'] });
    await expect(runSettlement(w.port, cfg)).rejects.toThrow(/boom at quote/);
    expect(w.state.depositCalls).toBe(0); expect(w.journal()?.depositAttempt).toBeUndefined();
    const done = sends(w.log).length; // fund, register, wrap, register
    expect(done).toBe(4);
    w.state.throwOn.clear();
    const j = await runSettlement(w.port, cfg);
    expect(j.outcome).toBe('settled');
    expect(w.log.filter((l) => l.startsWith('fund'))).toHaveLength(1); expect(w.log.filter((l) => l.startsWith('wrap'))).toHaveLength(1);
  });
  it('an expired journaled quote is abandoned (never deposited to) and a fresh one is requested', async () => {
    const w = world({ throwOn: ['register:deposit'] });
    await expect(runSettlement(w.port, cfg)).rejects.toThrow(/boom at register:deposit/);
    const first = w.journal()!.quote!.depositAddress;
    w.state.throwOn.clear(); w.advance(1000); // 20 minute refund deadline is now less than 300s away
    const j = await runSettlement(w.port, cfg);
    expect(w.quotes()).toBe(2); expect(j.abandonedQuotes).toEqual([{ depositAddress: first, correlationId: 'f4d51444-1b80-4ac3-a4c3-92978cb949f1' }]);
    expect(j.outcome).toBe('settled'); expect(w.state.depositCalls).toBe(1);
  });

  it('refuses a quote with a memo or a bad price before any deposit', async () => {
    for (const bad of [{ depositMemo: 'm' }, { minAmountOut: '0' }, { amountOutUsd: '1.00' }]) {
      const w = world({ quote: bad });
      await expect(runSettlement(w.port, cfg)).rejects.toBeInstanceOf(LiveGuardError);
      expect(w.state.depositCalls).toBe(0);
    }
  });
  it('refuses a deposit address that is not a NEAR account id', async () => {
    const w = world({ quote: { depositAddress: '0xNOT A NEAR ACCOUNT' } });
    await expect(runSettlement(w.port, cfg)).rejects.toThrow(/not a valid NEAR account id/);
    expect(w.state.depositCalls).toBe(0);
  });
  it('stops before sending anything when the funder cannot cover the amount plus the float and the reserve', async () => {
    const w = world({ funderNear: BigInt(HALF) });
    await expect(runSettlement(w.port, cfg)).rejects.toThrow(/funder holds/);
    expect(sends(w.log)).toHaveLength(0);
  });
  it('refuses a journal that belongs to another account or amount, and a non-implicit settlement account', async () => {
    const w = world();
    await runSettlement(w.port, cfg);
    await expect(runSettlement(w.port, { ...cfg, amount: 1n })).rejects.toThrow(/different run/);
    await expect(runSettlement(world().port, { ...cfg, implicit: 'alice.near' })).rejects.toThrow(/implicit/);
  });
  it('the amount is bigint all the way: a 0.5 NEAR run deposits exactly 500000000000000000000000 yocto', async () => {
    const w = world();
    await runSettlement(w.port, cfg);
    expect(w.log).toContain('DEPOSIT 500000000000000000000000 -> ' + DEPOSIT);
  });
});
