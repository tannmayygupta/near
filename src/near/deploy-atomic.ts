// Atomic deploy + initialise of the mandate contract.
// Why: `new` is callable by anyone until it has run once. Deploying in one transaction and calling `new` in a second leaves a window in which
// anybody could initialise the contract with their own DAO and agent. NEAR executes the actions of ONE transaction in order inside one receipt,
// so a failed `new` also reverts the deploy: either the account ends up with the right code AND the right state, or with nothing.
import { actions } from 'near-api-js';

export const EMPTY_CODE_HASH = '11111111111111111111111111111111';
export const STATE_VERSION = 2;

export interface CodeState { codeHash: string | null; version: number | null; dao?: string; agent?: string }
export interface Want { dao: string; agent: string; localHash: string }

export type Plan =
  | { action: 'deploy-and-init' }
  | { action: 'init-only'; note: string }   // recovery only: the right code is there but nobody initialised it (left by the old two-step flow)
  | { action: 'done' }
  | { action: 'abort'; reason: string };

/** Decide from the account's CURRENT state. Never plans to overwrite different code. */
export function planContractSetup(s: CodeState, w: Want): Plan {
  const empty = !s.codeHash || s.codeHash === EMPTY_CODE_HASH;
  if (empty) return { action: 'deploy-and-init' };
  if (s.codeHash !== w.localHash) return { action: 'abort', reason: `the account already holds different code (${s.codeHash}); refusing to overwrite it (committed wasm is ${w.localHash})` };
  if (s.version === null) return { action: 'init-only', note: 'the committed wasm is deployed but not initialised (a previous run stopped between two steps); initialising now, then verifying the result' };
  if (s.version !== STATE_VERSION) return { action: 'abort', reason: `contract state version is ${s.version}, expected ${STATE_VERSION}` };
  if (s.dao === w.dao && s.agent === w.agent) return { action: 'done' };
  return { action: 'abort', reason: `the contract is initialised for another DAO/agent (dao=${s.dao}, agent=${s.agent}); this account cannot be trusted, do not use it` };
}

/** The two ordered actions of the single transaction. */
export function buildDeployInitActions(wasm: Uint8Array, init: { dao: string; agent: string }, gas: bigint) {
  return [actions.deployContract(wasm), actions.functionCall('new', { dao: init.dao, agent: init.agent }, gas, 0n)];
}

export interface SendResult { txHash: string }
export interface SetupDeps {
  /** Sign and send ONE transaction with these actions to the contract account. Must not retry. Throws if the transaction failed or its outcome is unknown. */
  send(actions: ReturnType<typeof buildDeployInitActions>): Promise<SendResult>;
  readState(): Promise<CodeState>;
  sleep(ms: number): Promise<void>;
}
export class SetupAbort extends Error { constructor(msg: string) { super(msg); this.name = 'SetupAbort'; } }

const matches = (s: CodeState, w: Want) => s.codeHash === w.localHash && s.version === STATE_VERSION && s.dao === w.dao && s.agent === w.agent;

async function settle(deps: SetupDeps, w: Want, tries = 8, waitMs = 2000): Promise<CodeState> {
  let s = await deps.readState();
  for (let i = 0; i < tries && !matches(s, w); i++) { await deps.sleep(waitMs); s = await deps.readState(); }
  return s;
}

export interface SetupResult { outcome: 'deployed-and-initialised' | 'initialised' | 'already-done' | 'confirmed-after-uncertain-result'; txHash: string | null; state: CodeState }

export async function setupContract(deps: SetupDeps, wasm: Uint8Array, w: Want, gas: bigint): Promise<SetupResult> {
  const before = await deps.readState();
  const plan = planContractSetup(before, w);
  if (plan.action === 'abort') throw new SetupAbort(plan.reason);
  if (plan.action === 'done') return { outcome: 'already-done', txHash: null, state: before };

  // init-only (recovery) sends just `new`; the normal path sends deploy + new in one transaction
  const all = buildDeployInitActions(wasm, w, gas);
  const toSend = plan.action === 'init-only' ? [all[1]] as typeof all : all;
  let txHash: string | null = null, sendError: unknown = null;
  try { txHash = (await deps.send(toSend)).txHash; } catch (e) { sendError = e; }   // exactly one attempt, never a blind retry

  const after = await settle(deps, w, sendError ? 4 : 8);
  if (matches(after, w)) {
    if (sendError) return { outcome: 'confirmed-after-uncertain-result', txHash, state: after };
    return { outcome: plan.action === 'init-only' ? 'initialised' : 'deployed-and-initialised', txHash, state: after };
  }
  const msg = (sendError as Error | null)?.message?.slice(0, 300);
  const empty = !after.codeHash || after.codeHash === EMPTY_CODE_HASH;
  if (sendError && empty) throw new SetupAbort(`the deploy+init transaction failed and nothing was deployed (it is atomic): ${msg}. Read the error, fix the cause, then run setup again; it will resume safely.`);
  if (sendError) throw new SetupAbort(`the transaction reported an error (${msg}) and the account is in an unexpected state (hash ${after.codeHash}, version ${after.version}, dao ${after.dao}, agent ${after.agent}). Stop and inspect on the explorer before doing anything else.`);
  throw new SetupAbort(`the transaction succeeded but the contract does not read back as expected (hash ${after.codeHash}, version ${after.version}, dao ${after.dao}, agent ${after.agent}). Do not use this account.`);
}
