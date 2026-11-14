// Reference-price guard for the Ref testnet adapter. The adapter only trades pools whose spot price is within a band of a MAINNET reference price,
// because anyone can create or drain a testnet pool (one recorded run swapped through a pool priced ~1e16x the market).
// The failure this fixes: when the reference quote could not be fetched the band was SKIPPED, which is exactly when it matters. Now it fails closed:
// use the last good price (at most `maxAgeMs` old) or refuse to trade.
export class ReferenceUnavailable extends Error { constructor() { super('reference price unavailable: refusing to trade without the price sanity band'); this.name = 'ReferenceUnavailable'; } }

export class RefPriceGuard {
  private last: { price: number; at: number } | null = null;
  constructor(private o: { fetch: () => Promise<number | null>; now?: () => number; maxAgeMs?: number; retries?: number; sleep?: (ms: number) => Promise<void> }) {}
  private get now() { return this.o.now?.() ?? Date.now(); }
  async get(): Promise<number> {
    const tries = this.o.retries ?? 3;
    for (let i = 0; i < tries; i++) {
      const p = await this.o.fetch().catch(() => null);
      if (p !== null && Number.isFinite(p) && p > 0) { this.last = { price: p, at: this.now }; return p; }
      if (i < tries - 1) await (this.o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(500 * (i + 1));
    }
    if (this.last && this.now - this.last.at <= (this.o.maxAgeMs ?? 3_600_000)) return this.last.price; // a recent good price beats no price
    throw new ReferenceUnavailable();
  }
}

/** Spot price (buy-token per sell-token, human units) of a pool must sit within [lo, hi] x the reference. */
export function inBand(spot: number, ref: number, band: [number, number] = [0.2, 5]): boolean {
  return Number.isFinite(spot) && spot >= ref * band[0] && spot <= ref * band[1];
}
