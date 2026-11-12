// The agent executor: turns an APPROVED on-chain mandate into hidden swap chunks, payouts, leftovers sweep and an anchored settlement report.
// Pure logic over injected ports (OutLayer, chain, clock, state) so every edge case is unit-testable; production wiring is in index.ts.
import { BOUNDS, MandateTerms } from '../src/engine/schema';
import { canonicalJson, commit, hashJson } from '../src/engine/hash';
import { Rng, cryptoRng, minAmountOut, planNextChunk } from '../src/engine/planner';
import { Fill, PriceSample, cpmmOut } from '../src/engine/benchmark';
import { PayoutResult, Report, buildReport, Leftover, OneShot } from '../src/engine/settlement';
import { OutLayerError } from '../src/near/outlayer';
import type { OnChainMandate } from '../src/near/mandate';
import { State, SettlementItem, ChunkRow } from './state';
import { GuardError, assertDestination, assertExecutable, assertPayoutTokens, assertSwap, requiredApprovals, TierConfig } from './guards';
import type { Benchmark, ChainPort, Clock, Logger, OutLayerPort, Summarizer } from './ports';

export interface ExecutorConfig {
  dao: string;
  maxChunkAttempts: number; // refunded/failed swap attempts per chunk before the mandate stops trading
  maxItemAttempts: number; // withdraw attempts per payout/return item before needs_human
  itemBackoffS: number;
  floorRetryS: number; // wait after a quote below the price floor
  endMarginS: number; // do not start a swap this close to the window end
  requestWaitMs: number;
  tier: TierConfig;
}
export const defaultConfig = (dao: string): ExecutorConfig => ({
  dao, maxChunkAttempts: 4, maxItemAttempts: 4, itemBackoffS: 30, floorRetryS: 20, endMarginS: 15, requestWaitMs: 60_000, tier: { smallMinTrust: 0 },
});

export interface PoolSnap { poolId: number; reserveIn: string; reserveOut: string; feeBps: number; ts: number }
export interface Deps {
  outlayer: OutLayerPort; chain: ChainPort; state: State; clock: Clock; rng?: Rng; benchmark?: Benchmark; summarize?: Summarizer; log?: Logger;
  /** testnet-real only: pool state read from chain before the first chunk, so the report can state what ONE swap of the same total would have returned */
  poolSnapshot?: (terms: MandateTerms) => Promise<PoolSnap | null>;
}

const big = (s: string | undefined | null) => BigInt(s ?? '0');
const pickBal = (r: { balance?: string; balances?: Array<{ token: string; balance: string }> }, token: string) =>
  big(r.balance ?? r.balances?.find((b) => b.token === token || b.token === token.replace(/^nep141:/, ''))?.balance);

export class Executor {
  private rng: Rng;
  constructor(private d: Deps, private cfg: ExecutorConfig) { this.rng = d.rng ?? cryptoRng; }

  private log(kind: string, f: Record<string, unknown> = {}) { this.d.log?.(kind, f); }
  private ev(id: number, kind: string, detail: unknown = {}) { this.d.state.event(this.d.clock.nowS(), id, kind, detail); this.log(kind, { mandate: id, ...(detail as object) }); }

  /** One pass over all on-chain mandates. Errors in one mandate never stop the others. */
  async tick(): Promise<void> {
    const all = await this.d.chain.listMandates();
    for (const m of all) {
      try { await this.advance(m, all); }
      catch (e) { this.ev(m.id, 'error', { message: (e as Error).message }); }
    }
  }

  // ------------------------------------------------------------------ terms + approval
  /** Returns validated terms, or null (and sets phase) when the mandate must not run. */
  async verify(m: OnChainMandate): Promise<MandateTerms | null> {
    const st = this.d.state; const rt = st.runtime(m.id);
    if (rt.phase === 'refused') return null;
    const refuse = (code: string, detail: string) => { st.setRuntime(m.id, { phase: 'refused', stop_reason: `${code}: ${detail}` }); this.ev(m.id, 'refused', { code, detail }); return null; };
    let raw: string | null = m.terms_json;
    let salt: string | null = null;
    if (!raw) {
      const sealed = st.loadTerms(m.terms_hash);
      if (!sealed) { this.ev(m.id, 'awaiting_terms', {}); return null; } // sealed terms not delivered yet: retry next tick
      const o = JSON.parse(sealed); raw = JSON.stringify(o.terms); salt = o.salt;
    }
    let terms: MandateTerms;
    try { terms = MandateTerms.parse(JSON.parse(raw)); } catch (e) { return refuse('terms_invalid', (e as Error).message.slice(0, 200)); }
    const okHash = salt ? commit(terms, salt) === m.terms_hash : hashJson(terms) === m.terms_hash;
    if (!okHash) return refuse('terms_hash_mismatch', 'terms do not match the on-chain hash');
    if (terms.dao !== this.cfg.dao) return refuse('wrong_dao', `terms.dao ${terms.dao}`);
    if (terms.sellToken !== m.sell_token || big(terms.maxSellAmount) !== big(m.max_sell)) return refuse('terms_mismatch', 'terms disagree with chain fields');
    if (terms.startTs * 1e9 !== m.start_ns || terms.endTs * 1e9 !== m.end_ns) return refuse('window_mismatch', 'terms window differs from chain');
    try { assertPayoutTokens(terms); } catch (e) { return refuse((e as GuardError).code, (e as Error).message); }
    if (rt.phase === 'new' || rt.phase === 'awaiting_approval') {
      const ap = await this.d.chain.findApproval(m);
      if (!ap || ap.status !== 'Approved') { st.setRuntime(m.id, { phase: 'awaiting_approval' }); this.ev(m.id, 'awaiting_approval', { found: !!ap }); return null; }
      const [n, trust] = await Promise.all([this.d.chain.councilSize(), this.d.chain.getTrust(m.treasurer)]);
      const need = requiredApprovals(m.tier, n, trust, this.cfg.tier);
      if (ap.approvals < need) { // tier rule: refuse, do not wait forever on the same proposal
        st.setRuntime(m.id, { phase: 'awaiting_approval' }); this.ev(m.id, 'tier_refusal', { tier: m.tier, have: ap.approvals, need, trust });
        return null;
      }
      st.setRuntime(m.id, { phase: 'verified' }); this.ev(m.id, 'verified', { tier: m.tier, approvals: ap.approvals, need, trust });
    }
    return terms;
  }

  // ------------------------------------------------------------------ main state machine
  async advance(m0: OnChainMandate, all: OnChainMandate[] = [m0]): Promise<void> {
    const st = this.d.state; const now = this.d.clock.nowS();
    let rt = st.runtime(m0.id);
    if (rt.phase === 'done') return;
    const m = (await this.d.chain.getMandate(m0.id)) ?? m0; // fresh status = kill-switch check on every pass

    if (m.status === 'Completed') { st.setRuntime(m.id, { phase: 'done' }); return; }
    if (m.status === 'Expired') { st.setRuntime(m.id, { phase: 'done' }); return; }
    const terms = await this.verify(m);
    if (!terms) return;
    rt = st.runtime(m.id);

    if (m.status === 'Cancelled') return this.returnAllAfterCancel(m, terms);
    if (m.status === 'Settling') return this.settle(m, terms);

    if (m.status === 'Approved') {
      if (now * 1e9 > m.end_ns) { await this.d.chain.expire(m.id); this.ev(m.id, 'expired_unfunded', {}); st.setRuntime(m.id, { phase: 'done' }); return; }
      if (!(await this.ensureFunded(m, terms, all))) return;
      await this.d.chain.markFunded(m.id); this.ev(m.id, 'funded', {});
      return;
    }
    // Funded | Executing
    if (rt.next_at > now) return;
    await this.tradeStep(m, terms);
  }

  // ------------------------------------------------------------------ funding
  private async ensureFunded(m: OnChainMandate, terms: MandateTerms, all: OnChainMandate[]): Promise<boolean> {
    const reserved = all.filter((o) => o.id !== m.id && o.sell_token === m.sell_token && (o.status === 'Funded' || o.status === 'Executing'))
      .reduce((s, o) => s + (big(o.max_sell) - big(o.sold)), 0n);
    const need = big(m.max_sell) + reserved;
    const conf = pickBal(await this.d.outlayer.confidentialBalance(m.sell_token), m.sell_token);
    if (conf >= need) return true;
    const pub = big((await this.d.outlayer.intentsBalance(m.sell_token)).balance);
    if (pub + conf >= need) {
      const toShield = need - conf;
      const r = await this.d.outlayer.confidentialShield({ token: m.sell_token, amount: toShield.toString() }, `${m.id}:shield`);
      this.ev(m.id, 'shield_submitted', { request: r.request_id, amount: toShield.toString() });
      const rec = await this.waitSafe(r.request_id);
      if (rec?.status === 'success') return (pickBal(await this.d.outlayer.confidentialBalance(m.sell_token), m.sell_token)) >= need;
      return false;
    }
    this.ev(m.id, 'awaiting_funds', { need: need.toString(), confidential: conf.toString(), public: pub.toString() });
    return false;
  }

  private async waitSafe(requestId: string) {
    try { return await this.d.outlayer.waitForRequest(requestId, { timeoutMs: this.cfg.requestWaitMs, sleep: (ms) => this.d.clock.sleep(ms) }); }
    catch (e) { this.ev(0, 'request_pending', { requestId, message: (e as Error).message.slice(0, 160) }); return null; }
  }

  // ------------------------------------------------------------------ trading
  private async tradeStep(m: OnChainMandate, terms: MandateTerms): Promise<void> {
    const st = this.d.state; const now = this.d.clock.nowS();
    const idx = m.chunks;
    let c = st.chunk(m.id, idx);
    const remaining = big(m.max_sell) - big(m.sold);

    if (c && c.status === 'success' && !c.recorded) return this.record(m, c);
    if (c && (c.status === 'planned' || c.status === 'submitted')) return this.submitAndSettleChunk(m, terms, c, remaining);
    if (c && (c.status === 'failed' || c.status === 'refunded')) {
      if (c.attempt + 1 >= this.cfg.maxChunkAttempts) { st.setRuntime(m.id, { stop_reason: `chunk ${idx} failed ${c.attempt + 1} times` }); this.ev(m.id, 'too_many_failures', { idx }); return this.beginSettle(m, 'too_many_failures'); }
      const next: ChunkRow = { ...c, attempt: c.attempt + 1, idem_key: `${m.id}:${idx}:${c.attempt + 1}`, status: 'planned', request_id: null, intent_hash: null, amount_out: null, recorded: 0, note: null };
      st.putChunk(next); return; // new idempotency key; the failed attempt never counted toward the budget
    }

    const plan = planNextChunk(terms, now, remaining, this.rng);
    if (plan.kind === 'done') return this.beginSettle(m, plan.reason);
    if (plan.kind === 'wait') { st.setRuntime(m.id, { next_at: now + plan.waitS }); return; }
    if (now + this.cfg.endMarginS * 1 > terms.endTs) return this.beginSettle(m, 'window_closing');
    try { assertExecutable(m, now); assertSwap(terms, remaining, { tokenIn: terms.sellToken, tokenOut: terms.buyToken, amountIn: plan.size }); }
    catch (e) { st.addViolation(m.id, (e as GuardError).code ?? 'guard', (e as Error).message); this.ev(m.id, 'guard_blocked', { message: (e as Error).message }); return; }

    await this.sample(m.id, terms);
    if (idx === 0 && this.d.poolSnapshot && !this.baseline(m.id)) {
      try { const snap = await this.d.poolSnapshot(terms); if (snap) this.ev(m.id, 'oneshot_baseline', snap); }
      catch (e) { this.ev(m.id, 'baseline_error', { message: (e as Error).message.slice(0, 120) }); }
    }
    const minOut = this.minOut(terms, plan.size);
    let q;
    try { q = await this.d.outlayer.confidentialSwapQuote({ token_in: terms.sellToken, token_out: terms.buyToken, amount_in: plan.size.toString() }); }
    catch (e) { return this.outlayerError(m, e); }
    const quoted = q.amount_out ? big(q.amount_out) : 0n;
    if (!q.amount_out || quoted < minOut) { // price floor: no trade, try again later
      const rtn = st.runtime(m.id);
      st.setRuntime(m.id, { floor_misses: rtn.floor_misses + 1, next_at: now + this.cfg.floorRetryS });
      this.ev(m.id, 'floor_not_met', { size: plan.size.toString(), quoted: quoted.toString(), minOut: minOut.toString() });
      return;
    }
    const row: ChunkRow = { mandate_id: m.id, idx, attempt: 0, idem_key: `${m.id}:${idx}:0`, size: plan.size.toString(), status: 'planned', request_id: null, intent_hash: null,
      quote_out: quoted.toString(), amount_out: null, min_out: minOut.toString(), ts: now, recorded: 0, note: null };
    st.putChunk(row);
    st.setRuntime(m.id, { next_at: 0 });
    c = row;
    return this.submitAndSettleChunk(m, terms, c, remaining);
  }

  private baseline(id: number): PoolSnap | null {
    const e = this.d.state.events(id).find((x) => x.kind === 'oneshot_baseline');
    return e ? (JSON.parse(e.detail) as PoolSnap) : null;
  }

  private minOut(terms: MandateTerms, size: bigint) {
    return minAmountOut(size, terms.minPrice, BOUNDS.allowedTokens[terms.sellToken].decimals, BOUNDS.allowedTokens[terms.buyToken].decimals);
  }

  private async submitAndSettleChunk(m: OnChainMandate, terms: MandateTerms, c: ChunkRow, remaining: bigint): Promise<void> {
    const st = this.d.state; const now = this.d.clock.nowS();
    const size = big(c.size);
    if (c.status === 'planned') {
      try { assertExecutable(m, now); assertSwap(terms, remaining, { tokenIn: terms.sellToken, tokenOut: terms.buyToken, amountIn: size }); }
      catch (e) { st.addViolation(m.id, (e as GuardError).code ?? 'guard', (e as Error).message); this.ev(m.id, 'guard_blocked', { message: (e as Error).message }); st.patchChunk(m.id, c.idx, { status: 'failed', note: 'blocked by guard' }); return; }
      try {
        const r = await this.d.outlayer.confidentialSwap({ token_in: terms.sellToken, token_out: terms.buyToken, amount_in: c.size, min_amount_out: c.min_out ?? undefined }, c.idem_key);
        st.patchChunk(m.id, c.idx, { status: 'submitted', request_id: r.request_id, intent_hash: r.intent_hash ?? null });
        c = { ...c, status: 'submitted', request_id: r.request_id, intent_hash: r.intent_hash ?? null };
        this.ev(m.id, 'chunk_submitted', { idx: c.idx, attempt: c.attempt, request: r.request_id });
      } catch (e) {
        if (e instanceof OutLayerError && e.kind === 'bad_request' && /min_amount_out|below/i.test(String((e.body as any)?.message ?? ''))) {
          st.db.prepare('DELETE FROM chunks WHERE mandate_id=? AND idx=?').run(m.id, c.idx); // quote moved below the floor between quote and swap: replan later
          st.setRuntime(m.id, { next_at: now + this.cfg.floorRetryS }); this.ev(m.id, 'floor_not_met', { at: 'swap' }); return;
        }
        return this.outlayerError(m, e);
      }
    }
    if (!c.request_id) return;
    let rec: { status: string; result?: Record<string, any> } | null;
    try { rec = await this.d.outlayer.waitForRequest(c.request_id, { timeoutMs: this.cfg.requestWaitMs, sleep: (ms) => this.d.clock.sleep(ms) }); }
    catch { rec = await this.d.outlayer.request(c.request_id).catch(() => null); }
    if (!rec || !['success', 'failed', 'refunded', 'needs_review'].includes(rec.status)) return; // still processing: poll again next tick, NEVER resubmit
    if (rec.status === 'needs_review') { this.ev(m.id, 'chunk_needs_review', { idx: c.idx, request: c.request_id }); st.setRuntime(m.id, { next_at: now + 60 }); return; }
    if (rec.status !== 'success') { st.patchChunk(m.id, c.idx, { status: rec.status as 'failed' | 'refunded' }); this.ev(m.id, 'chunk_' + rec.status, { idx: c.idx, attempt: c.attempt }); return; }
    const out = rec.result?.amount_out ? big(String(rec.result.amount_out)) : null;
    const amountOut = out ?? big(c.quote_out); // docs: realised fill only at success; fall back to quote and say so
    st.patchChunk(m.id, c.idx, { status: 'success', amount_out: amountOut.toString(), note: out === null ? 'amount_out missing in response; quote used' : null });
    if (amountOut < big(c.min_out)) st.addViolation(m.id, 'floor_breach', `chunk ${c.idx} filled ${amountOut} < floor ${c.min_out}`);
    this.ev(m.id, 'chunk_success', { idx: c.idx, in: c.size, out: amountOut.toString() });
    return this.record(m, { ...c, status: 'success', amount_out: amountOut.toString() });
  }

  private async record(m: OnChainMandate, c: ChunkRow): Promise<void> {
    const st = this.d.state; const now = this.d.clock.nowS();
    try { await this.d.chain.recordChunk(m.id, c.idx, c.size); }
    catch (e) { this.ev(m.id, 'record_failed', { idx: c.idx, message: (e as Error).message.slice(0, 200) }); return; } // retried next tick (contract is idempotent)
    st.patchChunk(m.id, c.idx, { recorded: 1 });
    const t = await this.verifyCached(m); const span = t ? t.intervalMaxS - t.intervalMinS : 0;
    st.setRuntime(m.id, { next_at: now + (t?.intervalMinS ?? 5) + this.rng.below(span + 1) });
  }
  private async verifyCached(m: OnChainMandate) { return this.verify(m); }

  private async outlayerError(m: OnChainMandate, e: unknown) {
    const st = this.d.state; const now = this.d.clock.nowS();
    if (e instanceof OutLayerError) {
      if (e.kind === 'policy_denied' || e.kind === 'wallet_frozen') { st.setRuntime(m.id, { stop_reason: `wallet: ${e.kind}`, next_at: now + 3600 }); this.ev(m.id, 'wallet_blocked', { kind: e.kind }); return; }
      if (e.kind === 'operation_limit_reached') { st.setRuntime(m.id, { next_at: now + (e.retryAfterS ?? 300) }); this.ev(m.id, 'rate_limited', { retryAfterS: e.retryAfterS }); return; }
      if (e.kind === 'confidential_unavailable') { st.setRuntime(m.id, { stop_reason: 'confidential_unavailable', next_at: now + 600 }); this.ev(m.id, 'confidential_unavailable', {}); return; }
    }
    this.ev(m.id, 'outlayer_error', { message: (e as Error).message.slice(0, 200) });
    st.setRuntime(m.id, { next_at: now + 10 });
  }

  private async sample(id: number, terms: MandateTerms) {
    if (!this.d.benchmark) return;
    try { const s = await this.d.benchmark(terms, this.d.clock.nowS()); if (s) this.d.state.addSample(id, s.ts, s.price, s.origin, s.source); }
    catch (e) { this.ev(id, 'benchmark_error', { message: (e as Error).message.slice(0, 120) }); }
  }

  // ------------------------------------------------------------------ settlement
  private async beginSettle(m: OnChainMandate, reason: string) {
    await this.d.chain.beginSettlement(m.id);
    this.d.state.setRuntime(m.id, { phase: 'settling' }); this.ev(m.id, 'settling', { reason });
  }

  private fills(id: number): Fill[] {
    return this.d.state.chunks(id).filter((c) => c.status === 'success').map((c) => ({
      index: c.idx, ts: c.ts, amountIn: c.size, amountOut: c.amount_out ?? '0', requestId: c.request_id ?? '', intentHash: c.intent_hash ?? undefined, source: srcOf(c.request_id) }));
  }

  private planItems(m: OnChainMandate, terms: MandateTerms, mode: 'normal' | 'cancel') {
    const st = this.d.state; if (st.items(m.id).length) return;
    const fills = this.fills(m.id);
    const sold = fills.reduce((s, f) => s + big(f.amountIn), 0n);
    const proceeds = fills.reduce((s, f) => s + big(f.amountOut), 0n);
    const fee = mode === 'normal' && terms.feeRecipient ? (proceeds * BigInt(terms.feeBps)) / 10_000n : 0n;
    const net = proceeds - fee;
    let avail = net;
    const mk = (key: string, kind: SettlementItem['kind'], label: string, chain: string, address: string, token: string, amount: bigint, note?: string) => {
      assertDestination(terms, chain, address);
      if (amount > 0n) st.putItem({ mandate_id: m.id, key, kind, label, chain, address, token, amount: amount.toString(), status: 'pending', note: note ?? null });
    };
    if (fee > 0n) mk('fee', 'fee', 'service fee', 'near', terms.feeRecipient!, terms.buyToken, fee);
    if (mode === 'normal') {
      terms.payouts.forEach((p, i) => {
        const want = p.amount !== undefined ? big(p.amount) : (net * BigInt(Math.round((p.percent ?? 0) * 100))) / 10_000n;
        const pay = want > avail ? avail : want;
        avail -= pay;
        mk(`payout:${i}`, 'payout', p.label, p.chain, p.address, p.token, pay, pay < want ? `shortfall: wanted ${want}` : undefined);
      });
    }
    mk('return_buy', 'return_buy', 'leftover proceeds -> returnTo', 'near', terms.returnTo, terms.buyToken, avail);
    mk('return_sell', 'return_sell', 'unspent budget -> returnTo', 'near', terms.returnTo, terms.sellToken, big(m.max_sell) - sold);
  }

  private async processItems(m: OnChainMandate): Promise<'done' | 'pending' | 'stuck'> {
    const st = this.d.state; const now = this.d.clock.nowS();
    let stuck = false, pending = false;
    for (const it of st.items(m.id)) {
      if (it.status === 'success') continue;
      if (it.status === 'needs_review') { stuck = true; continue; }
      if (it.next_try_at > now) { pending = true; continue; }
      try {
        const r = await this.d.outlayer.confidentialWithdraw({ chain: it.chain, to: it.address, amount: it.amount, token: it.token }, `${m.id}:${it.key}:${it.attempts}`);
        st.patchItem(m.id, it.key, { status: 'submitted', request_id: r.request_id });
        const rec = await this.waitSafe(r.request_id);
        if (!rec) { pending = true; continue; }
        if (rec.status === 'success') { st.patchItem(m.id, it.key, { status: 'success', dest_tx: firstTx(rec.result) }); this.ev(m.id, 'item_paid', { key: it.key }); continue; }
        if (rec.status === 'needs_review') { st.patchItem(m.id, it.key, { status: 'submitted' }); pending = true; continue; }
        throw new Error(`withdraw ${rec.status}`);
      } catch (e) {
        const attempts = it.attempts + 1;
        const give = attempts >= this.cfg.maxItemAttempts;
        st.patchItem(m.id, it.key, { attempts, status: give ? 'needs_review' : 'failed', next_try_at: now + this.cfg.itemBackoffS * attempts, note: (e as Error).message.slice(0, 160) });
        this.ev(m.id, give ? 'needs_human' : 'item_retry', { key: it.key, attempts, message: (e as Error).message.slice(0, 160) });
        if (give) stuck = true; else pending = true;
      }
    }
    return stuck ? 'stuck' : pending ? 'pending' : 'done';
  }

  private async settle(m: OnChainMandate, terms: MandateTerms): Promise<void> {
    const st = this.d.state;
    // a "failed" item re-enters via next_try_at; normalise status so it is retried
    this.planItems(m, terms, 'normal');
    for (const it of st.items(m.id)) if (it.status === 'failed') st.patchItem(m.id, it.key, { status: 'pending' });
    const res = await this.processItems(m);
    if (res !== 'done') return; // stays Settling; 'stuck' is surfaced by /api and events (needs_human)
    const report = await this.report(m, terms, true);
    const sealedReveal = m.terms_json ? null : JSON.stringify({ salt: JSON.parse(st.loadTerms(m.terms_hash)!).salt, terms });
    await this.d.chain.complete(m.id, report.reportHash, report.violations.length, sealedReveal);
    st.setRuntime(m.id, { phase: 'done' }); this.ev(m.id, 'completed', { reportHash: report.reportHash });
  }

  /** DAO cancelled: stop, give everything back to returnTo, keep a local report (the contract cannot anchor reports for Cancelled). */
  private async returnAllAfterCancel(m: OnChainMandate, terms: MandateTerms): Promise<void> {
    const st = this.d.state;
    if (!(await this.resolveInflight(m))) return; // a swap already submitted must reach a terminal state first so its proceeds are returned too
    this.planItems(m, terms, 'cancel');
    for (const it of st.items(m.id)) if (it.status === 'failed') st.patchItem(m.id, it.key, { status: 'pending' });
    const res = await this.processItems(m);
    if (res !== 'done') return;
    const report = await this.report(m, terms, false);
    st.setRuntime(m.id, { phase: 'done', stop_reason: 'cancelled by DAO' }); this.ev(m.id, 'cancelled_returned', { reportHash: report.reportHash });
  }

  private async resolveInflight(m: OnChainMandate): Promise<boolean> {
    const st = this.d.state; let clear = true;
    for (const c of st.chunks(m.id)) {
      if (c.status === 'planned') { st.patchChunk(m.id, c.idx, { status: 'failed', note: 'cancelled before submit' }); continue; }
      if (c.status !== 'submitted' || !c.request_id) continue;
      const rec = await this.d.outlayer.request(c.request_id).catch(() => null);
      if (!rec || !['success', 'failed', 'refunded'].includes(rec.status)) { clear = false; continue; }
      if (rec.status === 'success') st.patchChunk(m.id, c.idx, { status: 'success', amount_out: String(rec.result?.amount_out ?? c.quote_out ?? '0') });
      else st.patchChunk(m.id, c.idx, { status: rec.status as 'failed' | 'refunded' });
    }
    return clear;
  }

  private async report(m: OnChainMandate, terms: MandateTerms, anchored: boolean): Promise<Report> {
    const st = this.d.state;
    const items = st.items(m.id);
    const payouts: PayoutResult[] = items.filter((i) => i.kind === 'payout').map((i) => ({ label: i.label, chain: i.chain, address: i.address, token: i.token, amount: i.amount,
      status: i.status === 'success' ? 'success' : 'needs_review', requestId: i.request_id ?? undefined, destTxHash: i.dest_tx ?? undefined, source: srcOf(i.request_id) }));
    const leftovers: Leftover[] = items.filter((i) => i.kind.startsWith('return')).map((i) => ({ token: i.token, amount: i.amount, returnedTo: i.address, txRef: i.request_id ?? undefined, source: srcOf(i.request_id) }));
    const fee = items.find((i) => i.kind === 'fee');
    const samples: PriceSample[] = st.samples(m.id).map((s) => ({ ts: s.ts, price: s.price, origin: s.origin, source: s.source }));
    const fills = this.fills(m.id);
    let oneShot: OneShot | undefined;
    const base = this.baseline(m.id);
    if (base && fills.length) { // what one swap of the same total would have returned from the pool state recorded before our first chunk
      const soldTotal = fills.reduce((s, f) => s + big(f.amountIn), 0n), got = fills.reduce((s, f) => s + big(f.amountOut), 0n);
      const one = cpmmOut(big(base.reserveIn), big(base.reserveOut), soldTotal, base.feeBps);
      oneShot = { amountOut: one.toString(), poolId: base.poolId, reserveIn: base.reserveIn, reserveOut: base.reserveOut, feeBps: base.feeBps, snapshotTs: base.ts,
        chunkedVsOneShotBps: one === 0n ? null : Number(((got - one) * 10_000n) / one), source: 'chain' };
    }
    const input = { mandateId: m.id, terms, fills, samples, payouts, feeAmount: fee && fee.status === 'success' ? fee.amount : '0', feeSource: fee ? srcOf(fee.request_id) : ('api' as const),
      leftovers, violations: st.violations(m.id), generatedAt: new Date(this.d.clock.nowS() * 1000).toISOString(), oneShot };
    let aiSummary; try { aiSummary = this.d.summarize ? await this.d.summarize(buildReport(input)) : undefined; } catch (e) { this.ev(m.id, 'summary_error', { message: (e as Error).message.slice(0, 120) }); }
    const report = buildReport({ ...input, aiSummary });
    st.saveReport(m.id, { ...report, anchored });
    return report;
  }
}

/** Receipts produced by the testnet simulated adapter carry request ids prefixed sim-; they must never be presented as real fills. */
const srcOf = (requestId: string | null | undefined): 'api' | 'simulated' | 'chain' => {
  const r = String(requestId ?? '');
  if (r.startsWith('sim-')) return 'simulated';
  return /^[1-9A-HJ-NP-Za-km-z]{42,45}$/.test(r) ? 'chain' : 'api'; // a NEAR transaction hash = read straight from the chain (testnet-real adapter)
};

function firstTx(result: Record<string, any> | undefined): string | null {
  const h = result?.swap_details?.destinationChainTxHashes;
  return Array.isArray(h) && h.length ? String(h[0]) : null;
}
export { canonicalJson };


