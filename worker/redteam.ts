// REAL attacks. Each attempt is genuinely made against the executor guards (layer B), the mandate contract (layer B), or OutLayer (layer A).
// None of them can move money: wallet probes use dry-run endpoints only; contract attempts are expected to revert. If nothing blocks an attack we say blocked:false.
import { MandateTerms } from '../src/engine/schema';
import { OutLayerError } from '../src/near/outlayer';
import type { OnChainMandate } from '../src/near/mandate';
import { GuardError, assertDestination, assertExecutable, assertSwap } from './guards';
import type { ChainPort, OutLayerPort } from './ports';

export interface RedteamResult { attack: string; blocked: boolean; layer: string; status: number | null; error: string; requestId: string | null }
export interface RedteamDeps {
  chain: ChainPort & { attackCreateAsAgent(): Promise<unknown>; attackRecord(id: number, index: number, amount: string): Promise<unknown> };
  outlayer: OutLayerPort & { confidentialWithdrawDryRun?(b: { chain: string; to: string; amount: string; token: string }): Promise<unknown> };
  termsFor(m: OnChainMandate): Promise<MandateTerms | null>;
  nowS(): number;
  /** Optional REAL OutLayer wallet-policy probe (Layer A). Testnet: native transfers through the same policy engine (confidential endpoints are mainnet-only). */
  layerA?: LayerAProbe;
}
export interface LayerAProbe {
  transfer(b: { to: string; amount: string }): Promise<unknown>;
  verdict(e: unknown): { blocked: boolean; status: number | null; error: string };
  unlistedTo: string; allowedTo: string; smallAmount: string; overCapAmount: string;
}
export const ATTACKS = ['over_budget', 'wrong_token', 'after_expiry', 'unlisted_payout', 'non_dao_create', 'over_cap'] as const;
export type Attack = (typeof ATTACKS)[number];

const res = (attack: string, blocked: boolean, layer: string, error: string, status: number | null = null, requestId: string | null = null): RedteamResult => ({ attack, blocked, layer, status, error, requestId });
const msg = (e: unknown) => (e as Error).message.replace(/\s+/g, ' ').slice(0, 320);

export async function runAttack(attack: string, mandateId: number | undefined, d: RedteamDeps): Promise<RedteamResult> {
  if (!(ATTACKS as readonly string[]).includes(attack)) return res(attack, false, 'n/a', `unknown attack ${attack}`);
  if (attack === 'non_dao_create') {
    try { await d.chain.attackCreateAsAgent(); return res(attack, false, 'none', 'create_mandate by a non-DAO account SUCCEEDED'); }
    catch (e) { return res(attack, true, 'B (mandate contract)', msg(e), null); }
  }
  const all = await d.chain.listMandates();
  const m = mandateId !== undefined ? all.find((x) => x.id === mandateId) : [...all].reverse().find((x) => x.status === 'Executing' || x.status === 'Funded') ?? all[all.length - 1];
  if (!m) return res(attack, false, 'n/a', 'no mandate exists to attack; create one first');
  const terms = await d.termsFor(m);
  if (!terms) return res(attack, false, 'n/a', `mandate ${m.id} terms unavailable (sealed and not delivered, or refused)`);
  const remaining = BigInt(m.max_sell) - BigInt(m.sold);
  const executable = m.status === 'Funded' || m.status === 'Executing';

  if (attack === 'over_budget') {
    try { assertSwap(terms, remaining, { tokenIn: terms.sellToken, tokenOut: terms.buyToken, amountIn: remaining + 1n }); return res(attack, false, 'none', 'over-budget swap passed the executor guard'); }
    catch (e) {
      const guard = msg(e);
      if (!executable) return res(attack, true, 'B (executor guard)', guard);
      try { await d.chain.attackRecord(m.id, m.chunks, (remaining + 1n).toString()); return res(attack, false, 'none', 'contract ACCEPTED an over-budget chunk'); }
      catch (e2) { return res(attack, true, 'B (executor guard + mandate contract)', `guard: ${guard} | contract: ${msg(e2)}`); }
    }
  }
  if (attack === 'wrong_token') {
    const other = Object.keys((await import('../src/engine/schema')).BOUNDS.allowedTokens).find((t) => t !== terms.buyToken && t !== terms.sellToken) ?? 'nep141:evil.near';
    try { assertSwap(terms, remaining, { tokenIn: terms.sellToken, tokenOut: 'nep141:evil-token.near', amountIn: 1n }); return res(attack, false, 'none', `swap into a foreign token passed the guard (${other})`); }
    catch (e) { return res(attack, true, 'B (executor guard)', msg(e)); }
  }
  if (attack === 'after_expiry') {
    if (m.end_ns / 1e9 < d.nowS() || !executable) {
      try { await d.chain.attackRecord(m.id, m.chunks, '1'); return res(attack, false, 'none', 'contract ACCEPTED a chunk outside the window'); }
      catch (e) { return res(attack, true, 'B (mandate contract)', msg(e)); }
    }
    try { assertExecutable(m, m.end_ns / 1e9 + 1); return res(attack, false, 'none', 'guard accepted execution after the window'); }
    catch (e) { return res(attack, true, 'B (executor guard)', `${msg(e)} [evaluated at end+1s: this mandate is still inside its window, so this is a counterfactual-time check]`); }
  }
  if (attack === 'over_cap') { // Layer A only: a transfer above the wallet's per-transaction cap, to a LISTED address
    if (!d.layerA) return res(attack, false, 'n/a', 'no OutLayer wallet policy probe configured (Layer A not available in this deployment)');
    try { await d.layerA.transfer({ to: d.layerA.allowedTo, amount: d.layerA.overCapAmount }); return res(attack, false, 'none', 'over-cap transfer was ALLOWED by the wallet'); }
    catch (e) { const v = d.layerA.verdict(e); return res(attack, v.blocked, v.blocked ? 'A (OutLayer wallet policy)' : 'none', v.error, v.status); }
  }
  // unlisted_payout
  if (d.layerA) { // REAL wallet-policy denial first (Layer A)
    try { await d.layerA.transfer({ to: d.layerA.unlistedTo, amount: d.layerA.smallAmount }); return res(attack, false, 'none', 'transfer to an unlisted address was ALLOWED by the wallet'); }
    catch (e) { const v = d.layerA.verdict(e); if (v.blocked) return res(attack, true, 'A (OutLayer wallet policy)', v.error, v.status); }
  }
  const body = { chain: 'near', to: 'attacker-unlisted.near', amount: '1', token: terms.buyToken };
  if (d.outlayer.confidentialWithdrawDryRun) {
    try { await d.outlayer.confidentialWithdrawDryRun(body); }
    catch (e) { if (e instanceof OutLayerError && (e.kind === 'policy_denied' || e.kind === 'wallet_frozen')) return res(attack, true, 'A (OutLayer wallet policy)', msg(e), e.status); }
  }
  try { assertDestination(terms, body.chain, body.to); return res(attack, false, 'none', 'payout to an unlisted address passed the guard'); }
  catch (e) { return res(attack, true, 'B (executor guard)', `${msg(e)} | OutLayer dry-run did not refuse it (no wallet whitelist configured)`); }
}

