// Typed OutLayer agent-wallet client (https://skills.outlayer.ai/agent-custody). Keys live in OutLayer's TEE; we only hold a wk_ credential.
// Money-moving calls always send X-Idempotency-Key so retries never double-act.
import { randomUUID } from 'node:crypto';

export const OUTLAYER_MAINNET = 'https://api.outlayer.ai';

export type OutLayerErrorKind =
  | 'policy_denied' | 'wallet_frozen' | 'operation_limit_reached' | 'confidential_unavailable'
  | 'bad_request' | 'unauthorized' | 'upstream' | 'unknown';

export class OutLayerError extends Error {
  constructor(public kind: OutLayerErrorKind, public status: number, public body: unknown, public retryAfterS?: number) {
    super(`OutLayer ${kind} (HTTP ${status})${typeof body === 'object' && body && 'message' in (body as any) ? ': ' + (body as any).message : ''}`);
    this.name = 'OutLayerError';
  }
}

export type TerminalStatus = 'success' | 'failed' | 'refunded' | 'needs_review';
export interface ActionResponse { request_id: string; status: string; intent_hash?: string; deposit_address?: string; poll_url?: string; [k: string]: unknown }
export interface RequestRecord { status: string; result?: Record<string, any>; [k: string]: unknown }
export interface QuotePreview { amount_out?: string; min_amount_out?: string; deadline?: string; time_estimate_seconds?: number; hint?: string }

export interface OutLayerConfig { baseUrl?: string; apiKey?: string; fetch?: typeof fetch }

export function classify(status: number, body: any, retryAfterHeader?: string | null): OutLayerError {
  const err = typeof body?.error === 'string' ? body.error : '';
  const retry = Number(body?.retry_after_seconds ?? retryAfterHeader ?? NaN);
  const retryAfterS = Number.isFinite(retry) ? retry : undefined;
  if (status === 403 && err === 'wallet_frozen') return new OutLayerError('wallet_frozen', status, body);
  if (status === 403) return new OutLayerError('policy_denied', status, body); // docs: 403 policy_denied / wallet_frozen
  if (status === 429 || err === 'operation_limit_reached') return new OutLayerError('operation_limit_reached', status, body, retryAfterS);
  if (status === 503 && err === 'confidential_unavailable') return new OutLayerError('confidential_unavailable', status, body);
  if (status === 401) return new OutLayerError('unauthorized', status, body);
  if (status === 400) return new OutLayerError('bad_request', status, body);
  if (status >= 500) return new OutLayerError('upstream', status, body);
  return new OutLayerError('unknown', status, body);
}

export class OutLayerClient {
  private base: string; private key?: string; private f: typeof fetch;
  constructor(cfg: OutLayerConfig = {}) {
    this.base = (cfg.baseUrl ?? OUTLAYER_MAINNET).replace(/\/$/, '');
    this.key = cfg.apiKey ?? process.env.OUTLAYER_WK;
    this.f = cfg.fetch ?? fetch;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, opts: { idem?: string | true; auth?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (opts.auth !== false) { if (!this.key) throw new OutLayerError('unauthorized', 401, { message: 'OUTLAYER_WK not set' }); headers.authorization = `Bearer ${this.key}`; }
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.idem) headers['x-idempotency-key'] = opts.idem === true ? randomUUID() : opts.idem;
    const r = await this.f(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = undefined;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = { message: text.slice(0, 300) }; }
    if (!r.ok) throw classify(r.status, json, r.headers.get('retry-after'));
    return json as T;
  }

  /** POST /register: no auth, creates a new agent wallet. The wk_ key is shown ONCE - store it immediately. */
  register() { return this.call<{ api_key: string; wallet_id: string; near_account_id: string; handoff_url?: string; trial?: unknown }>('POST', '/register', undefined, { auth: false }); }
  address(chain = 'near') { return this.call<{ wallet_id: string; chain: string; address: string; public_key?: string }>('GET', `/wallet/v1/address?chain=${encodeURIComponent(chain)}`); }
  /** wallet (chain) balance, e.g. native NEAR for gas */
  balance(chain = 'near', token?: string) { return this.call<{ balance: string; token: string; account_id: string }>('GET', `/wallet/v1/balance?chain=${chain}${token ? `&token=${encodeURIComponent(token)}` : ''}`); }
  /** public intents balance for a plain contract id or nep141: id */
  intentsBalance(token: string) { return this.call<{ balance: string; token: string; account_id: string }>('GET', `/wallet/v1/balance?token=${encodeURIComponent(token)}&source=intents`); }
  tokens() { return this.call<any>('GET', '/wallet/v1/tokens'); }

  // ---- confidential (private shard) ----
  confidentialBalance(token?: string) { return this.call<{ balance?: string; balances?: Array<{ token: string; balance: string }>; account_id: string }>('GET', `/wallet/v1/confidential/balance${token ? `?token=${encodeURIComponent(token)}` : ''}`); }
  confidentialSwapQuote(b: { token_in: string; token_out: string; amount_in: string }) { return this.call<QuotePreview>('POST', '/wallet/v1/confidential/swap/quote', b); }
  confidentialSwap(b: { token_in: string; token_out: string; amount_in: string; min_amount_out?: string }, idem: string | true = true) { return this.call<ActionResponse>('POST', '/wallet/v1/confidential/swap', b, { idem }); }
  confidentialWithdrawDryRun(b: { chain: string; to: string; amount: string; token: string }) { return this.call<QuotePreview>('POST', '/wallet/v1/confidential/withdraw/dry-run', b); }
  confidentialWithdraw(b: { chain: string; to: string; amount: string; token: string }, idem: string | true = true) { return this.call<ActionResponse>('POST', '/wallet/v1/confidential/withdraw', b, { idem }); }
  confidentialShield(b: { token: string; amount: string }, idem: string | true = true) { return this.call<ActionResponse>('POST', '/wallet/v1/confidential/shield', b, { idem }); }
  confidentialUnshield(b: { token: string; amount: string }, idem: string | true = true) { return this.call<ActionResponse>('POST', '/wallet/v1/confidential/unshield', b, { idem }); }
  /** returns a bridge address on the source chain; send funds there out-of-band */
  confidentialDepositCrossChain(b: { source_asset: string; amount: string; destination_asset?: string } | { chain: string; token?: string; amount: string }) { return this.call<{ intent_id: string; deposit_address: string; amount: string; amount_out?: string; min_amount_out?: string; expires_at?: string; hint?: string }>('POST', '/wallet/v1/confidential/deposit/cross-chain', b); }

  // ---- public intents (fallback path B2) ----
  intentsSwapQuote(b: { token_in: string; token_out: string; amount_in: string }) { return this.call<QuotePreview>('POST', '/wallet/v1/intents/swap/quote', b); }
  intentsSwap(b: { token_in: string; token_out: string; amount_in: string; min_amount_out?: string }, idem: string | true = true) { return this.call<ActionResponse>('POST', '/wallet/v1/intents/swap', b, { idem }); }
  intentsWithdraw(b: { chain?: string; to: string; amount: string; token?: string }, idem: string | true = true) { return this.call<ActionResponse>('POST', '/wallet/v1/intents/withdraw', b, { idem }); }

  request(id: string) { return this.call<RequestRecord>('GET', `/wallet/v1/requests/${encodeURIComponent(id)}`); }

  /** Poll until success | failed | refunded | needs_review. pending_deposit / processing keep polling. Throws on timeout. */
  async waitForRequest(id: string, o: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<RequestRecord & { status: TerminalStatus }> {
    const interval = o.intervalMs ?? 3000, timeout = o.timeoutMs ?? 180_000;
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let waited = 0;
    for (;;) {
      const rec = await this.request(id);
      if (['success', 'failed', 'refunded', 'needs_review'].includes(rec.status)) return rec as any;
      if (waited >= timeout) throw new Error(`request ${id} still ${rec.status} after ${timeout}ms; do NOT retry the action, keep polling`);
      await sleep(interval); waited += interval;
    }
  }
}
