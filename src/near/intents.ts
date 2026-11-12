// 1Click public DRY quote (no key, no money) used as a price/benchmark source. Tagged source = 'api'.
import { BOUNDS } from '../engine/schema';
import type { PriceSample } from '../engine/benchmark';

export const ONECLICK = 'https://1click.chaindefuser.com';

export interface DryQuote { amountIn: string; amountOut: string; minAmountOut: string; amountInUsd?: string; amountOutUsd?: string; timeEstimateS?: number; fetchedAtS: number; source: 'api' }

export class IntentsError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'IntentsError'; }
}

export async function dryQuote(o: {
  originAsset: string; destinationAsset: string; amount: string; recipient: string; refundTo: string;
  fetch?: typeof fetch; nowS?: () => number; baseUrl?: string; slippageBps?: number;
}): Promise<DryQuote> {
  const f = o.fetch ?? fetch;
  const now = o.nowS ?? (() => Math.floor(Date.now() / 1000));
  const body = {
    dry: true, swapType: 'EXACT_INPUT', slippageTolerance: o.slippageBps ?? 100,
    originAsset: o.originAsset, depositType: 'ORIGIN_CHAIN', destinationAsset: o.destinationAsset,
    amount: o.amount, refundTo: o.refundTo, refundType: 'ORIGIN_CHAIN', recipient: o.recipient, recipientType: 'DESTINATION_CHAIN',
    deadline: new Date((now() + 600) * 1000).toISOString(),
  };
  const r = await f(`${o.baseUrl ?? ONECLICK}/v0/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new IntentsError(r.status, `1Click quote failed: ${text.slice(0, 200)}`);
  const q = (JSON.parse(text) as any).quote;
  if (!q?.amountOut) throw new IntentsError(502, '1Click quote has no amountOut');
  return { amountIn: q.amountIn, amountOut: q.amountOut, minAmountOut: q.minAmountOut, amountInUsd: q.amountInUsd, amountOutUsd: q.amountOutUsd, timeEstimateS: q.timeEstimate, fetchedAtS: now(), source: 'api' };
}

// ---------------------------------------------------------------------------------------------------------------------
// Detailed DRY quote for the cross-chain route planner (src/near/routes.ts). ALWAYS `dry: true`: no deposit address is ever
// generated and no funds can move. Only POST /v0/quote is ever called by this module.
// ---------------------------------------------------------------------------------------------------------------------
export interface QuoteRecord {
  amountIn: string; amountInFormatted?: string; amountInUsd?: string; minAmountIn?: string;
  amountOut: string; amountOutFormatted?: string; amountOutUsd?: string; minAmountOut?: string;
  timeEstimateS?: number; refundFee?: string; withdrawFee?: string; deadline?: string; fetchedAtS: number; source: 'api';
}
export interface DryQuoteBodyInput {
  originAsset: string; destinationAsset: string; amount: string; recipient: string; refundTo: string;
  slippageBps?: number; nowS?: () => number;
}
/** The exact JSON sent to 1Click. `dry: true` is hard-coded; tests assert it. */
export function buildDryQuoteBody(o: DryQuoteBodyInput) {
  const now = (o.nowS ?? (() => Math.floor(Date.now() / 1000)))();
  return {
    dry: true as const, swapType: 'EXACT_INPUT', slippageTolerance: o.slippageBps ?? 100,
    originAsset: o.originAsset, depositType: 'ORIGIN_CHAIN', destinationAsset: o.destinationAsset,
    amount: o.amount, refundTo: o.refundTo, refundType: 'ORIGIN_CHAIN', recipient: o.recipient, recipientType: 'DESTINATION_CHAIN',
    deadline: new Date((now + 600) * 1000).toISOString(),
  };
}

/** Dry quote with every field the route planner records. Retries 429/5xx with backoff (injected sleep); the final error text is kept verbatim. */
export async function dryQuoteFull(o: DryQuoteBodyInput & { fetch?: typeof fetch; baseUrl?: string; sleep?: (ms: number) => Promise<void>; retries?: number }): Promise<QuoteRecord> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = o.retries ?? 3;
  const now = o.nowS ?? (() => Math.floor(Date.now() / 1000));
  let last: IntentsError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await f(`${o.baseUrl ?? ONECLICK}/v0/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildDryQuoteBody(o)) });
    const text = await r.text();
    if (r.ok) {
      const q = (JSON.parse(text) as any).quote;
      if (!q?.amountOut) throw new IntentsError(502, '1Click quote has no amountOut');
      return {
        amountIn: q.amountIn, amountInFormatted: q.amountInFormatted, amountInUsd: q.amountInUsd, minAmountIn: q.minAmountIn,
        amountOut: q.amountOut, amountOutFormatted: q.amountOutFormatted, amountOutUsd: q.amountOutUsd, minAmountOut: q.minAmountOut,
        timeEstimateS: q.timeEstimate, refundFee: q.refundFee, withdrawFee: q.withdrawFee, deadline: q.deadline, fetchedAtS: now(), source: 'api',
      };
    }
    last = new IntentsError(r.status, text.slice(0, 400));
    const retryable = r.status === 429 || r.status >= 500;
    if (!retryable || attempt === retries) break;
    const ra = Number(r.headers.get('retry-after'));
    await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt);
  }
  throw last!;
}

/** quote -> benchmark price sample (buy per 1 sell, human units) */
export function quoteToSample(q: DryQuote, sellToken: string, buyToken: string, origin = '1click dry quote'): PriceSample {
  const sd = BOUNDS.allowedTokens[sellToken].decimals, bd = BOUNDS.allowedTokens[buyToken].decimals;
  const price = (Number(BigInt(q.amountOut)) / 10 ** bd) / (Number(BigInt(q.amountIn)) / 10 ** sd);
  return { ts: q.fetchedAtS, price, source: 'api', origin };
}
