// Cross-chain route quotes for the DeFi story. Every figure is from the committed recorded run
// (app/public/demo-run/mainnet-readonly.json: live 1Click DRY quotes, source 'api') or from an optional live refresh in the browser.
// Nothing here executes anything: only POST /v0/quote with dry:true is ever called.
import { asset } from './data';
import type { Result } from './types';

export type RouteQuote = {
  amountIn: string; amountOut: string; minAmountOut?: string; minAmountIn?: string; amountInUsd?: string; amountOutUsd?: string;
  timeEstimateS?: number; refundFee?: string; withdrawFee?: string; fetchedAtS: number; source: 'api';
};
export type RouteLeg = {
  id: string; kind: 'sell' | 'payout'; label: string;
  from: { asset: string; symbol: string; chain: string }; to: { asset: string; symbol: string; chain: string };
  amountIn: string; recipient: string; refundTo: string; needsSwap: boolean;
  quote?: RouteQuote; error?: { status: number; message: string }; skipped?: string; source: 'api';
};
export type RoutesRun = {
  recordedAt: string; mode: string; source: string; endpoint: string; honesty: string;
  sampleMandate: { sellAmount: string; treasuryAccount: string; payouts: { label: string; chain: string; address: string; percent?: number; amount?: string }[] };
  legs: RouteLeg[]; summary: { quoted: number; errors: number; skipped: number };
};

export async function getRoutesRun(): Promise<Result<RoutesRun>> {
  try {
    const r = await fetch(asset('/demo-run/mainnet-readonly.json'), { cache: 'no-store' });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status} loading the committed dry-run quotes (app/public/demo-run/mainnet-readonly.json)` };
    return { ok: true, data: (await r.json()) as RoutesRun, source: 'recorded' };
  } catch (e) { return { ok: false, error: `Could not load the committed dry-run quotes: ${(e as Error).message}` }; }
}

export type DryrunDecision = {
  label: string; floorPrice: string; plan: { kind: string; size?: string; delayAfterS?: number }; quote?: { amount_out?: string; min_amount_out?: string; time_estimate_seconds?: number };
  minAmountOut?: string; floorOk?: boolean; wouldSend?: { method: string; url: string; headers: Record<string, string>; body: unknown }; note: string;
};
export type DryrunRun = { recordedAt: string; mode: string; source: string; decisions: DryrunDecision[] };
export async function getDryrunRun(): Promise<Result<DryrunRun>> {
  try {
    const r = await fetch(asset('/demo-run/mainnet-dryrun-decision.json'), { cache: 'no-store' });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status} loading the committed dry-run decisions (app/public/demo-run/mainnet-dryrun-decision.json)` };
    return { ok: true, data: (await r.json()) as DryrunRun, source: 'recorded' };
  } catch (e) { return { ok: false, error: `Could not load the committed dry-run decisions: ${(e as Error).message}` }; }
}

const ONECLICK = 'https://1click.chaindefuser.com/v0/quote';
/** Re-quote ONE leg live from the browser (dry:true). Returns the new quote or the API's own error text (CORS/rate limit/min amount are shown, not hidden). */
export async function refreshLeg(leg: RouteLeg): Promise<{ quote?: RouteQuote; error?: string }> {
  if (!leg.needsSwap || leg.amountIn === '0') return { error: 'nothing to quote for this leg' };
  const body = {
    dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: leg.from.asset, depositType: 'ORIGIN_CHAIN', destinationAsset: leg.to.asset,
    amount: leg.amountIn, refundTo: leg.refundTo, refundType: 'ORIGIN_CHAIN', recipient: leg.recipient, recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 600_000).toISOString(),
  };
  try {
    const r = await fetch(ONECLICK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) return { error: `HTTP ${r.status}: ${text.slice(0, 160)}` };
    const q = JSON.parse(text).quote;
    return { quote: { amountIn: q.amountIn, amountOut: q.amountOut, minAmountOut: q.minAmountOut, minAmountIn: q.minAmountIn, amountInUsd: q.amountInUsd, amountOutUsd: q.amountOutUsd, timeEstimateS: q.timeEstimate, refundFee: q.refundFee, withdrawFee: q.withdrawFee, fetchedAtS: Math.floor(Date.now() / 1000), source: 'api' } };
  } catch (e) { return { error: `request failed (browser CORS or network): ${(e as Error).message}` }; }
}

export const DECIMALS: Record<string, number> = { wNEAR: 24, USDC: 6 };
export const human = (raw: string | undefined, symbol: string, places = 4) => (raw === undefined ? '-' : (Number(BigInt(raw)) / 10 ** (DECIMALS[symbol] ?? 6)).toFixed(places));
