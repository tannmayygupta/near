// EXEC_MODE=live-dryrun: the LIVE (mainnet Intents / OutLayer) decision path with every money-moving call blocked.
//   - quotes: REAL 1Click public DRY quotes (no key, no funds)
//   - decisions: the real chunk planner + the real price-floor check
//   - money-moving calls (shield / swap / withdraw): the REAL OutLayerClient builds the exact HTTP request (method, url, headers, body,
//     idempotency key), but its fetch is a recorder that never touches the network; the adapter then throws DryRunBlocked.
// The worker in this mode does NOT run the Executor, so nothing is written on chain either (no markFunded, no recordChunk).
import { OutLayerClient, OUTLAYER_MAINNET, type ActionResponse, type QuotePreview, type RequestRecord, type TerminalStatus } from '../../src/near/outlayer';
import { dryQuoteFull } from '../../src/near/intents';
import { planNextChunk, termsMinAmountOut, cryptoRng, type Plan, type Rng } from '../../src/engine/planner';
import type { MandateTerms } from '../../src/engine/schema';
import type { OutLayerPort } from '../ports';

export interface CapturedRequest { method: string; url: string; headers: Record<string, string>; body: unknown }

export class DryRunBlocked extends Error {
  constructor(public spec: CapturedRequest) { super(`DRY-RUN: blocked ${spec.method} ${spec.url} (nothing was sent)`); this.name = 'DryRunBlocked'; }
}

export interface LiveDryRunOptions {
  recipient: string; // recipient/refund used in DRY quotes (an implicit 64-hex NEAR account, like an OutLayer wallet address)
  refundTo?: string;
  fetch?: typeof fetch; // network fetch for the 1Click public DRY quote ONLY
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
}

const redact = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, k.toLowerCase() === 'authorization' ? 'Bearer wk_***' : v]));

export class LiveDryRunOutLayer implements OutLayerPort {
  /** every request the real client WOULD have sent to OutLayer, with the auth header redacted */
  readonly captured: CapturedRequest[] = [];
  private client: OutLayerClient;
  constructor(private o: LiveDryRunOptions) {
    const record: typeof fetch = async (url, init) => {
      this.captured.push({
        method: String(init?.method ?? 'GET'), url: String(url), headers: redact((init?.headers ?? {}) as Record<string, string>),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ request_id: 'dryrun-blocked', status: 'blocked' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    // placeholder credential: it can never authenticate anywhere because the fetch above never leaves the process
    this.client = new OutLayerClient({ baseUrl: OUTLAYER_MAINNET, apiKey: 'wk_dryrun_placeholder_not_a_real_key', fetch: record });
  }

  // reads: no OutLayer key in dry-run, so balances are reported as zero and nothing is funded
  async intentsBalance(): Promise<{ balance: string }> { return { balance: '0' }; }
  async confidentialBalance(): Promise<{ balance?: string; balances?: Array<{ token: string; balance: string }> }> { return { balance: '0', balances: [] }; }

  /** REAL 1Click public dry quote, shaped like OutLayer's QuotePreview */
  async confidentialSwapQuote(b: { token_in: string; token_out: string; amount_in: string }): Promise<QuotePreview> {
    const q = await dryQuoteFull({
      originAsset: b.token_in, destinationAsset: b.token_out, amount: b.amount_in,
      recipient: this.o.recipient, refundTo: this.o.refundTo ?? this.o.recipient, fetch: this.o.fetch, baseUrl: this.o.baseUrl, sleep: this.o.sleep,
    });
    return { amount_out: q.amountOut, min_amount_out: q.minAmountOut, time_estimate_seconds: q.timeEstimateS, hint: '1Click public DRY quote (no OutLayer key used in live-dryrun)' };
  }

  // money-moving: build the real request, record it, then BLOCK
  async confidentialShield(b: { token: string; amount: string }, idem: string): Promise<ActionResponse> { await this.client.confidentialShield(b, idem); throw new DryRunBlocked(this.captured[this.captured.length - 1]); }
  async confidentialSwap(b: { token_in: string; token_out: string; amount_in: string; min_amount_out?: string }, idem: string): Promise<ActionResponse> { await this.client.confidentialSwap(b, idem); throw new DryRunBlocked(this.captured[this.captured.length - 1]); }
  async confidentialWithdraw(b: { chain: string; to: string; amount: string; token: string }, idem: string): Promise<ActionResponse> { await this.client.confidentialWithdraw(b, idem); throw new DryRunBlocked(this.captured[this.captured.length - 1]); }

  async request(): Promise<RequestRecord> { throw new Error('DRY-RUN: no OutLayer request exists (nothing was submitted)'); }
  async waitForRequest(): Promise<RequestRecord & { status: TerminalStatus }> { throw new Error('DRY-RUN: no OutLayer request exists (nothing was submitted)'); }
}

export interface DryRunDecision {
  plan: Plan;
  quote?: QuotePreview;
  minAmountOut?: string;
  floorOk?: boolean;
  wouldSend?: CapturedRequest;
  note: string;
}

/** One executor-style decision (plan chunk -> real quote -> price floor -> exact request that WOULD be sent) without sending anything. */
export async function dryRunDecision(terms: MandateTerms, o: { adapter: LiveDryRunOutLayer; nowS: number; remaining: bigint; idem: string; rng?: Rng }): Promise<DryRunDecision> {
  const plan = planNextChunk(terms, o.nowS, o.remaining, o.rng ?? cryptoRng);
  if (plan.kind !== 'chunk') return { plan, note: plan.kind === 'wait' ? `waiting: ${plan.reason}` : `done: ${plan.reason}` };
  const body = { token_in: terms.sellToken, token_out: terms.buyToken, amount_in: plan.size.toString() };
  const quote = await o.adapter.confidentialSwapQuote(body);
  const minOut = termsMinAmountOut(terms, plan.size);
  const floorOk = BigInt(quote.amount_out ?? '0') >= minOut;
  if (!floorOk) return { plan, quote, minAmountOut: minOut.toString(), floorOk, note: 'quote is below the mandate price floor: the live executor would NOT swap this chunk' };
  let wouldSend: CapturedRequest | undefined;
  try { await o.adapter.confidentialSwap({ ...body, min_amount_out: minOut.toString() }, o.idem); }
  catch (e) { if (e instanceof DryRunBlocked) wouldSend = e.spec; else throw e; }
  return { plan, quote, minAmountOut: minOut.toString(), floorOk, wouldSend, note: 'floor OK: the live executor would send this request (blocked in live-dryrun)' };
}
