// REAL attacks. Each attempt is genuinely made against the executor guards (layer B), the mandate contract (layer B), or OutLayer (layer A).
// None of them can move money: wallet probes use dry-run endpoints only (the optional Layer A probe is a real testnet transfer that the wallet policy is expected to
// refuse); contract attempts are expected to revert. If nothing blocks an attack we say blocked:false.
//
// Exposure on a PUBLIC worker (see docs/DEPLOY.md, "Hosted worker"): `runAttack` is the raw attack (scripts call it directly); `RedteamGate` is what the HTTP API calls.
// The gate adds what a public endpoint needs: results cached per attack and target, a GLOBAL hourly budget for the attacks that cost gas or touch the wallet
// (a reverted contract call still burns gas from the agent key's allowance), refunds for attacks that never ran, and secret scrubbing of every answer.
import { MandateTerms } from '../src/engine/schema';
import { OutLayerError } from '../src/near/outlayer';
import type { OnChainMandate } from '../src/near/mandate';
import { GuardError, assertDestination, assertExecutable, assertSwap } from './guards';
import type { ChainPort, OutLayerPort } from './ports';
import { WindowBudget } from './ratelimit';
import { envRedactor } from './redact';

export interface RedteamResult { attack: string; blocked: boolean; layer: string; status: number | null; error: string; requestId: string | null }
export interface RedteamDeps {
  chain: ChainPort & { attackCreateAsAgent(): Promise<unknown>; attackRecord(id: number, index: number, amount: string): Promise<unknown> };
  outlayer: OutLayerPort & { confidentialWithdrawDryRun?(b: { chain: string; to: string; amount: string; token: string }): Promise<unknown> };
  termsFor(m: OnChainMandate): Promise<MandateTerms | null>;
  nowS(): number;
  /** Optional REAL OutLayer wallet-policy probe (Layer A). Testnet: native transfers through the same policy engine (confidential endpoints are mainnet-only). */
  layerA?: LayerAProbe;
  /** Scrubs secrets from every answer. Default: the secrets in this process's environment plus secret-shaped strings (worker/redact.ts). */
  redact?: (text: string) => string;
}
export interface LayerAProbe {
  transfer(b: { to: string; amount: string }): Promise<unknown>;
  verdict(e: unknown): { blocked: boolean; status: number | null; error: string };
  unlistedTo: string; allowedTo: string; smallAmount: string; overCapAmount: string;
}
export const ATTACKS = ['over_budget', 'wrong_token', 'after_expiry', 'unlisted_payout', 'non_dao_create', 'over_cap'] as const;
export type Attack = (typeof ATTACKS)[number];

const res = (attack: string, blocked: boolean, layer: string, error: string, status: number | null = null, requestId: string | null = null): RedteamResult => ({ attack, blocked, layer, status, error, requestId });
/** NEAR protocol refusals of a restricted access key (wording as observed on testnet). */
export const PROTOCOL_REFUSAL = /does not allow method|does not match transaction receiver|requires full access|Deposit is not allowed|MethodNameMismatch|ReceiverMismatch|RequiresFullAccess|DepositWithFunctionCall/i;
const clean = (d: RedteamDeps) => (e: unknown) => (d.redact ?? envRedactor())(String((e as Error)?.message ?? e).replace(/\s+/g, ' ')).slice(0, 320); // scrub BEFORE clipping so a key is never cut into a recognisable half
/** The window must have been over for this long (worker clock vs block time) before an expiry attack is sent to the chain. */
const EXPIRY_MARGIN_S = 30;

/** Raw attack: may throw only on a programming error; `runAttack` below never throws. */
async function attempt(attack: string, mandateId: number | undefined, d: RedteamDeps): Promise<RedteamResult> {
  const msg = clean(d);
  if (!(ATTACKS as readonly string[]).includes(attack)) return res(attack, false, 'n/a', `unknown attack ${attack}`);
  if (attack === 'non_dao_create') {
    try { await d.chain.attackCreateAsAgent(); return res(attack, false, 'none', 'create_mandate by a non-DAO account SUCCEEDED'); }
    catch (e) {
      // with a function-call key limited to the agent methods, the NEAR PROTOCOL refuses create_mandate before the contract runs (layer 0)
      const protocol = PROTOCOL_REFUSAL.test(msg(e));
      return res(attack, true, protocol ? '0 (NEAR protocol: function-call key scope)' : 'B (mandate contract)', msg(e), null);
    }
  }
  // An explicit target is read directly from the chain (not from the executor's list, which starts at MANDATE_FROM_ID): a hosted worker that ignores old mandates can still be attacked on one.
  let m: OnChainMandate | null | undefined;
  if (mandateId !== undefined) m = await d.chain.getMandate(mandateId);
  else { const all = await d.chain.listMandates(); m = [...all].reverse().find((x) => x.status === 'Executing' || x.status === 'Funded') ?? all[all.length - 1]; }
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
      try {
        await d.chain.attackRecord(m.id, m.chunks, (remaining + 1n).toString());
        // The contract treats an already-recorded chunk index as a silent no-op, so a "success" is only an acceptance if the budget was really exceeded.
        const after = await d.chain.getMandate(m.id);
        if (after && BigInt(after.sold) > BigInt(after.max_sell)) return res(attack, false, 'none', 'contract ACCEPTED an over-budget chunk');
        return res(attack, false, 'n/a', 'inconclusive: the mandate advanced while the attack ran (the contract ignores an already-recorded chunk index), so nothing was tested; run it again');
      }
      catch (e2) { return res(attack, true, 'B (executor guard + mandate contract)', `guard: ${guard} | contract: ${msg(e2)}`); }
    }
  }
  if (attack === 'wrong_token') {
    const other = Object.keys((await import('../src/engine/schema')).BOUNDS.allowedTokens).find((t) => t !== terms.buyToken && t !== terms.sellToken) ?? 'nep141:evil.near';
    try { assertSwap(terms, remaining, { tokenIn: terms.sellToken, tokenOut: 'nep141:evil-token.near', amountIn: 1n }); return res(attack, false, 'none', `swap into a foreign token passed the guard (${other})`); }
    catch (e) { return res(attack, true, 'B (executor guard)', msg(e)); }
  }
  if (attack === 'after_expiry') {
    // A record_chunk of 1 unit is only ever sent where the contract MUST refuse it for good: the window is over, or the mandate can never be executable again (Settling, Completed, Cancelled, Expired).
    // An Approved mandate can still be funded inside its window, and then the contract would ACCEPT this call and corrupt the mandate's chunk accounting, so it gets the guard check only.
    const windowOver = m.end_ns / 1e9 + EXPIRY_MARGIN_S < d.nowS();
    const neverExecutable = !executable && m.status !== 'Approved';
    if (windowOver || neverExecutable) {
      try { await d.chain.attackRecord(m.id, m.chunks, '1'); return res(attack, false, 'none', 'contract ACCEPTED a chunk outside the window'); }
      catch (e) { return res(attack, true, 'B (mandate contract)', msg(e)); }
    }
    try { assertExecutable(m, m.end_ns / 1e9 + 1); return res(attack, false, 'none', 'guard accepted execution after the window'); }
    catch (e) { return res(attack, true, 'B (executor guard)', `${msg(e)} [evaluated at end+1s: this mandate is ${m.status} and still inside its window, so this is a counterfactual-time check and nothing was sent to the chain]`); }
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

export async function runAttack(attack: string, mandateId: number | undefined, d: RedteamDeps): Promise<RedteamResult> {
  let r: RedteamResult;
  try { r = await attempt(attack, mandateId, d); }
  catch (e) { r = res(attack, false, 'n/a', `the attack could not run: ${clean(d)(e)}`); } // never "blocked" and never an exception to the caller: an attack that did not run says so
  const redact = d.redact ?? envRedactor();
  return { ...r, error: redact(r.error), requestId: r.requestId === null ? null : redact(r.requestId) };
}

/** What an attack costs the operator: `chain` = a signed contract call (gas from the agent key), `wallet` = a call to the OutLayer probe wallet, `none` = pure code. */
export function attackCost(attack: string, d: Pick<RedteamDeps, 'layerA'>): 'chain' | 'wallet' | 'none' {
  if (attack === 'non_dao_create' || attack === 'over_budget' || attack === 'after_expiry') return 'chain';
  if ((attack === 'unlisted_payout' || attack === 'over_cap') && d.layerA) return 'wallet';
  return 'none';
}

export interface GateOptions {
  /** how long a finished attack answers every visitor from memory (default 600 s) */
  cacheTtlS?: number;
  /** GLOBAL budgets per hour, shared by all visitors (defaults: 6 chain attacks, 6 wallet attacks) and a daily cap on chain attacks (default 30) */
  chainPerHour?: number; walletPerHour?: number; chainPerDay?: number;
  nowMs?: () => number;
}
export type GateResult = RedteamResult & { cachedAgeS?: number };

/** The HTTP-facing wrapper around `runAttack`. Never throws; an attack refused by the gate itself is reported as NOT RUN (layer "n/a"), never as blocked. */
export class RedteamGate {
  private cache = new Map<string, { at: number; result: RedteamResult }>();
  private inflight = new Map<string, Promise<RedteamResult>>();
  private chainHour: WindowBudget; private chainDay: WindowBudget; private walletHour: WindowBudget;
  constructor(private d: RedteamDeps, private o: GateOptions = {}) {
    const now = o.nowMs ?? Date.now;
    this.chainHour = new WindowBudget(o.chainPerHour ?? 6, 3_600_000, now);
    this.chainDay = new WindowBudget(o.chainPerDay ?? 30, 86_400_000, now);
    this.walletHour = new WindowBudget(o.walletPerHour ?? 6, 3_600_000, now);
  }
  private get now() { return this.o.nowMs?.() ?? Date.now(); }
  private notRun(attack: string, why: string): GateResult { return res(attack, false, 'n/a', why); }

  async run(attack: string, mandateId: unknown): Promise<GateResult> {
    if (!(ATTACKS as readonly string[]).includes(attack)) return this.notRun(attack, `unknown attack ${String(attack).slice(0, 40)}`);
    if (mandateId !== undefined && mandateId !== null && !(typeof mandateId === 'number' && Number.isSafeInteger(mandateId) && mandateId >= 0)) return this.notRun(attack, 'mandateId must be a non-negative integer');
    const id = typeof mandateId === 'number' ? mandateId : undefined;
    const key = `${attack}:${id ?? 'latest'}`;
    const hit = this.cache.get(key); const ttl = (this.o.cacheTtlS ?? 600) * 1000;
    if (hit && this.now - hit.at < ttl) return { ...hit.result, cachedAgeS: Math.round((this.now - hit.at) / 1000) };
    const pending = this.inflight.get(key); if (pending) return pending; // concurrent identical requests share one attack
    const p = this.execute(attack, id, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p); return p;
  }

  private async execute(attack: string, id: number | undefined, key: string): Promise<RedteamResult> {
    const cost = attackCost(attack, this.d);
    const taken: WindowBudget[] = [];
    if (cost !== 'none') {
      const budgets = cost === 'chain' ? [this.chainHour, this.chainDay] : [this.walletHour];
      for (const b of budgets) {
        const t = b.take();
        if (!t.ok) { for (const x of taken) x.refund(); return this.notRun(attack, `the live red-team budget for ${cost === 'chain' ? 'on-chain' : 'wallet'} attacks is used up for now (it is shared by all visitors and protects the agent's gas allowance). Try again in about ${Math.ceil(t.retryAfterS / 60)} min; the recorded results on this page are real testnet runs.`); }
        taken.push(b);
      }
    }
    const result = await runAttack(attack, id, this.d);
    // layer "n/a" = nothing was attempted (no mandate, terms unavailable, probe not configured): do not charge the budget and do not cache.
    // The one exception is an INCONCLUSIVE over-budget attack: its transaction was sent (and cost gas), only its verdict is missing.
    if (result.layer === 'n/a' && !result.error.startsWith('inconclusive')) { for (const x of taken) x.refund(); }
    if (result.layer !== 'n/a') this.cache.set(key, { at: this.now, result });
    return result;
  }
}
