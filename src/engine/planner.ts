// Chunk planner + price-floor math. Pure functions; randomness is injected so tests are deterministic.
import { randomInt } from 'node:crypto';
import { BOUNDS, MandateTerms } from './schema';

export interface Rng { /** uniform integer in [0, n) */ below(n: number): number }
export const cryptoRng: Rng = { below: (n) => (n <= 1 ? 0 : randomInt(0, n)) };

export type Plan =
  | { kind: 'wait'; waitS: number; reason: string }
  | { kind: 'chunk'; size: bigint; delayAfterS: number }
  | { kind: 'done'; reason: 'budget_exhausted' | 'window_closed' };

/** uniform bigint in [lo, hi] using only the injected integer RNG (splits into 2^20 steps; fine for chunk jitter). */
function bigBetween(lo: bigint, hi: bigint, rng: Rng): bigint {
  if (hi <= lo) return lo;
  const STEPS = 1 << 20;
  return lo + ((hi - lo) * BigInt(rng.below(STEPS + 1))) / BigInt(STEPS);
}

export function planNextChunk(terms: MandateTerms, nowS: number, remaining: bigint, rng: Rng = cryptoRng): Plan {
  if (remaining <= 0n) return { kind: 'done', reason: 'budget_exhausted' };
  if (nowS >= terms.endTs) return { kind: 'done', reason: 'window_closed' };
  if (nowS < terms.startTs) return { kind: 'wait', waitS: terms.startTs - nowS, reason: 'before start' };
  const min = BigInt(terms.chunkMin), max = BigInt(terms.chunkMax);
  let size = bigBetween(min, max, rng);
  if (size > remaining) size = remaining; // final remainder may be below chunkMin; never above remaining
  const delay = terms.intervalMinS + rng.below(terms.intervalMaxS - terms.intervalMinS + 1);
  return { kind: 'chunk', size, delayAfterS: delay };
}

/** decimal string -> {num, den} exact rational */
export function ratio(decimal: string): { num: bigint; den: bigint } {
  const [i, f = ''] = decimal.split('.');
  return { num: BigInt(i + f), den: 10n ** BigInt(f.length) };
}

/** Minimum acceptable amountOut (smallest buy units) for amountIn (smallest sell units) at floor price. Rounded UP (strict). */
export function minAmountOut(amountIn: bigint, minPrice: string, sellDecimals: number, buyDecimals: number): bigint {
  const { num, den } = ratio(minPrice);
  const n = amountIn * num * 10n ** BigInt(buyDecimals);
  const d = den * 10n ** BigInt(sellDecimals);
  return (n + d - 1n) / d;
}

export function termsMinAmountOut(terms: MandateTerms, amountIn: bigint): bigint {
  return minAmountOut(amountIn, terms.minPrice, BOUNDS.allowedTokens[terms.sellToken].decimals, BOUNDS.allowedTokens[terms.buyToken].decimals);
}

/** true when a quote respects the mandate's price floor */
export const meetsFloor = (terms: MandateTerms, amountIn: bigint, quotedOut: bigint): boolean => quotedOut >= termsMinAmountOut(terms, amountIn);
