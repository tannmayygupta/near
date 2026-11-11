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

/** quote -> benchmark price sample (buy per 1 sell, human units) */
export function quoteToSample(q: DryQuote, sellToken: string, buyToken: string, origin = '1click dry quote'): PriceSample {
  const sd = BOUNDS.allowedTokens[sellToken].decimals, bd = BOUNDS.allowedTokens[buyToken].decimals;
  const price = (Number(BigInt(q.amountOut)) / 10 ** bd) / (Number(BigInt(q.amountIn)) / 10 ** sd);
  return { ts: q.fetchedAtS, price, source: 'api', origin };
}
