// Authorisation tests for every access-restricted method of the mandate contract.
//
// SAFETY DESIGN: each call uses arguments that the contract would reject by its own validation even if its authorisation check were missing, so a broken
// guard cannot change production state. One method (set_paused) cannot be given invalid arguments and is only sent when it would be a no-op.
//
// WHAT AN ON-CHAIN TEST CAN AND CANNOT PROVE (read this): the release wasm drops the `require!` text (docs/RUNBOOK.md: "WebAssembly trap: unreachable"), so the chain
// never tells us WHICH check refused a call. Therefore:
//   * 'decisive'  - the call would SUCCEED if the guard were missing (set_paused(false) while unpaused), so a contract-level failure proves the guard refused it.
//   * 'indirect'  - the call would fail on input validation anyway (that is what makes it safe). A failure proves only "rejected, state unchanged"; the identity of
//                   the guard is established by the contract's Rust unit tests (which do assert the messages) and by the source/wasm method inventory.
export type Guard = 'dao' | 'agent' | 'proposed-dao';
export type Evidence = 'decisive' | 'indirect';
export interface AuthCase {
  method: string; guard: Guard;
  args: (ctx: { dao: string; agent: string }) => object;
  /** message the Rust unit tests assert; shown in the report, and matched if a build does keep it on-chain */
  expectPanic: string;
  /** why a call that unexpectedly passed authorisation still could not change state */
  ifGuardMissing: string;
  /** state the call needs in order to be a guaranteed no-op; otherwise it is skipped */
  needs?: 'unpaused' | 'no-pending-handover';
  evidence: Evidence;
  limitation?: string;
}
const NO_SUCH_ID = 9007199254740991; // 2^53-1: exactly representable in JSON, never a real mandate id
export const AUTH_MATRIX: AuthCase[] = [
  { method: 'create_mandate', guard: 'dao', expectPanic: 'only the DAO may call this', evidence: 'indirect',
    args: (c) => ({ treasurer: c.agent, terms_hash: 'x', terms_json: null, sell_token: 'x', max_sell: '1', start_ns: 1, end_ns: 2, tier: 'small' }),
    ifGuardMissing: 'terms_hash is 1 character: "terms_hash must be 64 hex chars"' },
  { method: 'cancel_mandate', guard: 'dao', expectPanic: 'only the DAO may call this', evidence: 'indirect', args: () => ({ id: NO_SUCH_ID }), ifGuardMissing: 'no mandate has that id: "no such mandate"' },
  { method: 'set_agent', guard: 'dao', expectPanic: 'only the DAO may call this', evidence: 'indirect', args: (c) => ({ agent: c.dao }), ifGuardMissing: 'the new agent equals the DAO: "the agent must not be the DAO"' },
  { method: 'set_paused', guard: 'dao', expectPanic: 'only the DAO may call this', evidence: 'decisive', args: () => ({ paused: false }), needs: 'unpaused', ifGuardMissing: 'sets paused=false while it is already false: no state change (and the call would SUCCEED, which is why a failure is decisive)' },
  { method: 'propose_dao', guard: 'dao', expectPanic: 'only the DAO may call this', evidence: 'indirect', args: (c) => ({ new_dao: c.agent }), ifGuardMissing: 'the proposed DAO equals the agent: "the new DAO must not be the agent"' },
  { method: 'accept_dao', guard: 'proposed-dao', expectPanic: 'no DAO handover is pending', evidence: 'indirect', args: () => ({}), needs: 'no-pending-handover',
    ifGuardMissing: 'with no pending handover it panics before any state is touched',
    limitation: 'with no handover pending the refusal comes from the state check, so this case cannot prove the identity check; that check ("only the proposed DAO may accept") is covered by the contract unit tests, and proving it on a live contract would need a real DAO proposal' },
  { method: 'mark_funded', guard: 'agent', expectPanic: 'only the agent may call this', evidence: 'indirect', args: () => ({ id: NO_SUCH_ID }), ifGuardMissing: 'no mandate has that id: "no such mandate"' },
  { method: 'record_chunk', guard: 'agent', expectPanic: 'only the agent may call this', evidence: 'indirect', args: () => ({ id: NO_SUCH_ID, index: 0, sold_amount: '1' }), ifGuardMissing: 'no mandate has that id: "no such mandate"' },
  { method: 'begin_settlement', guard: 'agent', expectPanic: 'only the agent may call this', evidence: 'indirect', args: () => ({ id: NO_SUCH_ID }), ifGuardMissing: 'no mandate has that id: "no such mandate"' },
  { method: 'complete', guard: 'agent', expectPanic: 'only the agent may call this', evidence: 'indirect', args: () => ({ id: NO_SUCH_ID, report_hash: 'x', violations: 0, revealed_terms: null }), ifGuardMissing: 'report_hash is 1 character: "report_hash must be 64 hex chars"' },
  { method: 'expire', guard: 'agent', expectPanic: 'only the agent may call this', evidence: 'indirect', args: () => ({ id: NO_SUCH_ID }), ifGuardMissing: 'no mandate has that id: "no such mandate"' },
];

/** The view methods scripts/mainnet/test-contract.ts exercises; tests/contract-methods.test.ts fails if the contract gains a view that is not listed here. */
export const COVERED_VIEWS = ['get_mandate', 'list_mandates', 'get_trust', 'get_config', 'get_version', 'is_paused', 'get_stats'] as const;

/** Reason to skip (never send) this case in the current contract state, or null when it is a guaranteed no-op if sent. */
export function skipReason(c: AuthCase, stats: { paused: boolean; pending_dao: string | null }): string | null {
  if (c.needs === 'unpaused' && stats.paused) return 'the contract is paused: set_paused(false) would not be a no-op, so it is not sent';
  if (c.needs === 'no-pending-handover' && stats.pending_dao !== null) return 'a DAO handover is pending: accept_dao could matter, so it is not sent';
  return null;
}

export interface Outcome { ok: boolean; error: string | null }
export interface Verdict { pass: boolean; evidence: Evidence | 'none'; detail: string }

/** A failure counts only if the CONTRACT refused it (a function-call execution error). Running out of gas money, a dead RPC or a rejected signature prove nothing. */
export const isContractRefusal = (error: string) => /FunctionCallError/.test(error) && /ExecutionError/.test(error);

export function classifyAuthOutcome(c: AuthCase, o: Outcome): Verdict {
  if (o.ok) return { pass: false, evidence: 'none', detail: `the call SUCCEEDED for an unprivileged account: the ${c.guard} guard did not stop it` };
  const err = o.error ?? '';
  if (err.includes(c.expectPanic)) return { pass: true, evidence: 'decisive', detail: `refused with "${c.expectPanic}"` };
  if (!isContractRefusal(err)) return { pass: false, evidence: 'none', detail: `INCONCLUSIVE: the call failed but not inside the contract (${err.slice(0, 160)}); nothing is proven` };
  if (c.evidence === 'decisive') return { pass: true, evidence: 'decisive', detail: 'rejected by the contract; with valid arguments only the guard could reject it (panic text is not kept in the release wasm)' };
  return { pass: true, evidence: 'indirect', detail: `rejected by the contract and state unchanged. Indirect: it would also fail validation (${c.ifGuardMissing}); the identity of the guard rests on the Rust unit tests` };
}

/** Pull the human-readable panic out of a FinalExecutionOutcome (or an error thrown by a client). */
export function outcomeError(outcome: any): Outcome {
  const failure = outcome?.status?.Failure ?? outcome?.status?.failure;
  if (failure) return { ok: false, error: JSON.stringify(failure) };
  const failed = (outcome?.receipts_outcome ?? outcome?.receiptsOutcome ?? []).find((r: any) => r?.outcome?.status?.Failure);
  if (failed) return { ok: false, error: JSON.stringify(failed.outcome.status.Failure) };
  return { ok: !!outcome?.status && outcome.status.SuccessValue !== undefined, error: null };
}
