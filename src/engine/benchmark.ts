// Benchmark math. Every number carries a SOURCE TAG: 'chain' (read from chain/OutLayer result), 'api' (public quote/price API), 'recorded' (replayed from a stored real run), 'simulated' (produced by the testnet execution adapter: NOT a real trade).
export type Source = 'chain' | 'api' | 'recorded' | 'simulated';
export interface Tagged<T> { value: T; source: Source }
export const tag = <T>(value: T, source: Source): Tagged<T> => ({ value, source });

export interface PriceSample { ts: number; price: number; source: Source; origin: string } // price = buy per 1 sell (human units)
export interface Fill { index: number; ts: number; amountIn: string; amountOut: string; requestId: string; intentHash?: string; source: Source }

const toNum = (units: string, decimals: number) => Number(BigInt(units)) / 10 ** decimals;

export function fillPrice(f: Fill, sellDec: number, buyDec: number): number {
  const i = toNum(f.amountIn, sellDec);
  return i === 0 ? 0 : toNum(f.amountOut, buyDec) / i;
}

/** volume-weighted average execution price of our fills */
export function vwap(fills: Fill[], sellDec: number, buyDec: number): number | null {
  const sold = fills.reduce((s, f) => s + toNum(f.amountIn, sellDec), 0);
  const got = fills.reduce((s, f) => s + toNum(f.amountOut, buyDec), 0);
  return sold === 0 ? null : got / sold;
}

/** time-weighted average of benchmark samples inside [fromTs,toTs] (each sample holds until the next) */
export function twap(samples: PriceSample[], fromTs: number, toTs: number): number | null {
  const s = samples.filter((x) => x.ts <= toTs).sort((a, b) => a.ts - b.ts);
  if (!s.length || toTs <= fromTs) return null;
  let acc = 0, covered = 0;
  for (let i = 0; i < s.length; i++) {
    const start = Math.max(s[i].ts, fromTs);
    const end = Math.min(i + 1 < s.length ? s[i + 1].ts : toTs, toTs);
    if (end > start) { acc += s[i].price * (end - start); covered += end - start; }
  }
  return covered === 0 ? null : acc / covered;
}

/** positive = we beat the benchmark (sold higher), negative = worse; in basis points of benchmark */
export const edgeBps = (ours: number | null, bench: number | null): number | null =>
  ours === null || bench === null || bench === 0 ? null : Math.round(((ours - bench) / bench) * 10000);

/** slippage of one fill vs the quote price immediately before it, in bps (positive = worse than quote) */
export const slippageBps = (quotedOut: bigint, actualOut: bigint): number =>
  quotedOut === 0n ? 0 : Number(((quotedOut - actualOut) * 10000n) / quotedOut);


/** Constant-product output exactly as a Ref SIMPLE_POOL computes it (fee in bps of 10_000). Pure: used for the one-shot baseline from a stored pool snapshot. */
export function cpmmOut(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feeBps: number): bigint {
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return 0n;
  const inWithFee = amountIn * BigInt(10_000 - feeBps);
  return (inWithFee * reserveOut) / (reserveIn * 10_000n + inWithFee);
}