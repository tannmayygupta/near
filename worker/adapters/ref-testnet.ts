// ===================== REAL TESTNET EXECUTION ADAPTER (Ref Finance, public NEAR testnet) =====================
// EXEC_MODE=testnet-real. Every swap, payout, fee and leftover return made through this adapter is a REAL on-chain testnet transaction:
//   chunk  = near_deposit (wrap) -> ft_transfer_call to ref-finance-101.testnet with a swap action -> withdraw the output from Ref
//   payout = ft_transfer of the buy token (USDT.e) to a named NEAR testnet account (storage-registered by the vault when needed)
//   return = native NEAR transfer (unwrapping wNEAR first if needed)
// Receipts carry the REAL transaction hashes (request_id = swap tx hash). Nothing here is simulated.
// HONEST LIMITS: (1) custody is a key held by the worker (the vault account); OutLayer's TEE custody + wallet policy + confidential swaps are the
// MAINNET design and are NOT used on this path. (2) Ref testnet pools are thin and have no arbitrageurs, so chunking does not beat a one-shot swap
// (a constant-product AMM is path independent); the report shows that comparison instead of claiming a gain.
// The OutLayerPort method names (confidential*) are kept so the executor is unchanged; on testnet there is no confidentiality.
import type { Account } from 'near-api-js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { KeySigner, type ChainSigner } from './signers';
import type { MandatePolicy } from './mandate-policy';
import { RefPriceGuard, inBand } from './price-guard';
import type { MandateTerms } from '../../src/engine/schema';
import { dirname } from 'node:path';
import { OutLayerError } from '../../src/near/outlayer';
import type { ActionResponse, QuotePreview, RequestRecord, TerminalStatus } from '../../src/near/outlayer';
import { providerFor, TGAS, view } from '../../src/near/chain';
import { cpmmOut } from '../../src/engine/benchmark';
import type { PriceSample } from '../../src/engine/benchmark';
export { cpmmOut };
import type { OutLayerPort } from '../ports';

export const REF_DEX = 'ref-finance-101.testnet';
export const WRAP = 'wrap.testnet';
const STORAGE_FT = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR: NEP-145 registration on wrap/usdt fakes
const REF_STORAGE = 10_000_000_000_000_000_000_000n; // 0.01 NEAR: Ref account registration (min is 0.00102)
const ONE_YOCTO = 1n;
export const isTxHash = (s: string | null | undefined) => /^[1-9A-HJ-NP-Za-km-z]{42,45}$/.test(String(s ?? ''));
const bare = (token: string) => token.replace(/^nep141:/, '');

export interface PoolSnapshot { poolId: number; tokenIn: string; tokenOut: string; reserveIn: string; reserveOut: string; feeBps: number; ts: number; source: 'chain' }
interface Candidate { id: number; tokens: string[]; amounts: string[]; fee: number }

type Stage = 'start' | 'wrapped' | 'swapped' | 'done' | 'refunded';
interface LedgerEntry { idem: string; kind: 'swap' | 'withdraw'; stage: Stage; pool?: number; swapTx?: string; withdrawTx?: string; wrapTx?: string; amountIn?: string; amountOut?: string; balBefore?: string; requestId?: string; record?: RequestRecord; ts: number }

export interface RefOpts {
  /** who signs: pass `vault` (a key the worker holds) OR `signer` (e.g. an OutLayer custody wallet) */
  vault?: Account;
  signer?: ChainSigner;
  /** OutLayer custody only: writes the wallet policy (Layer A) for each mandate before it trades */
  policy?: MandatePolicy;
  rpc: string;
  dex?: string;
  /** native NEAR kept for gas/storage and NOT counted as budget (the DAO funding transfer is what raises the budget above this) */
  reserveYocto: bigint;
  ledgerPath?: string;
  /** sanity reference: price of 1 wNEAR in the stable token from a MAINNET quote; pools outside [lo, hi] x this price are ignored (absurd test pools) */
  refPrice?: () => Promise<number | null>;
  band?: [number, number];
  log?: (kind: string, fields: Record<string, unknown>) => void;
}

export class RefTestnetAdapter implements OutLayerPort {
  private dex: string;
  private ledger: Record<string, LedgerEntry> = {};
  /** gas burnt + storage deposits paid by the vault itself: added back so that only DAO-funded NEAR counts as budget */
  private spent = 0n;
  private setupDone = false;
  private cand: { at: number; list: Candidate[]; key: string } | null = null;
  readonly signer: ChainSigner;
  private guard: RefPriceGuard | null;
  constructor(private o: RefOpts) {
    this.guard = o.refPrice ? new RefPriceGuard({ fetch: o.refPrice }) : null;
    if (!o.signer && !o.vault) throw new Error('RefTestnetAdapter needs a signer or a vault account');
    this.signer = o.signer ?? new KeySigner(o.vault!);
    this.dex = o.dex ?? REF_DEX;
    if (o.ledgerPath && existsSync(o.ledgerPath)) {
      try { const j = JSON.parse(readFileSync(o.ledgerPath, 'utf8')); this.ledger = j.entries ?? {}; this.spent = BigInt(j.spent ?? '0'); this.setupDone = !!j.setupDone; } catch { this.ledger = {}; }
    }
  }
  get vaultId() { return this.signer.id; }
  get custody() { return this.signer.kind; }
  /** native NEAR held by the vault (gas/storage float + any unspent budget), for the monitor */
  native(): Promise<bigint> { return this.nativeBalance(); }
  /** Called by the executor once a mandate is funded and BEFORE its first trade: with OutLayer custody this writes the mandate's wallet policy (Layer A). */
  async prepareMandate(mandateId: number, terms: MandateTerms): Promise<{ policyTx?: string; reused?: boolean }> {
    if (!this.o.policy) return {};
    const p = await this.o.policy.ensure(mandateId, terms);
    if (!p.reused) await new Promise((r) => setTimeout(r, 4000)); // the keystore reads the policy from the chain: give the store tx a moment to be final
    return { policyTx: p.txHash, reused: p.reused };
  }
  private log(kind: string, f: Record<string, unknown> = {}) { this.o.log?.(kind, f); }
  private save() { if (!this.o.ledgerPath) return; mkdirSync(dirname(this.o.ledgerPath), { recursive: true }); writeFileSync(this.o.ledgerPath, JSON.stringify({ spent: this.spent.toString(), setupDone: this.setupDone, entries: this.ledger }, null, 2)); }
  private put(e: LedgerEntry) { this.ledger[e.idem] = e; this.save(); return e; }

  // ------------------------------------------------------------------ chain helpers
  private async nativeBalance(): Promise<bigint> { return BigInt((await providerFor(this.o.rpc).viewAccount({ accountId: this.vaultId })).amount); }
  private async ftBalance(token: string, account = this.vaultId): Promise<bigint> { return BigInt(await view<string>(this.o.rpc, token, 'ft_balance_of', { account_id: account })); }
  private async registered(token: string, account: string): Promise<boolean> { return (await view<unknown>(this.o.rpc, token, 'storage_balance_of', { account_id: account })) !== null; }

  /** NEAR the vault holds that is DAO-funded budget (not the gas float): native - reserve + everything the vault itself spent on gas/registrations. */
  private async freeNative(): Promise<bigint> {
    const nat = await this.nativeBalance(); const f = nat + this.spent;
    if (f <= this.o.reserveYocto) return 0n;
    // gas accounting is exact to ~10 yocto but not to the yocto (observed: a 0.3 NEAR funding read 11 yocto short); forgive up to 1e15 yocto (0.001 NEAR) once anything has been funded
    const free = f - this.o.reserveYocto;
    return free > 1_000_000_000_000n ? free + 1_000_000_000_000_000n : free;
  }
  /** cost = part of deposit that is a real expense (storage registration), not budget moving around. */
  private async call(contract: string, method: string, args: object, gas: bigint, deposit = 0n, cost = 0n, idem?: string) {
    const r = await this.signer.call(contract, method, args, gas, deposit, idem);
    this.spent += r.burnt + cost; this.save();
    this.log('tx', { contract, method, hash: r.hash, custody: this.signer.kind });
    return { hash: r.hash, logs: r.logs, value: r.value };
  }
  private async sendNative(to: string, amount: bigint, idem?: string) {
    const r = await this.signer.sendNative(to, amount, idem);
    this.spent += r.burnt; this.save();
    this.log('tx', { contract: to, method: 'transfer', hash: r.hash, custody: this.signer.kind });
    return r.hash;
  }

  /** One-time registrations (idempotent: each step is skipped when already done). */
  async ensureSetup(tokens: string[]) {
    if (this.setupDone) return;
    const v = this.vaultId;
    for (const t of tokens) if (!(await this.registered(t, v))) await this.call(t, 'storage_deposit', { account_id: v, registration_only: true }, TGAS(30), STORAGE_FT, STORAGE_FT);
    const refReg = await view<unknown>(this.o.rpc, this.dex, 'storage_balance_of', { account_id: v });
    if (refReg === null) await this.call(this.dex, 'storage_deposit', { account_id: v, registration_only: false }, TGAS(30), REF_STORAGE, REF_STORAGE);
    await this.call(this.dex, 'register_tokens', { token_ids: tokens }, TGAS(30), ONE_YOCTO);
    this.setupDone = true; this.save();
  }

  // ------------------------------------------------------------------ pool selection (real reads, sanity-checked)
  private async candidates(a: string, b: string): Promise<Candidate[]> {
    const key = [a, b].sort().join('|');
    if (this.cand && this.cand.key === key && Date.now() - this.cand.at < 10 * 60_000) return this.cand.list;
    const n = await view<number>(this.o.rpc, this.dex, 'get_number_of_pools');
    const list: Candidate[] = [];
    for (let from = 0; from < n; from += 300) {
      const page = await view<any[]>(this.o.rpc, this.dex, 'get_pools', { from_index: from, limit: 300 });
      page.forEach((p, i) => { const t: string[] = p.token_account_ids; if (t.length === 2 && t.includes(a) && t.includes(b) && p.pool_kind === 'SIMPLE_POOL' && p.amounts.every((x: string) => BigInt(x) > 0n)) list.push({ id: from + i, tokens: t, amounts: p.amounts, fee: p.total_fee }); });
    }
    this.cand = { at: Date.now(), list, key };
    return list;
  }
  private reserves(c: Candidate, tokenIn: string) { const i = c.tokens.indexOf(tokenIn); return { rIn: BigInt(c.amounts[i]), rOut: BigInt(c.amounts[1 - i]) }; }

  /** Best sane pool for this trade. Sanity band is applied to wNEAR->stable pairs only (needs a mainnet reference price). */
  async bestPool(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<{ id: number; out: bigint; feeBps: number }> {
    // prefilter on the cached scan (cheap), then re-read only the few deepest pools: reserves change, so the decision uses fresh state
    const pre = (await this.candidates(tokenIn, tokenOut)).filter((c) => this.reserves(c, tokenIn).rIn >= amountIn * 3n)
      .sort((x, y) => (this.reserves(y, tokenIn).rIn > this.reserves(x, tokenIn).rIn ? 1 : -1)).slice(0, 6);
    const fresh: Candidate[] = [];
    for (const c of pre) {
      const g = await view<any>(this.o.rpc, this.dex, 'get_pool', { pool_id: c.id }).catch(() => null);
      if (g) fresh.push({ ...c, amounts: g.amounts, fee: g.total_fee });
    }
    // FAIL CLOSED: if a reference price is configured but unavailable (and no recent good one exists) the band cannot be applied, so we do not trade at all
    let ref: number | null = null;
    if (tokenIn === WRAP && this.guard) { try { ref = await this.guard.get(); } catch (e) { throw new OutLayerError('upstream', 503, { message: (e as Error).message }); } }
    const [lo, hi] = this.o.band ?? [0.2, 5];
    let best: { id: number; out: bigint; feeBps: number } | null = null;
    for (const c of fresh) {
      const { rIn, rOut } = this.reserves(c, tokenIn);
      if (rIn < amountIn * 5n) continue; // too thin for this trade
      if (ref !== null) { const spot = Number(rOut) / 1e6 / (Number(rIn) / 1e24); if (!inBand(spot, ref, [lo, hi])) continue; } // absurd test pool
      const out = BigInt(await view<string>(this.o.rpc, this.dex, 'get_return', { pool_id: c.id, token_in: tokenIn, amount_in: amountIn.toString(), token_out: tokenOut }));
      if (!best || out > best.out) best = { id: c.id, out, feeBps: c.fee };
    }
    if (!best) throw new OutLayerError('bad_request', 400, { message: 'no sane Ref testnet pool with enough liquidity for this trade' });
    return best;
  }

  /** Pool state snapshot (source chain) used for the one-shot baseline in the report. */
  async poolSnapshot(tokenIn: string, tokenOut: string, probe: bigint): Promise<PoolSnapshot | null> {
    const a = bare(tokenIn), b = bare(tokenOut);
    try {
      const p = await this.bestPool(a, b, probe);
      const g = await view<any>(this.o.rpc, this.dex, 'get_pool', { pool_id: p.id });
      const i = g.token_account_ids.indexOf(a);
      return { poolId: p.id, tokenIn: a, tokenOut: b, reserveIn: g.amounts[i], reserveOut: g.amounts[1 - i], feeBps: g.total_fee, ts: Math.floor(Date.now() / 1000), source: 'chain' };
    } catch { return null; }
  }
  /** Spot price sample (buy per 1 sell, human) from the pool itself: the benchmark a thin AMM trade should be measured against. */
  async spotSample(tokenIn: string, tokenOut: string, sd: number, bd: number): Promise<PriceSample | null> {
    const snap = await this.poolSnapshot(tokenIn, tokenOut, 10n ** BigInt(sd - 3));
    if (!snap) return null;
    return { ts: snap.ts, price: (Number(snap.reserveOut) / 10 ** bd) / (Number(snap.reserveIn) / 10 ** sd), source: 'chain', origin: `ref pool #${snap.poolId} spot` };
  }

  // ------------------------------------------------------------------ OutLayerPort
  async intentsBalance(_token: string) { return { balance: '0' }; } // no Intents on testnet
  /** "Budget balance": what the DAO funded. For wNEAR = vault native NEAR above the gas reserve + wNEAR held; for other tokens the ft balance. */
  async confidentialBalance(token?: string) {
    const t = bare(token ?? '');
    if (t === WRAP) return { balance: ((await this.freeNative()) + (await this.ftBalance(WRAP))).toString() };
    return { balance: (await this.ftBalance(t)).toString() };
  }
  async confidentialShield(_b: { token: string; amount: string }, _idem: string): Promise<ActionResponse> { throw new OutLayerError('confidential_unavailable', 503, { error: 'no shield on testnet' }); }
  async confidentialSwapQuote(b: { token_in: string; token_out: string; amount_in: string }): Promise<QuotePreview> {
    const p = await this.bestPool(bare(b.token_in), bare(b.token_out), BigInt(b.amount_in));
    return { amount_out: p.out.toString(), time_estimate_seconds: 20, hint: `real Ref testnet quote (pool #${p.id}, fee ${p.feeBps} bps)` };
  }

  async confidentialSwap(b: { token_in: string; token_out: string; amount_in: string; min_amount_out?: string }, idem: string): Promise<ActionResponse> {
    const prev = this.ledger[idem];
    if (prev && (prev.stage === 'done' || prev.stage === 'refunded') && prev.requestId) return { request_id: prev.requestId, status: 'pending_deposit', intent_hash: prev.withdrawTx };
    const tin = bare(b.token_in), tout = bare(b.token_out), amountIn = BigInt(b.amount_in);
    await this.ensureSetup([tin, tout]);
    let e: LedgerEntry = prev ?? this.put({ idem, kind: 'swap', stage: 'start', amountIn: b.amount_in, ts: Math.floor(Date.now() / 1000) });

    if (e.stage === 'start') { // price check BEFORE any money moves
      const p = await this.bestPool(tin, tout, amountIn);
      if (b.min_amount_out && p.out < BigInt(b.min_amount_out)) throw new OutLayerError('bad_request', 400, { message: `quote amount_out ${p.out} below min_amount_out ${b.min_amount_out} (ref pool #${p.id})` });
      e = this.put({ ...e, pool: p.id });
    }
    if (e.stage === 'start') { // wrap exactly the missing wNEAR (retry-safe: a refunded earlier attempt leaves wNEAR in the vault)
      if (tin === WRAP) {
        const have = await this.ftBalance(WRAP);
        if (have < amountIn) { const w = await this.call(WRAP, 'near_deposit', {}, TGAS(30), amountIn - have, 0n, `${idem}:wrap`); e = this.put({ ...e, wrapTx: w.hash }); }
      }
      e = this.put({ ...e, stage: 'wrapped' });
    }
    if (e.stage === 'wrapped') {
      const refDep = async () => BigInt(await view<string>(this.o.rpc, this.dex, 'get_deposit', { account_id: this.vaultId, token_id: tout }).catch(() => '0'));
      const refBefore = await refDep();
      const balBefore = e.balBefore !== undefined ? BigInt(e.balBefore) : await this.ftBalance(tout);
      e = this.put({ ...e, balBefore: balBefore.toString() }); // persisted before the swap so a crash cannot double-count the output
      const msg = JSON.stringify({ force: 0, actions: [{ pool_id: e.pool, token_in: tin, token_out: tout, amount_in: b.amount_in, min_amount_out: b.min_amount_out ?? '0' }] });
      const s = await this.call(tin, 'ft_transfer_call', { receiver_id: this.dex, amount: b.amount_in, msg }, TGAS(180), ONE_YOCTO, 0n, `${idem}:swap`);
      const used = BigInt(typeof s.value === 'string' ? s.value : '0');
      const sw = s.logs.map((l) => l.match(/Swapped (\d+) (\S+) for (\d+) (\S+)/)).find(Boolean);
      const [refAfter, balAfter] = [await refDep(), await this.ftBalance(tout)];
      const viaDeposit = refAfter > refBefore; // Ref "instant swap" normally sends the output straight to the sender; if it kept it in the Ref account we withdraw it
      const out = sw ? BigInt(sw[3]) : viaDeposit ? refAfter - refBefore : balAfter - balBefore;
      if (used === 0n || out <= 0n) { // Ref refused (price moved past min_amount_out): the input tokens come back to the vault
        const rec: RequestRecord = { status: 'refunded', result: { swap_details: { pool: e.pool, swapTx: s.hash, refundReason: 'Ref refused the swap (min_amount_out) or pool state changed' } } } as RequestRecord;
        this.put({ ...e, stage: 'refunded', swapTx: s.hash, requestId: s.hash, record: rec });
        return { request_id: s.hash, status: 'pending_deposit', intent_hash: s.hash };
      }
      if (viaDeposit) e = this.put({ ...e, stage: 'swapped', swapTx: s.hash, amountOut: out.toString(), requestId: s.hash });
      else { // output already in the vault wallet: the swap tx is the whole story
        const rec: RequestRecord = { status: 'success', result: { amount_out: out.toString(), swap_details: { pool: e.pool, swapTx: s.hash, wrapTx: e.wrapTx, instantSwap: true, vaultBalanceDelta: (balAfter - balBefore).toString(), destinationChainTxHashes: [s.hash] } } } as RequestRecord;
        e = this.put({ ...e, stage: 'done', swapTx: s.hash, withdrawTx: s.hash, amountOut: out.toString(), requestId: s.hash, record: rec });
      }
    }    if (e.stage === 'swapped') { // pull the output from Ref into the vault's own token balance
      const w = await this.call(this.dex, 'withdraw', { token_id: tout, amount: e.amountOut, unregister: false }, TGAS(100), ONE_YOCTO, 0n, `${idem}:withdraw`);
      const rec: RequestRecord = { status: 'success', result: { amount_out: e.amountOut, swap_details: { pool: e.pool, swapTx: e.swapTx, wrapTx: e.wrapTx, withdrawTx: w.hash, destinationChainTxHashes: [w.hash] } } } as RequestRecord;
      e = this.put({ ...e, stage: 'done', withdrawTx: w.hash, record: rec });
    }
    return { request_id: e.requestId!, status: 'pending_deposit', intent_hash: e.withdrawTx };
  }

  /** Real payout / fee / leftover return on NEAR testnet. `chain` must be 'near' (cross-chain payouts exist only on mainnet via Intents). */
  async confidentialWithdraw(b: { chain: string; to: string; amount: string; token: string }, idem: string): Promise<ActionResponse> {
    const prev = this.ledger[idem];
    if (prev?.stage === 'done' && prev.requestId) return { request_id: prev.requestId, status: 'pending_deposit', intent_hash: prev.withdrawTx };
    if (b.chain !== 'near') throw new OutLayerError('bad_request', 400, { message: `testnet profile pays on chain "near" only (got ${b.chain}); cross-chain payouts need mainnet Intents` });
    const token = bare(b.token), amount = BigInt(b.amount);
    const e = prev ?? this.put({ idem, kind: 'withdraw', stage: 'start', amountIn: b.amount, ts: Math.floor(Date.now() / 1000) });
    let hash: string;
    if (token === WRAP) { // sell-token leftovers: native NEAR back to the DAO (unwrap held wNEAR first if the native free balance is short)
      const free = await this.freeNative();
      if (free < amount) { const w = await this.ftBalance(WRAP); const need = amount - free; if (w > 0n) await this.call(WRAP, 'near_withdraw', { amount: (w < need ? w : need).toString() }, TGAS(30), ONE_YOCTO, 0n, `${idem}:unwrap`); }
      hash = await this.sendNative(b.to, amount, `${idem}:native`);
    } else {
      if (!(await this.registered(token, b.to))) await this.call(token, 'storage_deposit', { account_id: b.to, registration_only: true }, TGAS(30), STORAGE_FT, STORAGE_FT, `${idem}:reg`);
      // custody path: POST /wallet/v1/transfer with `token`, the one OutLayer endpoint whose policy check covers the RECIPIENT of a token payout
      const r = await this.signer.sendToken(token, b.to, amount, `quiet-treasury ${idem}`, `${idem}:ft`);
      this.spent += r.burnt; this.save(); this.log('tx', { contract: token, method: 'ft_transfer', hash: r.hash, custody: this.signer.kind });
      hash = r.hash;
    }
    const rec: RequestRecord = { status: 'success', result: { swap_details: { destinationChainTxHashes: [hash] } } } as RequestRecord;
    this.put({ ...e, stage: 'done', withdrawTx: hash, requestId: hash, record: rec });
    return { request_id: hash, status: 'pending_deposit', intent_hash: hash };
  }
  async confidentialWithdrawDryRun(_b: { chain: string; to: string; amount: string; token: string }): Promise<QuotePreview> { return { hint: 'testnet-real adapter: no wallet policy on this path' }; }

  async request(id: string): Promise<RequestRecord> {
    const e = Object.values(this.ledger).find((x) => x.requestId === id);
    if (e?.record) return e.record;
    if (e) return { status: 'processing' } as RequestRecord;
    throw new OutLayerError('unknown', 404, { error: 'not_found' });
  }
  async waitForRequest(id: string): Promise<RequestRecord & { status: TerminalStatus }> { return (await this.request(id)) as RequestRecord & { status: TerminalStatus }; }
}
