// Startup configuration guard: one place that reads the environment, validates it, and refuses to start on anything inconsistent.
// It lists EVERY problem at once (not the first), checks that accounts belong to the configured network, and classifies the agent key's scope.
// Pure functions over an env object so the whole guard is unit-tested (tests/config.test.ts).
import { z } from 'zod';

export type ExecMode = 'live' | 'simulated' | 'testnet-real' | 'testnet-outlayer' | 'live-dryrun';
export const EXEC_MODES: ExecMode[] = ['live', 'simulated', 'testnet-real', 'testnet-outlayer', 'live-dryrun'];

const ED25519 = /^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;
const IMPLICIT = /^[0-9a-f]{64}$/;

/** An account id must belong to the configured network (implicit 64-hex accounts exist on both). */
export function accountBelongsTo(network: string, account: string): boolean {
  if (IMPLICIT.test(account)) return true;
  if (network === 'mainnet') return account.endsWith('.near') || account === 'near';
  if (network === 'testnet') return account.endsWith('.testnet') || account === 'testnet';
  return true; // sandbox: any
}

export interface ValidConfig { network: 'mainnet' | 'testnet' | 'sandbox'; execMode: ExecMode; port: number; dao: string; mandateContract: string; agentAccount: string }
export type EnvCheck = { ok: true; cfg: ValidConfig; warnings: string[] } | { ok: false; problems: string[] };

export function validateEnv(env: Record<string, string | undefined>): EnvCheck {
  const problems: string[] = []; const warnings: string[] = [];
  const get = (k: string) => (env[k] ?? '').trim();
  const need = (k: string, why = '') => { if (!get(k)) problems.push(`missing ${k}${why ? ` (${why})` : ''}`); return get(k); };

  const network = (get('NEAR_NETWORK') || 'testnet') as ValidConfig['network'];
  if (!['mainnet', 'testnet', 'sandbox'].includes(network)) problems.push(`NEAR_NETWORK must be mainnet, testnet or sandbox (got "${network}")`);
  const execMode = (get('EXEC_MODE') || 'live') as ExecMode;
  if (!EXEC_MODES.includes(execMode)) problems.push(`EXEC_MODE must be one of ${EXEC_MODES.join(', ')} (got "${execMode}")`);

  const dao = need('DAO_ACCOUNT'); const mandate = need('MANDATE_CONTRACT'); const agent = need('AGENT_ACCOUNT_ID');
  const agentKey = need('AGENT_SECRET_KEY');
  if (agentKey && !ED25519.test(agentKey)) problems.push('AGENT_SECRET_KEY is not an ed25519:<base58> secret key');

  for (const [k, v] of [['DAO_ACCOUNT', dao], ['MANDATE_CONTRACT', mandate], ['AGENT_ACCOUNT_ID', agent]] as const) {
    if (v && !accountBelongsTo(network, v)) problems.push(`${k} "${v}" does not belong to NEAR_NETWORK=${network} (cross-network mix-up)`);
  }

  if (execMode === 'testnet-real') { need('VAULT_ACCOUNT_ID', 'EXEC_MODE=testnet-real'); const k = need('VAULT_SECRET_KEY', 'EXEC_MODE=testnet-real'); if (k && !ED25519.test(k)) problems.push('VAULT_SECRET_KEY is not an ed25519:<base58> secret key'); need('SIM_QUOTE_RECIPIENT', 'price sanity reference'); }
  if (execMode === 'testnet-outlayer') {
    need('CUSTODY_SEED', 'EXEC_MODE=testnet-outlayer'); need('SIM_QUOTE_RECIPIENT', 'price sanity reference');
    const ok = get('CUSTODY_OWNER_KEY'); if (ok && !ED25519.test(ok)) problems.push('CUSTODY_OWNER_KEY is not an ed25519:<base58> secret key');
    if (!ok) warnings.push('CUSTODY_OWNER_KEY not set: AGENT_SECRET_KEY will also write wallet policies, so it must be a full-access key (a scoped function-call key cannot attach the storage deposit)');
  }
  if (execMode === 'simulated') need('SIM_QUOTE_RECIPIENT', 'EXEC_MODE=simulated');
  if (execMode === 'live') need('OUTLAYER_WK', 'EXEC_MODE=live');
  if (execMode === 'testnet-real' || execMode === 'testnet-outlayer') {
    if (network !== 'testnet') problems.push(`EXEC_MODE=${execMode} only runs on NEAR_NETWORK=testnet`);
  }

  const sealed = get('SEALED_TERMS_KEY');
  if (sealed && !HEX64.test(sealed)) problems.push('SEALED_TERMS_KEY must be 64 hex characters (32 bytes)');
  if (network === 'mainnet') {
    if (get('ALLOW_MAINNET') !== '1') problems.push('NEAR_NETWORK=mainnet requires ALLOW_MAINNET=1 (this build has never run on mainnet)');
    if (!sealed) problems.push('mainnet requires SEALED_TERMS_KEY (sealed terms must not be stored under a random key)');
  }

  const portRaw = get('PORT') || '8787'; const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`PORT must be 1-65535 (got "${portRaw}")`);
  if (get('ALERT_TELEGRAM_TOKEN') && !get('ALERT_TELEGRAM_CHAT')) problems.push('ALERT_TELEGRAM_TOKEN is set but ALERT_TELEGRAM_CHAT is missing');

  if (problems.length) return { ok: false, problems };
  return { ok: true, cfg: { network, execMode, port, dao, mandateContract: mandate, agentAccount: agent }, warnings };
}

/** What kind of access key is this? (NEAR RPC `view_access_key` permission field). */
export type KeyScope = { kind: 'full-access' } | { kind: 'function-call'; receiver: string; methods: string[] } | { kind: 'unknown' };
export function classifyPermission(permission: unknown): KeyScope {
  if (permission === 'FullAccess') return { kind: 'full-access' };
  const fc = (permission as { FunctionCall?: { receiver_id?: string; method_names?: string[] } } | null)?.FunctionCall;
  if (fc && typeof fc.receiver_id === 'string') return { kind: 'function-call', receiver: fc.receiver_id, methods: fc.method_names ?? [] };
  return { kind: 'unknown' };
}
export const AGENT_METHODS = ['mark_funded', 'record_chunk', 'begin_settlement', 'complete', 'expire'];
/** Is the key exactly as narrow as the agent needs? Returns a list of reasons it is not (empty = scoped). */
export function agentKeyProblems(scope: KeyScope, mandateContract: string): string[] {
  if (scope.kind === 'full-access') return ['the agent key has FULL ACCESS: the protocol would let it move NEAR, rotate keys and call any contract'];
  if (scope.kind === 'unknown') return ['the agent key permission could not be read'];
  const out: string[] = [];
  if (scope.receiver !== mandateContract) out.push(`the key may call ${scope.receiver}, not the mandate contract ${mandateContract}`);
  const extra = scope.methods.filter((m) => !AGENT_METHODS.includes(m)); if (extra.length) out.push(`the key may call extra methods: ${extra.join(', ')}`);
  if (scope.methods.length === 0) out.push('the key has no method restriction (it can call every method on that contract)');
  return out;
}

/** Zod view of the validated config for callers that want a parsed object. */
export const ConfigShape = z.object({ network: z.enum(['mainnet', 'testnet', 'sandbox']), execMode: z.enum(EXEC_MODES as [ExecMode, ...ExecMode[]]), port: z.number().int(), dao: z.string(), mandateContract: z.string(), agentAccount: z.string() });
