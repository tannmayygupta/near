// LIVE CRASH-RESTART TEST on PUBLIC NEAR TESTNET (OutLayer custody). Run: npx tsx --env-file=.env scripts/testnet/e2e-restart.ts
// Proves the "restart survival" claim with real money movement instead of unit tests: the worker "dies" AFTER a real Ref swap landed on chain but BEFORE it
// could record it. A brand-new worker (new sqlite connection, new adapter, same files) must finish the mandate WITHOUT swapping that chunk a second time.
// The crash is injected by a signer wrapper that throws right after the OutLayer call returned; everything else is the production code path.
import './profile.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { callTx, NEAR, TGAS, view, providerFor } from '../../src/near/chain.js';
import * as sp from '../../src/near/sputnik.js';
import * as mc from '../../src/near/mandate.js';
import { MandateTerms } from '../../src/engine/schema.js';
import { hashJson } from '../../src/engine/hash.js';
import { Executor, defaultConfig } from '../../worker/executor.js';
import { RealChain } from '../../worker/chain.js';
import { State } from '../../worker/state.js';
import { RefTestnetAdapter, isTxHash } from '../../worker/adapters/ref-testnet.js';
import type { ChainSigner, SignedCall } from '../../worker/adapters/signers.js';
import { pricesSane, priceList, A, loadConfig, proposeWithHash, voteTx, rec, txs, explorerTx, sleep } from './lib.js';
import { mainnetRefPrice } from './vault.js';
import { ensureCustody } from './custody.js';
import { scopedAgent } from './scoped-key.js';

const c = loadConfig();
const SELL = 'nep141:wrap.testnet', BUY = 'nep141:usdt.fakes.testnet', USDT = 'usdt.fakes.testnet';
const results: Array<[string, boolean, string]> = [];
const check = (n: string, ok: boolean, note = '') => { results.push([n, ok, note]); console.log(ok ? 'PASS' : 'FAIL', n, note); };
const nowS = () => Math.floor(Date.now() / 1000);
const natOf = async (a: string) => BigInt((await providerFor(c.rpc).viewAccount({ accountId: a })).amount);
const usdtOf = async (a: string) => BigInt(await view<string>(c.rpc, USDT, 'ft_balance_of', { account_id: a }).catch(() => '0'));
const ALICE = c.accounts.contributor.accountId, OPERATOR = c.accounts.funder.accountId;

// ---------- custody wallet, reset to a clean float ----------
const STATE_DB = 'data/secret/restart-state.sqlite', LEDGER = 'data/secret/ref-ledger-restart.json';
for (const f of [STATE_DB, STATE_DB + '-wal', STATE_DB + '-shm', LEDGER, 'data/secret/custody-policies-restart.json']) rmSync(f, { force: true });
const cust = await ensureCustody({ policyPath: 'data/secret/custody-policies-restart.json' });
const VAULT = cust.address;
{
  const wn = BigInt(await view<string>(c.rpc, 'wrap.testnet', 'ft_balance_of', { account_id: VAULT }).catch(() => '0'));
  if (wn > 0n) await cust.signer.call('wrap.testnet', 'near_withdraw', { amount: wn.toString() }, TGAS(30), 1n);
  const us = await usdtOf(VAULT);
  if (us > 0n) { try { await cust.signer.sendToken(USDT, ALICE, us, 'custody reset'); } catch (e) { console.log('  (reset: USDT.e left:', (e as Error).message.slice(0, 90), ')'); } }
}
if ((await natOf(VAULT)) < NEAR(2)) { await A(c, 'contributor').transfer({ receiverId: VAULT, amount: NEAR(2) - (await natOf(VAULT)) + NEAR('0.2') }); await sleep(3000); }
const reserve = await natOf(VAULT);

// ---------- crash injector: wraps the real custody signer ----------
class CrashingSigner implements ChainSigner {
  readonly kind = 'outlayer-custody' as const; armed = false; crashedHash: string | null = null; crashes = 0;
  constructor(private inner: ChainSigner) {}
  get id() { return this.inner.id; }
  async call(contract: string, method: string, args: object, gas: bigint, deposit: bigint, idem?: string): Promise<SignedCall> {
    const r = await this.inner.call(contract, method, args, gas, deposit, idem);
    if (this.armed && method === 'ft_transfer_call') { this.armed = false; this.crashedHash = r.hash; this.crashes++; throw new Error('SIMULATED PROCESS DEATH: the swap landed on chain, the worker died before recording it'); }
    return r;
  }
  sendNative(to: string, a: bigint, idem?: string) { return this.inner.sendNative(to, a, idem); }
  sendToken(t: string, to: string, a: bigint, memo: string, idem?: string) { return this.inner.sendToken(t, to, a, memo, idem); }
}
const crashing = new CrashingSigner(cust.signer);

const boot = (signer: ChainSigner) => {
  const ref = new RefTestnetAdapter({ signer, policy: cust.policy, rpc: c.rpc, reserveYocto: reserve, ledgerPath: LEDGER, refPrice: mainnetRefPrice, log: (k, f) => { if (k === 'tx') rec(`outlayer wallet: ${f.contract}.${f.method}`, String(f.hash)); } });
  const state = new State(STATE_DB, Buffer.alloc(32, 7));
  const chain = new (class extends RealChain { listMandates() { return super.listMandates().then((l) => l.filter((mm) => mm.id >= fromId)); } })({ rpc: c.rpc, mandateContract: c.mandate, dao: c.dao, agent: scopedAgent(c) });
  const exec = new Executor({
    outlayer: ref, chain, state, clock: { nowS, sleep }, log: (k, f) => { if (!['chunk_submitted', 'awaiting_approval'].includes(k)) console.log('  [worker]', k, JSON.stringify(f).slice(0, 170)); },
    benchmark: (terms) => ref.spotSample(terms.sellToken, terms.buyToken, 24, 6),
    poolSnapshot: async (terms) => { const s = await ref.poolSnapshot(terms.sellToken, terms.buyToken, BigInt(terms.chunkMax)); return s ? { poolId: s.poolId, reserveIn: s.reserveIn, reserveOut: s.reserveOut, feeBps: s.feeBps, ts: s.ts } : null; },
    prepare: (m, terms) => ref.prepareMandate(m.id, terms),
  }, { ...defaultConfig(c.dao), floorRetryS: 6, requestWaitMs: 120_000 });
  return { ref, state, chain, exec };
};
const nextId = (await view<[string, string, number]>(c.rpc, c.mandate, 'get_config'))[2];
let fromId = nextId;

// ---------- DAO creates + funds a mandate ----------
const now0 = nowS();
const t = MandateTerms.parse({
  dao: c.dao, treasurer: c.accounts.treasurer.accountId, sellToken: SELL, buyToken: BUY, maxSellAmount: NEAR('0.3').toString(), minPrice: '2', startTs: now0 - 3, endTs: now0 + 540,
  chunkMin: NEAR('0.05').toString(), chunkMax: NEAR('0.06').toString(), intervalMinS: 6, intervalMaxS: 8,
  payouts: [{ label: 'alice', chain: 'near', address: ALICE, token: BUY, percent: 50 }], feeBps: 50, feeRecipient: OPERATOR, returnTo: c.dao, sealed: false,
});
const createArgs: mc.CreateArgs = { treasurer: t.treasurer, terms_hash: hashJson(t), terms_json: JSON.stringify(t), sell_token: t.sellToken, max_sell: t.maxSellAmount, start_ns: t.startTs * 1e9, end_ns: t.endTs * 1e9, tier: 'small' };
for (const old of (await mc.listMandates(c.rpc, c.mandate, 0, 200)).filter((x) => x.id < nextId && ['Approved', 'Funded', 'Executing'].includes(x.status))) {
  const cp = await proposeWithHash(c, 'council1', `Housekeeping: cancel stale mandate #${old.id}`, sp.functionCallKind(c.mandate, 'cancel_mandate', { id: old.id }), `housekeeping cancel #${old.id}`);
  await voteTx(c, 'council1', cp, 'VoteApprove', 'hk vote 1/3'); await voteTx(c, 'council2', cp, 'VoteApprove', 'hk vote 2/3'); console.log('cancelled stale mandate', old.id);
}
const pid = await proposeWithHash(c, 'council1', `Crash-restart test: sell 0.3 NEAR (mandate #${nextId})`, sp.functionCallKind(c.mandate, 'create_mandate', createArgs), 'DAO proposal: create_mandate');
await voteTx(c, 'council1', pid, 'VoteApprove', 'vote 1/3'); await voteTx(c, 'council2', pid, 'VoteApprove', 'vote 2/3 -> executes');
const fid = await proposeWithHash(c, 'council1', `Fund the custody wallet with 0.3 NEAR for mandate #${nextId}`, sp.transferKind('', VAULT, t.maxSellAmount), 'DAO proposal: Transfer budget -> OutLayer custody wallet');
await voteTx(c, 'council1', fid, 'VoteApprove', 'funding vote 1/3'); await voteTx(c, 'council3', fid, 'VoteApprove', 'funding vote 2/3 -> executes');
check('mandate approved by 2 of 3 and funded by a real DAO Transfer into the OutLayer wallet', (await mc.getMandate(c.rpc, c.mandate, nextId))?.status === 'Approved' && (await natOf(VAULT)) >= reserve + NEAR('0.29'));
const aliceBefore = await usdtOf(ALICE), daoUsdtBefore = await usdtOf(c.dao);

// ---------- worker #1 trades, then "dies" right after a swap landed ----------
let w = boot(crashing);
const runUntil = async (cond: () => Promise<boolean> | boolean, maxS: number) => { const t0 = Date.now(); while (Date.now() - t0 < maxS * 1000) { await w.exec.tick(); if (await cond()) return true; await sleep(3000); } return false; };
const ok1 = await runUntil(async () => ((await w.chain.getMandate(nextId))?.chunks ?? 0) >= 2, 300);
check('worker #1 completed 2 real swaps before the crash', ok1);
crashing.armed = true;
const crashed = await runUntil(() => crashing.crashes > 0, 240);
check('crash injected: a real swap landed on chain and the worker died before recording it', crashed && isTxHash(crashing.crashedHash), (crashing.crashedHash ?? '').slice(0, 10));
const chunksAtCrash = (await w.chain.getMandate(nextId))!.chunks;
const recordedBeforeDeath = w.state.chunks(nextId).filter((x) => x.recorded).length;
// process death: everything in memory is gone; only the sqlite file and the adapter ledger file survive
w.state.db.close();
w = boot(cust.signer); // a fresh worker: new State connection to the same file, new adapter reading the same ledger, NO crash injector

// ---------- worker #2 resumes ----------
const ok2 = await runUntil(async () => (await w.chain.getMandate(nextId))?.status === 'Completed', 420);
const m = (await w.chain.getMandate(nextId))!;
check('a brand-new worker resumes from its files and the mandate completes', ok2, `status=${m.status} chunks=${m.chunks} (was ${chunksAtCrash} at crash)`);
const done = w.state.chunks(nextId).filter((x) => x.status === 'success');
const swapHashes = done.map((x) => x.request_id!);
check('the chunk that was in flight at the crash was NOT swapped twice: it resolves to the SAME on-chain swap tx', swapHashes.includes(crashing.crashedHash!) && new Set(swapHashes).size === swapHashes.length, `${swapHashes.length} chunks, ${new Set(swapHashes).size} distinct swap txs`);
const sumSizes = done.reduce((s, x) => s + BigInt(x.size), 0n);
check('chain-recorded sold == sum of the successful chunk sizes, and within the DAO-approved budget', BigInt(m.sold) === sumSizes && BigInt(m.sold) <= BigInt(m.max_sell), `${m.sold} / ${m.max_sell}`);
check('every swap request id is a real transaction on chain', done.length > 0 && (await Promise.all(done.map(async (x) => { try { const o: any = await providerFor(c.rpc).viewTransactionStatus({ txHash: x.request_id!, accountId: VAULT, waitUntil: 'EXECUTED_OPTIMISTIC' } as any); return !!(o?.transaction?.hash ?? o?.transaction_outcome?.id); } catch { return false; } }))).every(Boolean));
const items = w.state.items(nextId);
const paid = BigInt(items.find((i) => i.label === 'alice' && i.status === 'success')?.amount ?? '0');
const aliceAfter = await usdtOf(ALICE);
check('payout paid exactly once: alice balance rose by exactly her payout item', paid > 0n && aliceAfter - aliceBefore === paid, `+${aliceAfter - aliceBefore} (expected ${paid})`);
const retBuy = items.find((i) => i.kind === 'return_buy');
check('leftover proceeds returned to the DAO exactly once', !retBuy || (retBuy.status === 'success' && (await usdtOf(c.dao)) - daoUsdtBefore === BigInt(retBuy.amount)), retBuy ? `+${retBuy.amount}` : 'none');
const rep = w.state.report(nextId);
check('report hash anchored on chain matches the stored report', /^[0-9a-f]{64}$/.test(m.report_hash ?? '') && rep?.reportHash === m.report_hash, (m.report_hash ?? '').slice(0, 16));
check('price floor respected on every fill, no violations', rep?.floorRespected === true && w.state.violations(nextId).length === 0);
check('every swap executed at a market-like price (0.3-15 USDT.e per NEAR): never through an absurd pool', pricesSane(done.map((x) => ({ in: x.size, out: x.amount_out ?? '0' }))), priceList(done.map((x) => ({ in: x.size, out: x.amount_out ?? '0' }))));
check('no chunk was recorded on chain that the worker had not executed (chain chunk count == executed swaps)', m.chunks === done.length, `${m.chunks} vs ${done.length}`);

const failed = results.filter((r) => !r[1]);
mkdirSync('data/demo-run', { recursive: true }); mkdirSync('app/public/demo-run', { recursive: true });
const out = {
  recordedAt: new Date().toISOString(), network: 'testnet', custody: 'outlayer', mandateId: nextId, wallet: VAULT, ids: { mandateContract: c.mandate, agent: c.accounts.agent.accountId, dao: c.dao },
  note: 'LIVE crash-restart on public testnet. The crash is a simulated process death injected AFTER a real swap landed (signer wrapper in scripts/testnet/e2e-restart.ts); the restarted worker is a new State connection + new adapter over the same files.',
  crash: { swapTx: crashing.crashedHash, explorer: crashing.crashedHash ? explorerTx(crashing.crashedHash) : null, chunksRecordedOnChainAtCrash: chunksAtCrash, recordedLocallyBeforeDeath: recordedBeforeDeath },
  swaps: done.map((x) => ({ index: x.idx, tx: x.request_id, explorer: explorerTx(x.request_id!), in: x.size, out: x.amount_out })),
  payouts: items.map((i) => ({ kind: i.kind, label: i.label, to: i.address, amount: i.amount, status: i.status, tx: i.request_id, explorer: i.request_id ? explorerTx(i.request_id) : null })),
  mandate: m, txs, results: results.map(([name, ok, note]) => ({ name, ok, note })),
};
writeFileSync('data/demo-run/restart-run.json', JSON.stringify(out, null, 2));
writeFileSync('app/public/demo-run/restart-run.json', JSON.stringify(out, null, 2));
console.log('\n=========== CRASH-RESTART RESULT ===========');
for (const [n, ok] of results) console.log(ok ? ' PASS ' : ' FAIL ', n);
console.log(`${results.length - failed.length}/${results.length} passed`);
for (const x of txs) console.log(' ', x.label.padEnd(60), explorerTx(x.txHash));
void callTx;
process.exit(failed.length ? 1 : 0);
