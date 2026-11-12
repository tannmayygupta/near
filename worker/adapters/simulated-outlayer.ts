// ===================== TESTNET EXECUTION ADAPTER - NOT A REAL TRADE =====================
// Intents swaps and confidential balances exist only on MAINNET (OutLayer answers 503 on testnet). So that the whole flow can be exercised on
// public testnet, this OutLayerPort does NOT move money: it prices every "fill" from a REAL read-only 1Click dry quote and returns receipts
// whose request ids start with `sim-`. The executor tags everything derived from them as source 'simulated', and the UI/CSV/report show that tag.
// Selected only with EXEC_MODE=simulated. The live path (src/near/outlayer.ts OutLayerClient) is unchanged and is UNPROVEN with real money.
import { OutLayerError } from '../../src/near/outlayer';
import type { ActionResponse, QuotePreview, RequestRecord, TerminalStatus } from '../../src/near/outlayer';
import { dryQuote } from '../../src/near/intents';
import type { OutLayerPort } from '../ports';

export interface SimOpts {
  /** a syntactically valid destination-chain recipient used only for the read-only dry quote */
  recipient: string;
  quote?: (tokenIn: string, tokenOut: string, amountIn: bigint) => Promise<bigint>; // override (tests); default = real 1Click dry quote
}

export class SimulatedOutLayer implements OutLayerPort {
  conf: Record<string, bigint> = {};
  pub: Record<string, bigint> = {};
  swaps: Array<Record<string, unknown>> = [];
  withdrawals: Array<Record<string, unknown>> = [];
  private reqs = new Map<string, RequestRecord>();
  private byIdem = new Map<string, string>();
  private n = 0;
  constructor(private o: SimOpts) {}

  /** Test/demo funding that stands in for "the DAO transfer credited the agent" (that transfer is mainnet-only and unproven). */
  fund(token: string, amount: bigint) { this.conf[token] = (this.conf[token] ?? 0n) + amount; }

  private async priceOut(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<bigint> {
    if (this.o.quote) return this.o.quote(tokenIn, tokenOut, amountIn);
    const q = await dryQuote({ originAsset: tokenIn, destinationAsset: tokenOut, amount: amountIn.toString(), recipient: this.o.recipient, refundTo: this.o.recipient });
    return BigInt(q.amountOut);
  }
  private newReq(idem: string, rec: RequestRecord): string {
    const id = `sim-${++this.n}`; if (idem) this.byIdem.set(idem, id); this.reqs.set(id, rec); return id;
  }

  async intentsBalance(token: string) { return { balance: (this.pub[token] ?? 0n).toString() }; }
  async confidentialBalance(token?: string) { return { balance: (this.conf[token ?? ''] ?? 0n).toString() }; }
  async confidentialShield(b: { token: string; amount: string }, idem: string): Promise<ActionResponse> {
    if (idem && this.byIdem.has(idem)) return { request_id: this.byIdem.get(idem)!, status: 'pending_deposit' };
    const a = BigInt(b.amount); this.pub[b.token] = (this.pub[b.token] ?? 0n) - a; this.conf[b.token] = (this.conf[b.token] ?? 0n) + a;
    return { request_id: this.newReq(idem, { status: 'success', result: { simulated: true } }), status: 'pending_deposit' };
  }
  async confidentialSwapQuote(b: { token_in: string; token_out: string; amount_in: string }): Promise<QuotePreview> {
    return { amount_out: (await this.priceOut(b.token_in, b.token_out, BigInt(b.amount_in))).toString(), time_estimate_seconds: 0, hint: 'simulated: priced from a real 1Click dry quote' };
  }
  async confidentialSwap(b: { token_in: string; token_out: string; amount_in: string; min_amount_out?: string }, idem: string): Promise<ActionResponse> {
    if (idem && this.byIdem.has(idem)) return { request_id: this.byIdem.get(idem)!, status: 'pending_deposit' };
    const inn = BigInt(b.amount_in);
    if ((this.conf[b.token_in] ?? 0n) < inn) throw new OutLayerError('bad_request', 400, { message: 'insufficient balance (simulated)' });
    const out = await this.priceOut(b.token_in, b.token_out, inn);
    if (b.min_amount_out && out < BigInt(b.min_amount_out)) throw new OutLayerError('bad_request', 400, { message: 'quote amount_out below min_amount_out (simulated)' });
    this.conf[b.token_in] -= inn; this.conf[b.token_out] = (this.conf[b.token_out] ?? 0n) + out;
    this.swaps.push({ idem, ...b, out: out.toString() });
    const id = this.newReq(idem, { status: 'success', result: { amount_out: out.toString(), simulated: true, swap_details: { simulated: true, pricedFrom: '1Click dry quote' } } });
    return { request_id: id, status: 'pending_deposit', intent_hash: `sim-ih-${id}` };
  }
  async confidentialWithdraw(b: { chain: string; to: string; amount: string; token: string }, idem: string): Promise<ActionResponse> {
    if (idem && this.byIdem.has(idem)) return { request_id: this.byIdem.get(idem)!, status: 'pending_deposit' };
    const a = BigInt(b.amount);
    if ((this.conf[b.token] ?? 0n) < a) return { request_id: this.newReq(idem, { status: 'failed' }), status: 'pending_deposit' };
    this.conf[b.token] -= a; this.withdrawals.push({ idem, ...b });
    const id = this.newReq(idem, { status: 'success', result: { simulated: true, swap_details: { destinationChainTxHashes: [`sim-dest-tx-${this.n + 1}`] } } });
    return { request_id: id, status: 'pending_deposit', intent_hash: `sim-ih-${id}` };
  }
  async confidentialWithdrawDryRun(_b: { chain: string; to: string; amount: string; token: string }): Promise<QuotePreview> { return { hint: 'simulated adapter: no wallet policy on this path' }; }
  async request(id: string): Promise<RequestRecord> {
    const r = this.reqs.get(id); if (!r) throw new OutLayerError('not_found', 404, { error: 'not_found' }); return r;
  }
  async waitForRequest(id: string): Promise<RequestRecord & { status: TerminalStatus }> { return (await this.request(id)) as RequestRecord & { status: TerminalStatus }; }
}
