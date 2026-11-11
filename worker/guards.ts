// LAYER B guards: enforced by the worker (and mirrored by the mandate contract). Pure functions, shared by executor and red-team.
// Layer A is the OutLayer wallet policy (caps, tokens, rate limits) enforced inside the enclave; it is NOT replaceable by this file.
import { MandateTerms } from '../src/engine/schema';
import type { OnChainMandate } from '../src/near/mandate';

export class GuardError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'GuardError'; }
}

export const EXECUTABLE = new Set(['Funded', 'Executing']);

export function assertExecutable(m: OnChainMandate, nowS: number) {
  if (!EXECUTABLE.has(m.status)) throw new GuardError('not_executable', `mandate ${m.id} is ${m.status}, not executable`);
  if (nowS * 1e9 < m.start_ns) throw new GuardError('before_window', 'before mandate window');
  if (nowS * 1e9 > m.end_ns) throw new GuardError('after_window', 'after mandate window: execution refused');
}

export function assertSwap(terms: MandateTerms, remaining: bigint, a: { tokenIn: string; tokenOut: string; amountIn: bigint }) {
  if (a.tokenIn !== terms.sellToken) throw new GuardError('wrong_token_in', `token_in ${a.tokenIn} is not the mandate sell token`);
  if (a.tokenOut !== terms.buyToken) throw new GuardError('wrong_token_out', `token_out ${a.tokenOut} is not the mandate buy token`);
  if (a.amountIn <= 0n) throw new GuardError('bad_amount', 'amount must be positive');
  if (a.amountIn > remaining) throw new GuardError('over_budget', `amount ${a.amountIn} exceeds remaining budget ${remaining}`);
}

/** Destinations are limited to the payout list, the fee recipient and returnTo (NEAR). */
export function allowedDestinations(terms: MandateTerms): Array<{ chain: string; address: string }> {
  const out = terms.payouts.map((p) => ({ chain: p.chain, address: p.address }));
  out.push({ chain: 'near', address: terms.returnTo });
  if (terms.feeRecipient) out.push({ chain: 'near', address: terms.feeRecipient });
  return out;
}
export function assertDestination(terms: MandateTerms, chain: string, address: string) {
  const ok = allowedDestinations(terms).some((d) => d.chain === chain && d.address.toLowerCase() === address.toLowerCase());
  if (!ok) throw new GuardError('destination_not_listed', `${chain}:${address} is not in the mandate payout list / returnTo / feeRecipient`);
}

/** The worker only pays out in the buy token (payouts in other tokens would need a second swap; refuse instead of skipping silently). */
export function assertPayoutTokens(terms: MandateTerms) {
  for (const p of terms.payouts) if (p.token !== terms.buyToken) throw new GuardError('payout_token', `payout "${p.label}" token must equal buyToken in this version`);
}

/** Tier rule (PLAN F13). declared tier from chain; trust can only RAISE the requirement, never lower it below the declared tier. */
export type Tier = 'small' | 'mid' | 'large';
export interface TierConfig { smallMinTrust: number }
export function requiredApprovals(tier: Tier, councilSize: number, trust: number, cfg: TierConfig = { smallMinTrust: 0 }): number {
  const majority = Math.floor(councilSize / 2) + 1;
  const eff: Tier = tier === 'small' && trust < cfg.smallMinTrust ? 'mid' : tier;
  return eff === 'small' ? 1 : eff === 'mid' ? majority : councilSize;
}
