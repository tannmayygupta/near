// 1Click LIVE client (dry:false): the only code in this repo that asks 1Click for a REAL deposit address.
//
// It is deliberately separate from src/near/intents.ts, whose dry client hard-codes `dry: true` and can never produce a deposit address.
// Nothing in this file signs, sends or holds anything: it only talks HTTP (injectable fetch) and does arithmetic. Moving funds is the job of
// scripts/mainnet/intents-settle.ts (owner-run, guarded). All token amounts are bigint / integer strings; the USD fields 1Click returns are used
// only as a sanity band, never as an amount.
//
// API shapes below follow the 1Click docs (docs.near-intents.org/api-reference/oneclick) and the live responses recorded in docs/DEFI.md:
//   POST /v0/quote           -> { correlationId, timestamp, signature, quoteRequest, quote: { depositAddress, amountIn, amountOut, minAmountOut, deadline, ... } }
//   POST /v0/deposit/submit  -> { correlationId, quoteResponse, status, updatedAt, swapDetails }   (optional: tells 1Click which tx to look at)
//   GET  /v0/status?depositAddress=...  -> same shape; status in KNOWN_DEPOSIT_TX | PENDING_DEPOSIT | INCOMPLETE_DEPOSIT | PROCESSING | SUCCESS | REFUNDED | FAILED
import { ONECLICK, IntentsError } from './intents';

export class LiveGuardError extends Error {
  constructor(message: string) { super(message); this.name = 'LiveGuardError'; }
}

/** Hard cap on the amount one run of the settlement script may swap: 1 NEAR. Not configurable. */
export const SPEND_CAP_YOCTO = 10n ** 24n;

/** "0.5" -> yoctoNEAR. Plain decimals only (no sign, no exponent, no thousands separators, at most 24 decimals). */
export function parseNearAmount(s: string): bigint {
  if (typeof s !== 'string' || !/^\d+(\.\d{1,24})?$/.test(s)) throw new LiveGuardError(`"${String(s)}" is not a plain decimal NEAR amount (like 0.5)`);
  const [i, f = ''] = s.split('.');
  return BigInt(i) * 10n ** 24n + BigInt((f + '0'.repeat(24)).slice(0, 24));
}

/**
 * The gate in front of every real (money-moving) run. Throws LiveGuardError unless ALL hold:
 *  - ALLOW_MAINNET is exactly "1"
 *  - the configured amount is a positive plain decimal and at most the 1 NEAR hard cap
 *  - CONFIRM_INTENTS_SPEND is present and equals the configured amount (typed twice, on purpose)
 * Returns the amount in yoctoNEAR.
 */
export function checkSettleGuards(env: Record<string, string | undefined>, amountNear: string): bigint {
  if (env.ALLOW_MAINNET !== '1') throw new LiveGuardError('REFUSING: this moves real mainnet funds. Set ALLOW_MAINNET=1 for this command to confirm you mean it.');
  const amount = parseNearAmount(amountNear);
  if (amount <= 0n) throw new LiveGuardError('REFUSING: the amount must be greater than zero.');
  if (amount > SPEND_CAP_YOCTO) throw new LiveGuardError(`REFUSING: ${amountNear} NEAR is above the hard cap of 1 NEAR per run.`);
  const c = env.CONFIRM_INTENTS_SPEND;
  if (c === undefined || c === '') throw new LiveGuardError(`REFUSING: set CONFIRM_INTENTS_SPEND=${amountNear} (the exact amount in NEAR) to confirm the spend.`);
  if (parseNearAmount(c) !== amount) throw new LiveGuardError(`REFUSING: CONFIRM_INTENTS_SPEND (${c}) does not equal the configured amount (${amountNear}).`);
  return amount;
}

/** The implicit NEAR account id of an ed25519 key: the lowercase hex of its 32 public-key bytes. */
export function implicitAccountId(publicKeyBytes: Uint8Array): string {
  if (publicKeyBytes.length !== 32) throw new LiveGuardError(`an ed25519 public key has 32 bytes, got ${publicKeyBytes.length}`);
  return Buffer.from(publicKeyBytes).toString('hex');
}

const authHeaders = (jwt?: string): Record<string, string> => ({ 'content-type': 'application/json', ...(jwt ? { 'x-api-key': jwt } : {}) });
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isIntegerString = (s: unknown): s is string => typeof s === 'string' && /^[0-9]+$/.test(s);

// ---------------------------------------------------------------------------------------------------------------------------------
// quote
// ---------------------------------------------------------------------------------------------------------------------------------
export interface LiveQuoteInput {
  originAsset: string; destinationAsset: string;
  /** integer string, smallest units of the origin asset */
  amount: string;
  recipient: string; refundTo: string;
  slippageBps?: number;
  /** seconds from now until the quote (and the deposit address) expire; 120..3600, default 1200 */
  deadlineS?: number;
  nowS?: () => number;
  /** optional partner JWT (sent as X-API-Key). Without one 1Click adds 0.25%. Never logged. */
  jwt?: string;
  fetch?: typeof fetch; baseUrl?: string; sleep?: (ms: number) => Promise<void>; retries?: number;
}

/** The exact JSON sent to POST /v0/quote for a real quote. `dry: false` is hard-coded (the dry client hard-codes `dry: true`). */
export function buildLiveQuoteBody(o: LiveQuoteInput) {
  if (!isIntegerString(o.amount) || BigInt(o.amount) <= 0n) throw new LiveGuardError(`amount must be a positive integer string in smallest units, got "${String(o.amount)}"`);
  const slippage = o.slippageBps ?? 100;
  if (!Number.isInteger(slippage) || slippage < 1 || slippage > 500) throw new LiveGuardError(`slippageBps must be an integer 1..500, got ${slippage}`);
  const deadlineS = o.deadlineS ?? 1200;
  if (!Number.isInteger(deadlineS) || deadlineS < 120 || deadlineS > 3600) throw new LiveGuardError(`deadlineS must be an integer 120..3600, got ${deadlineS}`);
  if (!o.recipient || !o.refundTo) throw new LiveGuardError('recipient and refundTo are required (refunds must come back to an account we control)');
  const now = (o.nowS ?? (() => Math.floor(Date.now() / 1000)))();
  return {
    dry: false as const, swapType: 'EXACT_INPUT', slippageTolerance: slippage,
    originAsset: o.originAsset, depositType: 'ORIGIN_CHAIN', destinationAsset: o.destinationAsset,
    amount: o.amount, refundTo: o.refundTo, refundType: 'ORIGIN_CHAIN', recipient: o.recipient, recipientType: 'DESTINATION_CHAIN',
    deadline: new Date((now + deadlineS) * 1000).toISOString(),
  };
}

export interface LiveQuote {
  depositAddress: string; depositMemo?: string;
  amountIn: string; amountInFormatted?: string; amountInUsd?: string;
  amountOut: string; amountOutFormatted?: string; amountOutUsd?: string; minAmountOut: string;
  /** ISO time after which the deposit address stops being valid (live: 3 days out). The refund deadline we sent is in `request.deadline`; see quoteValidUntilS */
  deadline: string; timeWhenInactive?: string; timeEstimateS?: number; refundFee?: string; withdrawFee?: string;
  correlationId: string; timestamp?: string; signature?: string;
  /** what we sent (echo), kept for the record */
  request: ReturnType<typeof buildLiveQuoteBody>;
  requestedAtS: number; source: 'api';
}

/** Parse a POST /v0/quote response (dry:false). Fails closed: no deposit address, no amountOut/minAmountOut, or an amountIn we did not ask for -> error. */
export function parseLiveQuote(json: any, request: ReturnType<typeof buildLiveQuoteBody>, requestedAtS: number): LiveQuote {
  const q = json?.quote;
  if (!q || typeof q !== 'object') throw new IntentsError(502, '1Click live quote has no "quote" object');
  if (typeof q.depositAddress !== 'string' || q.depositAddress === '') throw new IntentsError(502, '1Click live quote has no depositAddress (a dry quote? refusing to continue)');
  if (!isIntegerString(q.amountOut) || !isIntegerString(q.minAmountOut)) throw new IntentsError(502, '1Click live quote has no integer amountOut/minAmountOut');
  if (!isIntegerString(q.amountIn)) throw new IntentsError(502, '1Click live quote has no integer amountIn');
  if (q.amountIn !== request.amount) throw new IntentsError(502, `1Click quoted amountIn ${q.amountIn} but we asked for ${request.amount}: refusing (we would deposit a different amount than the quote covers)`);
  if (typeof q.deadline !== 'string' || Number.isNaN(Date.parse(q.deadline))) throw new IntentsError(502, '1Click live quote has no valid deadline');
  return {
    depositAddress: q.depositAddress, depositMemo: q.depositMemo || undefined,
    amountIn: q.amountIn, amountInFormatted: q.amountInFormatted, amountInUsd: q.amountInUsd,
    amountOut: q.amountOut, amountOutFormatted: q.amountOutFormatted, amountOutUsd: q.amountOutUsd, minAmountOut: q.minAmountOut,
    deadline: q.deadline, timeWhenInactive: q.timeWhenInactive, timeEstimateS: q.timeEstimate, refundFee: q.refundFee, withdrawFee: q.withdrawFee,
    correlationId: String(json.correlationId ?? ''), timestamp: json.timestamp, signature: json.signature,
    request, requestedAtS, source: 'api',
  };
}

/**
 * Request a REAL quote (dry:false). This generates a deposit address; funds move only if somebody deposits to it, which this function never does.
 * 429/5xx are retried with backoff (a retried quote only creates another, unused deposit address). The final error text is kept verbatim.
 */
export async function liveQuote(o: LiveQuoteInput): Promise<LiveQuote> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? defaultSleep;
  const retries = o.retries ?? 2;
  const now = o.nowS ?? (() => Math.floor(Date.now() / 1000));
  const body = buildLiveQuoteBody({ ...o, nowS: now });
  const requestedAtS = now();
  let last: IntentsError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await f(`${o.baseUrl ?? ONECLICK}/v0/quote`, { method: 'POST', headers: authHeaders(o.jwt), body: JSON.stringify(body) });
    const text = await r.text();
    if (r.ok) {
      let json: any;
      try { json = JSON.parse(text); } catch { throw new IntentsError(502, `1Click live quote is not JSON: ${text.slice(0, 200)}`); }
      return parseLiveQuote(json, body, requestedAtS);
    }
    last = new IntentsError(r.status, text.slice(0, 400));
    const retryable = r.status === 429 || r.status >= 500;
    if (!retryable || attempt === retries) break;
    const ra = Number(r.headers.get('retry-after'));
    await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt);
  }
  throw last!;
}

/**
 * Unix seconds until which a deposit to this quote is safe. Live finding 2026-11-14: the response's `quote.deadline` is when the DEPOSIT ADDRESS goes
 * inactive (3 days out) while the `deadline` we SEND is when 1Click starts refunding (we asked for 20 minutes). The safe horizon is the earlier of the two.
 */
export function quoteValidUntilS(q: Pick<LiveQuote, 'deadline' | 'request'>): number {
  return Math.floor(Math.min(Date.parse(q.deadline), Date.parse(q.request.deadline)) / 1000);
}

/**
 * Sanity band on a quote, run BEFORE anything is deposited. Fails closed (LiveGuardError) when:
 *  - there is a memo (a NEAR deposit has nowhere to put one),
 *  - minAmountOut is not positive (a zero floor is a bug, see AGENTS.md),
 *  - the earlier of the quote's two deadlines is closer than `minRemainingS` (a late deposit is refunded, or worse, lost),
 *  - the quote's own USD values show a loss above `maxLossBps` (default 500 = 5%), or the USD values are missing/unparseable.
 */
export function assertQuoteSane(q: LiveQuote, o: { nowS: number; minRemainingS?: number; maxLossBps?: number }): void {
  if (q.depositMemo) throw new LiveGuardError(`quote carries a deposit memo ("${q.depositMemo}"); a NEAR ft_transfer cannot carry it: refusing`);
  if (BigInt(q.minAmountOut) <= 0n) throw new LiveGuardError('quote minAmountOut is zero: refusing (a zero floor accepts any price)');
  const remaining = quoteValidUntilS(q) - o.nowS;
  const need = o.minRemainingS ?? 300;
  if (remaining < need) throw new LiveGuardError(`quote is only valid for ${remaining}s more (need at least ${need}s): refusing to deposit`);
  const maxLoss = o.maxLossBps ?? 500;
  const inUsd = Number(q.amountInUsd), outUsd = Number(q.amountOutUsd);
  if (!Number.isFinite(inUsd) || !Number.isFinite(outUsd) || inUsd <= 0) throw new LiveGuardError('quote has no usable amountInUsd/amountOutUsd: refusing (cannot sanity-check the price)');
  if (outUsd < inUsd * (1 - maxLoss / 10000)) throw new LiveGuardError(`quote loses more than ${maxLoss} bps: in ${q.amountInUsd} USD, out ${q.amountOutUsd} USD: refusing`);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// status + deposit submit
// ---------------------------------------------------------------------------------------------------------------------------------
export const TERMINAL_STATUSES = ['SUCCESS', 'REFUNDED', 'FAILED'] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export const isTerminal = (s: string): s is TerminalStatus => (TERMINAL_STATUSES as readonly string[]).includes(s);

export interface TxDetail { hash: string; explorerUrl: string }
export interface SwapDetails {
  amountIn?: string; amountOut?: string; amountInUsd?: string; amountOutUsd?: string; slippage?: number;
  refundedAmount?: string; refundReason?: string; depositedAmount?: string; withdrawFee?: string;
  intentHashes: string[]; nearTxHashes: string[]; originChainTxHashes: TxDetail[]; destinationChainTxHashes: TxDetail[];
}
export interface StatusRecord { status: string; correlationId: string; updatedAt?: string; swapDetails: SwapDetails }

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const txs = (v: unknown): TxDetail[] => (Array.isArray(v) ? v.filter((x) => x && typeof x.hash === 'string').map((x) => ({ hash: x.hash, explorerUrl: String(x.explorerUrl ?? '') })) : []);

/** Parse a status / deposit-submit response. A response without a string `status` is an error (fail closed). */
export function parseStatus(json: any): StatusRecord {
  if (!json || typeof json.status !== 'string') throw new IntentsError(502, `1Click status response has no status: ${JSON.stringify(json)?.slice(0, 200)}`);
  const d = json.swapDetails ?? {};
  return {
    status: json.status, correlationId: String(json.correlationId ?? ''), updatedAt: json.updatedAt,
    swapDetails: { // the live API sends null for fields that do not apply yet; normalised to undefined
      amountIn: d.amountIn ?? undefined, amountOut: d.amountOut ?? undefined, amountInUsd: d.amountInUsd ?? undefined, amountOutUsd: d.amountOutUsd ?? undefined, slippage: d.slippage ?? undefined,
      refundedAmount: d.refundedAmount ?? undefined, refundReason: d.refundReason ?? undefined, depositedAmount: d.depositedAmount ?? undefined, withdrawFee: d.withdrawFee ?? undefined,
      intentHashes: strs(d.intentHashes), nearTxHashes: strs(d.nearTxHashes), originChainTxHashes: txs(d.originChainTxHashes), destinationChainTxHashes: txs(d.destinationChainTxHashes),
    },
  };
}

interface Http { fetch?: typeof fetch; baseUrl?: string; jwt?: string }

/**
 * POST /v0/deposit/submit: tells 1Click which transaction paid the deposit address (optional: it detects deposits by itself, this only speeds it up).
 * Never retried and never throws away the error text. Callers treat a failure as a warning: the deposit is already on chain.
 */
export async function submitDeposit(o: Http & { txHash: string; depositAddress: string; nearSenderAccount?: string; memo?: string }): Promise<StatusRecord> {
  const f = o.fetch ?? fetch;
  const body = { txHash: o.txHash, depositAddress: o.depositAddress, ...(o.nearSenderAccount ? { nearSenderAccount: o.nearSenderAccount } : {}), ...(o.memo ? { memo: o.memo } : {}) };
  const r = await f(`${o.baseUrl ?? ONECLICK}/v0/deposit/submit`, { method: 'POST', headers: authHeaders(o.jwt), body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new IntentsError(r.status, `1Click deposit/submit failed: ${text.slice(0, 400)}`);
  return parseStatus(JSON.parse(text));
}

/** One GET /v0/status. Non-2xx throws IntentsError(status, verbatim text). */
export async function getStatus(o: Http & { depositAddress: string; depositMemo?: string }): Promise<StatusRecord> {
  const f = o.fetch ?? fetch;
  const qs = new URLSearchParams({ depositAddress: o.depositAddress, ...(o.depositMemo ? { depositMemo: o.depositMemo } : {}) });
  const r = await f(`${o.baseUrl ?? ONECLICK}/v0/status?${qs}`, { method: 'GET', headers: o.jwt ? { 'x-api-key': o.jwt } : {} });
  const text = await r.text();
  if (!r.ok) throw new IntentsError(r.status, `1Click status failed: ${text.slice(0, 400)}`);
  return parseStatus(JSON.parse(text));
}

export interface WaitResult {
  /** a terminal 1Click status, or 'TIMEOUT' when none was reached in time (the outcome is then UNKNOWN: park it, never guess) */
  status: TerminalStatus | 'TIMEOUT';
  last?: StatusRecord;
  history: Array<{ atMs: number; status: string }>;
  polls: number;
  /** transient problems seen while polling (404 before 1Click knows the deposit, 429, 5xx, network errors) */
  transient: string[];
}

/**
 * Poll /v0/status until SUCCESS / REFUNDED / FAILED or `timeoutMs`. 404 (not found yet), 429, 5xx and network errors are transient and polled through;
 * any other error (400, 401, unparseable) is thrown at once. Unknown status strings are non-terminal: they are recorded and polling continues.
 */
export async function waitForStatus(o: Http & {
  depositAddress: string; depositMemo?: string; timeoutMs?: number; pollMs?: number;
  sleep?: (ms: number) => Promise<void>; nowMs?: () => number; onUpdate?: (s: StatusRecord) => void;
}): Promise<WaitResult> {
  const sleep = o.sleep ?? defaultSleep, nowMs = o.nowMs ?? (() => Date.now());
  const timeoutMs = o.timeoutMs ?? 600_000, pollMs = Math.max(o.pollMs ?? 3000, 1);
  const start = nowMs();
  const res: WaitResult = { status: 'TIMEOUT', history: [], polls: 0, transient: [] };
  while (true) {
    res.polls++;
    try {
      const s = await getStatus(o);
      res.last = s;
      if (res.history.length === 0 || res.history[res.history.length - 1].status !== s.status) { res.history.push({ atMs: nowMs(), status: s.status }); o.onUpdate?.(s); }
      if (isTerminal(s.status)) { res.status = s.status; return res; }
    } catch (e) {
      const status = e instanceof IntentsError ? e.status : 0; // 0 = network error / not an HTTP answer
      const transient = status === 0 || status === 404 || status === 429 || status >= 500;
      if (!transient || (e instanceof SyntaxError)) throw e;
      if (res.transient.length < 50) res.transient.push(`${status || 'network'}: ${(e as Error).message.slice(0, 160)}`);
    }
    if (nowMs() - start >= timeoutMs) return res;
    await sleep(pollMs);
  }
}
