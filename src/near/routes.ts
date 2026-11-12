// Cross-chain route planner for a mandate: REAL 1Click DRY quotes (dry:true, no key, no funds, no deposit address) for
//   (a) the sell leg  wNEAR -> USDC on NEAR, and
//   (b) each cross-chain payout leg  USDC(NEAR) -> USDC on Solana / Base / Arbitrum / Ethereum.
// Nothing here can move money: the only network call is POST /v0/quote with dry:true (see intents.ts buildDryQuoteBody).
// Tag: source 'api'. Errors from 1Click (minimums, unsupported routes, rate limits) are recorded verbatim, never hidden.
import { dryQuoteFull, IntentsError, type QuoteRecord } from './intents';

export const PAYOUT_CHAINS = ['near', 'solana', 'base', 'arbitrum', 'ethereum'] as const;
export type PayoutChain = (typeof PAYOUT_CHAINS)[number];

/** defuse asset ids (verified against GET https://1click.chaindefuser.com/v0/tokens, 2026-11-11). */
export const MAINNET_ASSETS = {
  wNEAR: { id: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24, chain: 'near' as PayoutChain },
  USDC: {
    near: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    ethereum: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
    arbitrum: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    base: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    solana: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
  } as Record<PayoutChain, string>,
  USDC_DECIMALS: 6,
};

const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // base58 (no 0, O, I, l)

/** null when valid; otherwise the reason. Format check only (we cannot know whether an address is funded). */
export function validateAddress(chain: PayoutChain, address: string): string | null {
  if (chain === 'near') return NEAR_ACCOUNT.test(address) && address.length >= 2 && address.length <= 64 ? null : 'not a valid NEAR account id';
  if (chain === 'solana') return SOLANA.test(address) ? null : 'not a base58 Solana address (32-44 chars)';
  return EVM.test(address) ? null : `not a 0x + 40-hex ${chain} address`;
}

export interface RoutePayout { label: string; chain: PayoutChain; address: string; amount?: string; percent?: number }
export interface RouteInput {
  sellAmount: string; // wNEAR, smallest units (24 dec)
  treasuryAccount: string; // NEAR account used as recipient of the sell leg and as refund address for every leg (origin chain is NEAR)
  payouts: RoutePayout[];
  slippageBps?: number;
}

export interface Leg {
  id: string; kind: 'sell' | 'payout'; label: string;
  from: { asset: string; symbol: string; chain: PayoutChain };
  to: { asset: string; symbol: string; chain: PayoutChain };
  amountIn: string; recipient: string; refundTo: string;
  needsSwap: boolean; // false for USDC(NEAR) -> NEAR address: a plain Intents withdraw, nothing to quote
  quote?: QuoteRecord;
  error?: { status: number; message: string };
  skipped?: string; // why no quote was requested (bad address, sell leg failed, ...)
  source: 'api';
}
export interface RoutePlan { recordedAt: string; baseUrl: string; legs: Leg[]; summary: { quoted: number; errors: number; skipped: number } }

export interface PlanOptions { fetch?: typeof fetch; baseUrl?: string; sleep?: (ms: number) => Promise<void>; nowS?: () => number; retries?: number }

const A = MAINNET_ASSETS;

export async function planRoutes(input: RouteInput, opts: PlanOptions = {}): Promise<RoutePlan> {
  const nowS = opts.nowS ?? (() => Math.floor(Date.now() / 1000));
  const legs: Leg[] = [];
  const common = { fetch: opts.fetch, baseUrl: opts.baseUrl, sleep: opts.sleep, nowS, retries: opts.retries, slippageBps: input.slippageBps };
  const record = async (leg: Leg, args: { originAsset: string; destinationAsset: string; amount: string }) => {
    try { leg.quote = await dryQuoteFull({ ...common, ...args, recipient: leg.recipient, refundTo: leg.refundTo }); }
    catch (e) { leg.error = e instanceof IntentsError ? { status: e.status, message: e.message } : { status: 0, message: (e as Error).message }; }
    legs.push(leg);
    return leg;
  };

  // (a) sell leg: wNEAR -> USDC on NEAR
  const refundErr = validateAddress('near', input.treasuryAccount);
  const sell: Leg = {
    id: 'sell', kind: 'sell', label: 'Sell wNEAR for USDC (NEAR)', from: { asset: A.wNEAR.id, symbol: 'wNEAR', chain: 'near' }, to: { asset: A.USDC.near, symbol: 'USDC', chain: 'near' },
    amountIn: input.sellAmount, recipient: input.treasuryAccount, refundTo: input.treasuryAccount, needsSwap: true, source: 'api',
  };
  if (refundErr) { sell.skipped = `treasury account: ${refundErr}`; legs.push(sell); } else await record(sell, { originAsset: A.wNEAR.id, destinationAsset: A.USDC.near, amount: input.sellAmount });

  // (b) payout legs: USDC(NEAR) -> USDC on the payout chain
  const proceeds = sell.quote ? BigInt(sell.quote.amountOut) : null;
  for (const [i, p] of input.payouts.entries()) {
    const id = `payout-${i}`;
    const leg: Leg = {
      id, kind: 'payout', label: `Pay ${p.label} on ${p.chain}`, from: { asset: A.USDC.near, symbol: 'USDC', chain: 'near' }, to: { asset: A.USDC[p.chain], symbol: 'USDC', chain: p.chain },
      amountIn: '0', recipient: p.address, refundTo: input.treasuryAccount, needsSwap: p.chain !== 'near', source: 'api',
    };
    const addrErr = validateAddress(p.chain, p.address);
    let amount: bigint | null = null;
    if (p.amount !== undefined) amount = BigInt(p.amount);
    else if (p.percent !== undefined && proceeds !== null) amount = (proceeds * BigInt(Math.round(p.percent * 100))) / 10000n;
    if (amount !== null) leg.amountIn = amount.toString();
    if (addrErr) { leg.skipped = `recipient: ${addrErr}`; legs.push(leg); continue; }
    if (amount === null) { leg.skipped = 'percent payout needs the sell-leg quote, which failed'; legs.push(leg); continue; }
    if (!leg.needsSwap) { leg.skipped = 'USDC already on NEAR: a plain Intents withdraw, no swap to quote'; legs.push(leg); continue; }
    await record(leg, { originAsset: A.USDC.near, destinationAsset: A.USDC[p.chain], amount: amount.toString() });
  }

  const quoted = legs.filter((l) => l.quote).length, errors = legs.filter((l) => l.error).length, skipped = legs.filter((l) => l.skipped).length;
  return { recordedAt: new Date(nowS() * 1000).toISOString(), baseUrl: opts.baseUrl ?? 'https://1click.chaindefuser.com', legs, summary: { quoted, errors, skipped } };
}
