// TEST-ONLY fakes for unit tests (in-memory OutLayer + in-memory mandate chain). Never imported by worker/ production code.
import { OutLayerError } from '../../src/near/outlayer';
import type { OnChainMandate } from '../../src/near/mandate';
import { MandateTerms } from '../../src/engine/schema';
import { hashJson } from '../../src/engine/hash';
import type { ApprovalInfo, ChainPort, Clock, OutLayerPort } from '../../worker/ports';

export const SELL = 'nep141:wrap.near';
export const BUY = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const NEAR1 = 10n ** 24n;

export class FakeClock implements Clock {
  constructor(public now = 1_800_000_000) {}
  nowS() { return this.now; }
  async sleep(ms: number) { this.now += Math.ceil(ms / 1000); }
}

export function makeTerms(clock: FakeClock, over: Partial<Record<string, unknown>> = {}) {
  return MandateTerms.parse({
    dao: 'dao.near', treasurer: 'alice.near', sellToken: SELL, buyToken: BUY,
    maxSellAmount: (5n * NEAR1).toString(), minPrice: '3.0', startTs: clock.now - 1, endTs: clock.now + 3600,
    chunkMin: NEAR1.toString(), chunkMax: (2n * NEAR1).toString(), intervalMinS: 5, intervalMaxS: 6,
    payouts: [
      { label: 'alice', chain: 'solana', address: 'SoLaddrAlice1111111111111111111111111111111', token: BUY, percent: 50 },
      { label: 'bob', chain: 'base', address: '0x00000000000000000000000000000000000B0B01', token: BUY, amount: '1000000' },
    ],
    feeBps: 100, feeRecipient: 'ops.near', returnTo: 'dao.near', sealed: false, ...over,
  });
}

export class FakeOutLayer implements OutLayerPort {
  conf: Record<string, bigint> = {}; pub: Record<string, bigint> = {};
  price = 3.7; // buy per 1 sell (human)
  swaps: Array<{ idem: string; amountIn: string; minOut?: string }> = []; withdrawals: Array<{ idem: string; chain: string; to: string; amount: string; token: string }> = [];
  private byIdem = new Map<string, string>(); private reqs = new Map<string, { status: string; result?: any }>(); private n = 0;
  failSwaps: Array<'refunded' | 'failed'> = []; failWithdraws: Record<string, number> = {}; hold = false; throwOnSwap: OutLayerError | null = null;

  async intentsBalance(t: string) { return { balance: (this.pub[t] ?? 0n).toString() }; }
  async confidentialBalance(t?: string) { return { balance: (this.conf[t ?? ''] ?? 0n).toString() }; }
  async confidentialShield(b: { token: string; amount: string }, idem: string) {
    if (this.byIdem.has(idem)) return { request_id: this.byIdem.get(idem)!, status: 'success' };
    const a = BigInt(b.amount); this.pub[b.token] = (this.pub[b.token] ?? 0n) - a; this.conf[b.token] = (this.conf[b.token] ?? 0n) + a;
    const id = `req-${++this.n}`; this.byIdem.set(idem, id); this.reqs.set(id, { status: 'success' }); return { request_id: id, status: 'pending_deposit' };
  }
  private out(inn: bigint) { return BigInt(Math.floor(Number(inn) / 1e24 * this.price * 1e6)); }
  async confidentialSwapQuote(b: { token_in: string; token_out: string; amount_in: string }) { return { amount_out: this.out(BigInt(b.amount_in)).toString() }; }
  async confidentialSwap(b: { token_in: string; token_out: string; amount_in: string; min_amount_out?: string }, idem: string) {
    if (this.throwOnSwap) throw this.throwOnSwap;
    if (this.byIdem.has(idem)) return { request_id: this.byIdem.get(idem)!, status: 'pending_deposit' }; // idempotent replay
    const inn = BigInt(b.amount_in), out = this.out(inn);
    if (b.min_amount_out && out < BigInt(b.min_amount_out)) throw new OutLayerError('bad_request', 400, { message: 'quote amount_out below min_amount_out' });
    this.swaps.push({ idem, amountIn: b.amount_in, minOut: b.min_amount_out });
    const id = `req-${++this.n}`; this.byIdem.set(idem, id);
    const fail = this.failSwaps.shift();
    if (this.hold) this.reqs.set(id, { status: 'processing' });
    else if (fail) this.reqs.set(id, { status: fail });
    else { this.conf[b.token_in] = (this.conf[b.token_in] ?? 0n) - inn; this.conf[b.token_out] = (this.conf[b.token_out] ?? 0n) + out; this.reqs.set(id, { status: 'success', result: { amount_out: out.toString() } }); }
    return { request_id: id, status: 'pending_deposit', intent_hash: `ih-${id}` };
  }
  release(id: string, inn: bigint, tokenIn = SELL, tokenOut = BUY) { const out = this.out(inn); this.conf[tokenIn] -= inn; this.conf[tokenOut] = (this.conf[tokenOut] ?? 0n) + out; this.reqs.set(id, { status: 'success', result: { amount_out: out.toString() } }); }
  async confidentialWithdraw(b: { chain: string; to: string; amount: string; token: string }, idem: string) {
    if (this.byIdem.has(idem)) return { request_id: this.byIdem.get(idem)!, status: 'pending_deposit' };
    const id = `req-${++this.n}`; this.byIdem.set(idem, id);
    const key = `${b.to}`;
    if ((this.failWithdraws[key] ?? 0) > 0) { this.failWithdraws[key]--; this.reqs.set(id, { status: 'failed' }); return { request_id: id, status: 'pending_deposit' }; }
    const a = BigInt(b.amount);
    if ((this.conf[b.token] ?? 0n) < a) { this.reqs.set(id, { status: 'failed' }); return { request_id: id, status: 'pending_deposit' }; }
    this.conf[b.token] -= a; this.withdrawals.push({ idem, ...b });
    this.reqs.set(id, { status: 'success', result: { swap_details: { destinationChainTxHashes: [`tx-${id}`] } } });
    return { request_id: id, status: 'pending_deposit' };
  }
  async request(id: string) { return this.reqs.get(id) ?? { status: 'failed' }; }
  async waitForRequest(id: string) {
    const r = await this.request(id);
    if (!['success', 'failed', 'refunded', 'needs_review'].includes(r.status)) throw new Error(`request ${id} still ${r.status}`);
    return r as any;
  }
}

export class FakeChain implements ChainPort {
  mandates = new Map<number, OnChainMandate>(); approvals: ApprovalInfo | null = { proposalId: 0, status: 'Approved', approvals: 3 }; council = 3; trust = new Map<string, number>();
  recordFails = 0; calls: string[] = [];
  constructor(private clock: FakeClock) {}
  add(terms: MandateTerms, tier: 'small' | 'mid' | 'large' = 'small', over: Partial<OnChainMandate> = {}) {
    const id = this.mandates.size;
    const m: OnChainMandate = { id, treasurer: terms.treasurer, terms_hash: hashJson(terms), terms_json: JSON.stringify(terms), sell_token: terms.sellToken, max_sell: terms.maxSellAmount,
      start_ns: terms.startTs * 1e9, end_ns: terms.endTs * 1e9, tier, status: 'Approved', sold: '0', chunks: 0, created_ns: 0, report_hash: null, revealed_terms: null, ...over };
    this.mandates.set(id, m); return m;
  }
  cancel(id: number) { this.mandates.get(id)!.status = 'Cancelled'; }
  async listMandates() { return [...this.mandates.values()].map((m) => ({ ...m })); }
  async getMandate(id: number) { const m = this.mandates.get(id); return m ? { ...m } : null; }
  async getTrust(t: string) { return this.trust.get(t) ?? 0; }
  async councilSize() { return this.council; }
  async findApproval() { return this.approvals; }
  private m(id: number) { return this.mandates.get(id)!; }
  async markFunded(id: number) { this.calls.push('markFunded'); if (this.m(id).status !== 'Approved') throw new Error('illegal state transition'); this.m(id).status = 'Funded'; }
  async recordChunk(id: number, idx: number, amt: string) {
    this.calls.push(`record:${idx}`);
    if (this.recordFails > 0) { this.recordFails--; throw new Error('rpc timeout'); }
    const m = this.m(id);
    if (m.status !== 'Funded' && m.status !== 'Executing') throw new Error('mandate not executable');
    const now = this.clock.now * 1e9; if (now < m.start_ns || now > m.end_ns) throw new Error('outside mandate window');
    if (idx < m.chunks) return;
    if (idx !== m.chunks) throw new Error('chunk index out of order');
    const sold = BigInt(m.sold) + BigInt(amt); if (sold > BigInt(m.max_sell)) throw new Error('exceeds mandate budget');
    m.sold = sold.toString(); m.chunks++; m.status = 'Executing';
  }
  async beginSettlement(id: number) { this.calls.push('beginSettlement'); const m = this.m(id); if (!['Funded', 'Executing'].includes(m.status)) throw new Error('illegal state transition'); m.status = 'Settling'; }
  async complete(id: number, h: string, v: number, r: string | null) { this.calls.push('complete'); const m = this.m(id); if (m.status !== 'Settling') throw new Error('illegal state transition'); m.status = 'Completed'; m.report_hash = h; m.revealed_terms = r; if (v === 0) this.trust.set(m.treasurer, (this.trust.get(m.treasurer) ?? 0) + 1); }
  async expire(id: number) { this.calls.push('expire'); this.m(id).status = 'Expired'; }
  async attackCreateAsAgent(): Promise<unknown> { throw new Error('only the DAO may call this'); }
  async attackRecord(id: number, idx: number, amt: string) { return this.recordChunk(id, idx, amt); }
}
