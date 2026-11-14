// FULL END-TO-END ON PUBLIC NEAR TESTNET WITH REAL MONEY MOVEMENT (EXEC_MODE=testnet-real). Run: npx tsx --env-file=.env scripts/testnet/e2e-real.ts
// REAL: NEAR AI TEE parsing + signed completions + attestation; Sputnik DAO proposals/votes incl. a REAL native-NEAR Transfer proposal that funds the vault;
//       mandate contract state + report anchoring; REAL Ref Finance swaps (wrap -> ft_transfer_call -> output); REAL USDT.e payouts and fee to named accounts;
//       REAL leftover returns to the DAO; real DAO cancel mid-run; OutLayer testnet wallet policy (Layer A) denials.
// NOT PROVEN HERE (mainnet-only): OutLayer TEE custody swaps, confidential swaps, Intents cross-chain payouts. Custody on this path is a worker-held vault key.
import './profile.js'; // MUST stay first: selects the testnet token profile (wNEAR / USDT.e)
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { callTx, NEAR, TGAS, view, providerFor } from '../../src/near/chain.js';
import * as sp from '../../src/near/sputnik.js';
import * as mc from '../../src/near/mandate.js';
import { NearAiClient } from '../../src/near/ai.js';
import { OutLayerWallet, layerAVerdict } from '../../src/near/outlayer-policy.js';
import { BOUNDS, MandateTerms } from '../../src/engine/schema.js';
import { hashJson } from '../../src/engine/hash.js';
import { parseIntent, Llm, fromUnits } from '../../src/engine/parser.js';
import { verifyBundle } from '../../src/verify/index.js';
import { Executor, defaultConfig } from '../../worker/executor.js';
import { RealChain, RealChainOpts } from '../../worker/chain.js';
import { State } from '../../worker/state.js';
import { createApi, termsFor } from '../../worker/api.js';
import { runAttack, ATTACKS } from '../../worker/redteam.js';
import { RefTestnetAdapter, isTxHash } from '../../worker/adapters/ref-testnet.js';
import { createSummarizer } from '../../worker/summarizer.js';
import { pricesSane, priceList, A, loadConfig, proposeWithHash, voteTx, rec, txs, explorerTx, explorerAccount, sleep } from './lib.js';
import { ensureVault, mainnetRefPrice, resetVaultFloat } from './vault.js';

const c = loadConfig();
const pub = JSON.parse(readFileSync('data/testnet-public.json', 'utf8').replace(/^﻿/, ''));
const layerAEvidence = JSON.parse(readFileSync('data/testnet-layer-a.json', 'utf8').replace(/^﻿/, ''));
const SELL = 'nep141:wrap.testnet', BUY = 'nep141:usdt.fakes.testnet', USDT = 'usdt.fakes.testnet';
const results: Array<[string, boolean, string]> = [];
const check = (n: string, ok: boolean, note = '') => { results.push([n, ok, note]); console.log(ok ? 'PASS' : 'FAIL', n, note); };
const agent = A(c, 'agent');
const nowS = () => Math.floor(Date.now() / 1000);
const nearH = (y: bigint | string) => (Number(BigInt(y) / 10n ** 20n) / 10_000).toString();
const usdtOf = async (acct: string) => BigInt(await view<string>(c.rpc, USDT, 'ft_balance_of', { account_id: acct }).catch(() => '0'));
const natOf = async (acct: string) => BigInt((await providerFor(c.rpc).viewAccount({ accountId: acct })).amount);
const txOnChain = async (hash: string, signer: string) => { try { const o: any = await providerFor(c.rpc).viewTransactionStatus({ txHash: hash, accountId: signer, waitUntil: 'EXECUTED_OPTIMISTIC' } as any); return !!(o?.transaction?.hash ?? o?.transaction_outcome?.id); } catch { return false; } };

// ---------- vault + REAL adapter ----------
const { vault, accountId: VAULT } = await ensureVault();
await resetVaultFloat(vault, c.rpc); // wNEAR left by earlier runs / the pool rebalancer would count as DAO-funded budget
const vaultReserve = await natOf(VAULT); // the vault's float BEFORE any DAO funding: everything above it (plus what the adapter itself spent) is DAO-funded budget
rmSync('data/secret/ref-ledger-e2e.json', { force: true });
const ref = new RefTestnetAdapter({
  vault, rpc: c.rpc, reserveYocto: vaultReserve, ledgerPath: 'data/secret/ref-ledger-e2e.json', refPrice: mainnetRefPrice,
  log: (k, f) => { if (k === 'tx') rec(`vault: ${f.contract}.${f.method}`, String(f.hash)); },
});
console.log('vault', VAULT, 'float', nearH(vaultReserve), 'NEAR | DAO', c.dao);

// ---------- real NEAR AI: attestation + parsing ----------
const ai = new NearAiClient();
const model = await ai.resolveConfidentialModel();
const { report: attestation, nonce } = await ai.fetchAttestation(model);
const completions: any[] = [];
let n = 0;
const llm: Llm = async (system, user) => { const sc = await ai.signedCompletion({ model, system, user }); completions.push({ label: `intent parse #${++n}`, ...sc }); return sc.content; };

const ALICE = c.accounts.contributor.accountId, BOB = c.accounts.treasurer.accountId, OPERATOR = c.accounts.funder.accountId;
const INTENT = `Sell up to 0.4 NEAR for USDT.e over the next 8 minutes, never below 2 USDT.e per NEAR, in chunks of 0.05 to 0.1 NEAR every 5 to 8 seconds. ` +
  `Pay 50% of the proceeds to alice at ${ALICE} and 20% to bob at ${BOB}, both on near. Take a 0.5% service fee paid to ${OPERATOR}.`;
const parsed = await parseIntent(INTENT, { dao: c.dao, treasurer: c.accounts.treasurer.accountId, nowS: nowS(), llm });
check('NEAR AI (TEE) parsed the plain-English intent into a valid mandate', !!parsed.terms, `${parsed.attempts} attempt(s)`);
console.log(parsed.summary.join('\n'));

const overrides: string[] = [];
let t = { ...parsed.terms } as MandateTerms;
const now0 = nowS();
const fix = (cond: boolean, msg: string, patch: Partial<MandateTerms>) => { if (cond) { overrides.push(msg); t = { ...t, ...patch } as MandateTerms; } };
fix(t.endTs - now0 > 700 || t.endTs - now0 < 120, `window set to 8 minutes for the recorded run (AI proposed ${t.endTs - t.startTs}s)`, { startTs: now0 - 3, endTs: now0 + 480 });
fix(t.intervalMaxS > 12, `intervals set to 5-8 s (AI proposed ${t.intervalMinS}-${t.intervalMaxS}s)`, { intervalMinS: 5, intervalMaxS: 8 });
fix(!t.feeRecipient || t.feeBps === 0, 'fee 0.5% to the operator account (AI omitted it)', { feeBps: 50, feeRecipient: OPERATOR });
fix(t.payouts.length !== 2, 'payouts set to alice 50% / bob 20% (AI output differed)', { payouts: [
  { label: 'alice', chain: 'near', address: ALICE, token: BUY, percent: 50 }, { label: 'bob', chain: 'near', address: BOB, token: BUY, percent: 20 }] });
fix(Number(t.minPrice) > 3 || Number(t.minPrice) < 1, `price floor set to 2 (AI proposed ${t.minPrice})`, { minPrice: '2' });
t = MandateTerms.parse(t);
const nextId = (await view<[string, string, number]>(c.rpc, c.mandate, 'get_config'))[2];
console.log('mandate overrides:', overrides.length ? overrides : 'none');

// housekeeping: stale mandates from earlier aborted/partial runs are cancelled through REAL DAO proposals (never left dangling as "Approved")
for (const old of (await mc.listMandates(c.rpc, c.mandate, 0, 200)).filter((x) => x.id < nextId && ['Approved', 'Funded', 'Executing'].includes(x.status))) {
  const cp = await proposeWithHash(c, 'council1', `Housekeeping: cancel stale mandate #${old.id}`, sp.functionCallKind(c.mandate, 'cancel_mandate', { id: old.id }), `DAO proposal: cancel stale mandate #${old.id}`);
  await voteTx(c, 'council1', cp, 'VoteApprove', `housekeeping cancel #${old.id} vote 1/3`); await voteTx(c, 'council2', cp, 'VoteApprove', `housekeeping cancel #${old.id} vote 2/3 -> executes`);
  console.log('cancelled stale mandate', old.id);
}

// ---------- worker wiring (REAL adapter) ----------
class HChain extends RealChain {
  constructor(private o2: RealChainOpts, private fromId: () => number) { super(o2); }
  private tx(label: string, method: string, args: object) { return callTx(this.o2.agent, this.o2.mandateContract, method, args, TGAS(30)).then((r) => { rec(label, r.txHash); return r; }); }
  listMandates() { return super.listMandates().then((l) => l.filter((mm) => mm.id >= this.fromId())); }
  markFunded(id: number) { return this.tx(`agent: mark_funded #${id}`, 'mark_funded', { id }); }
  recordChunk(id: number, index: number, soldAmount: string) { return this.tx(`agent: record_chunk #${id}.${index}`, 'record_chunk', { id, index, sold_amount: soldAmount }); }
  beginSettlement(id: number) { return this.tx(`agent: begin_settlement #${id}`, 'begin_settlement', { id }); }
  complete(id: number, h: string, v: number, r: string | null) { return this.tx(`agent: complete #${id} (anchors report hash)`, 'complete', { id, report_hash: h, violations: v, revealed_terms: r }); }
}
let fromId = nextId;
const chain = new HChain({ rpc: c.rpc, mandateContract: c.mandate, dao: c.dao, agent }, () => fromId);
const state = new State(':memory:', Buffer.alloc(32, 9));
const summaries: any[] = [];
const exec = new Executor({
  outlayer: ref, chain, state, clock: { nowS, sleep }, log: (k, f) => { if (!['chunk_submitted', 'awaiting_approval'].includes(k)) console.log('  [worker]', k, JSON.stringify(f).slice(0, 190)); },
  benchmark: (terms) => ref.spotSample(terms.sellToken, terms.buyToken, 24, 6),
  poolSnapshot: async (terms) => { const s = await ref.poolSnapshot(terms.sellToken, terms.buyToken, BigInt(terms.chunkMax)); return s ? { poolId: s.poolId, reserveIn: s.reserveIn, reserveOut: s.reserveOut, feeBps: s.feeBps, ts: s.ts } : null; },
  summarize: createSummarizer(ai, (sc) => { completions.push({ label: 'settlement summary', ...sc }); summaries.push(sc); }, model),
}, { ...defaultConfig(c.dao), floorRetryS: 6, requestWaitMs: 120_000 });
const runUntil = async (cond: () => Promise<boolean> | boolean, maxS: number) => { const t0 = Date.now(); while (Date.now() - t0 < maxS * 1000) { await exec.tick(); if (await cond()) return true; await sleep(3000); } return false; };
const createArgs = (terms: MandateTerms, tier: 'small' | 'mid' | 'large'): mc.CreateArgs => ({ treasurer: terms.treasurer, terms_hash: hashJson(terms), terms_json: JSON.stringify(terms), sell_token: terms.sellToken, max_sell: terms.maxSellAmount, start_ns: terms.startTs * 1e9, end_ns: terms.endTs * 1e9, tier });

// ---------- balances before ----------
const before = { dao: await natOf(c.dao), alice: await usdtOf(ALICE), bob: await usdtOf(BOB), operator: await usdtOf(OPERATOR), daoUsdt: await usdtOf(c.dao) };
const poolBefore = await ref.poolSnapshot(SELL, BUY, 10n ** 22n);

// ================= RUN 1: DAO vote -> REAL funding transfer -> REAL swaps -> REAL payouts =================
const pid = await proposeWithHash(c, 'council1', `Quiet Treasury: sell ${fromUnits(t.maxSellAmount, 24, 2)} NEAR quietly for USDT.e (mandate #${nextId})`, sp.functionCallKind(c.mandate, 'create_mandate', createArgs(t, 'small')), 'DAO proposal: create_mandate (AI-parsed terms)');
await exec.tick();
check('no execution before the DAO vote', (await mc.getMandate(c.rpc, c.mandate, nextId)) === null && (await ref.confidentialBalance(SELL)).balance === '0');
await voteTx(c, 'council1', pid, 'VoteApprove', 'vote 1/3 approve (council1)');
await voteTx(c, 'council2', pid, 'VoteApprove', 'vote 2/3 approve (council2) -> executes');
let m = (await mc.getMandate(c.rpc, c.mandate, nextId))!;
check('2 of 3 council votes create the mandate on chain', m?.status === 'Approved', m?.status);

// REAL funding: a Sputnik Transfer proposal moves native NEAR from the DAO treasury to the vault; the worker only starts once the vault holds the budget
const fid = await proposeWithHash(c, 'council1', `Fund the agent vault with ${fromUnits(t.maxSellAmount, 24, 2)} NEAR for mandate #${nextId}`, sp.transferKind('', VAULT, t.maxSellAmount), 'DAO proposal: Transfer budget (native NEAR) DAO -> agent vault');
await voteTx(c, 'council1', fid, 'VoteApprove', 'funding vote 1/3 (council1)');
for (let i = 0; i < 3; i++) await exec.tick();
check('one vote does NOT fund the vault; worker waits', BigInt((await ref.confidentialBalance(SELL)).balance) === 0n && state.runtime(nextId).phase !== 'done');
await voteTx(c, 'council3', fid, 'VoteApprove', 'funding vote 2/3 (council3) -> executes the REAL transfer');
let budget = BigInt((await ref.confidentialBalance(SELL)).balance);
check('DAO funding transfer credited the vault (real native NEAR)', budget >= BigInt(t.maxSellAmount) - 10n ** 20n, `${nearH(budget)} NEAR budget`);

const ok1 = await runUntil(async () => (await chain.getMandate(nextId))?.status === 'Completed', 600);
m = (await chain.getMandate(nextId))!;
check('worker executes REAL swaps and the mandate completes', ok1, `status=${m.status} chunks=${m.chunks}`);
const items1 = state.items(nextId), chunks1 = state.chunks(nextId).filter((x) => x.status === 'success');
check('chunks recorded on chain == real swaps executed', m.chunks === chunks1.length && m.chunks >= 2, `chain ${m.chunks} / swaps ${chunks1.length}`);
check('sold never exceeds the DAO-approved budget', BigInt(m.sold) <= BigInt(m.max_sell), `${nearH(m.sold)} / ${nearH(m.max_sell)} NEAR`);
check('every swap request id is a real transaction hash that exists on chain', chunks1.length > 0 && chunks1.every((x) => isTxHash(x.request_id)) && (await Promise.all(chunks1.map((x) => txOnChain(x.request_id!, VAULT)))).every(Boolean), chunks1.map((x) => (x.request_id ?? '').slice(0, 8)).join(','));
const stored = state.report(nextId);
check('report fills are tagged chain (never simulated)', stored?.fills?.length > 0 && stored.fills.every((f: any) => f.source === 'chain'));
check('every swap respected the price floor', stored?.floorRespected === true && state.violations(nextId).length === 0, `worst ${stored?.totals?.worstFillPrice?.value}`);
check('every swap executed at a market-like price (0.3-15 USDT.e per NEAR): never through an absurd pool', pricesSane(chunks1.map((x) => ({ in: x.size, out: x.amount_out ?? '0' }))), priceList(chunks1.map((x) => ({ in: x.size, out: x.amount_out ?? '0' }))));
const after = { alice: await usdtOf(ALICE), bob: await usdtOf(BOB), operator: await usdtOf(OPERATOR), daoUsdt: await usdtOf(c.dao), dao: await natOf(c.dao) };
const paid = (label: string) => BigInt(items1.find((i) => i.label === label && i.status === 'success')?.amount ?? '0');
check('alice (named account) really received her USDT.e payout', paid('alice') > 0n && after.alice - before.alice === paid('alice'), `+${after.alice - before.alice} (expected ${paid('alice')})`);
check('bob (named account) really received his USDT.e payout', paid('bob') > 0n && after.bob - before.bob === paid('bob'), `+${after.bob - before.bob} (expected ${paid('bob')})`);
const feeItem = items1.find((i) => i.kind === 'fee');
check('service fee really paid to the operator account', !!feeItem && feeItem.status === 'success' && after.operator - before.operator === BigInt(feeItem.amount), `+${after.operator - before.operator}`);
const retBuy = items1.find((i) => i.kind === 'return_buy'), retSell = items1.find((i) => i.kind === 'return_sell');
check('leftover proceeds (USDT.e) really returned to the DAO', !retBuy || (retBuy.status === 'success' && after.daoUsdt - before.daoUsdt === BigInt(retBuy.amount)), retBuy ? `+${retBuy.amount}` : 'none left');
check('unspent budget (native NEAR) really returned to the DAO', !retSell || (retSell.status === 'success' && isTxHash(retSell.request_id)), retSell ? `${nearH(retSell.amount)} NEAR` : 'fully sold');
check('report hash anchored on chain matches the stored report', /^[0-9a-f]{64}$/.test(m.report_hash ?? '') && stored?.reportHash === m.report_hash, (m.report_hash ?? '').slice(0, 16));
check('NEAR AI signed settlement summary attached', !!stored?.aiSummary?.signer, stored?.aiSummary?.signer);
check('report states what ONE swap would have returned (honest AMM baseline)', !!stored?.oneShot, stored?.oneShot ? `chunked vs one-shot ${stored.oneShot.chunkedVsOneShotBps} bps` : 'missing');
check('treasurer earned trust on chain', (await mc.getTrust(c.rpc, c.mandate, t.treasurer)) >= 1);

// ================= RUN 2: DAO cancels mid-run + red team =================
const id2 = (await view<[string, string, number]>(c.rpc, c.mandate, 'get_config'))[2];
fromId = id2; // only mandates from here on are handled by this tick loop
const now2 = nowS();
const t2 = MandateTerms.parse({
  dao: c.dao, treasurer: c.accounts.treasurer.accountId, sellToken: SELL, buyToken: BUY, maxSellAmount: NEAR('0.3').toString(), minPrice: '1.5', startTs: now2 - 3, endTs: now2 + 600,
  chunkMin: NEAR('0.05').toString(), chunkMax: NEAR('0.06').toString(), intervalMinS: 6, intervalMaxS: 8,
  payouts: [{ label: 'alice', chain: 'near', address: ALICE, token: BUY, percent: 50 }], feeBps: 50, feeRecipient: OPERATOR, returnTo: c.dao, sealed: false,
});
const pid2 = await proposeWithHash(c, 'council1', `Second mandate #${id2} (will be cancelled mid-run)`, sp.functionCallKind(c.mandate, 'create_mandate', createArgs(t2, 'small')), 'DAO proposal: create_mandate #2');
await voteTx(c, 'council2', pid2, 'VoteApprove', 'vote 1/3 approve (council2)'); await voteTx(c, 'council3', pid2, 'VoteApprove', 'vote 2/3 approve (council3) -> executes');
const fid2 = await proposeWithHash(c, 'council1', `Fund the agent vault with 0.3 NEAR for mandate #${id2}`, sp.transferKind('', VAULT, t2.maxSellAmount), 'DAO proposal: Transfer budget #2');
await voteTx(c, 'council2', fid2, 'VoteApprove', 'funding #2 vote 1/3'); await voteTx(c, 'council3', fid2, 'VoteApprove', 'funding #2 vote 2/3 -> executes');
const ok2a = await runUntil(async () => ((await chain.getMandate(id2))?.chunks ?? 0) >= 2, 240);
check('second mandate starts trading (real swaps)', ok2a, `chunks=${(await chain.getMandate(id2))?.chunks}`);

const wallet = new OutLayerWallet({ owner: { accountId: c.accounts.agent.accountId, secretKey: c.accounts.agent.secretKey }, seed: `quiet-treasury-${c.suffix}` });
const layerA = { transfer: (b: { to: string; amount: string }) => wallet.transfer(b), verdict: layerAVerdict, unlistedTo: 'attacker-unlisted.testnet', allowedTo: c.accounts.contributor.accountId, smallAmount: NEAR('0.01').toString(), overCapAmount: NEAR('0.5').toString() };
const rt: any[] = [];
for (const a of ATTACKS) rt.push(await runAttack(a, id2, { chain, outlayer: ref, termsFor: (mm) => termsFor(state, mm), nowS, layerA }));
for (const r of rt) console.log(r.blocked ? '  blocked' : '  NOT BLOCKED', r.attack.padEnd(16), r.layer, '|', String(r.error).slice(0, 110));
check('red-team: all 6 real attacks blocked, each naming its layer', rt.length === 6 && rt.every((r) => r.blocked && /^(A|B)/.test(r.layer)), rt.map((r) => `${r.attack}:${r.layer[0]}`).join(' '));
check('Layer A (OutLayer wallet policy) produced real denials', rt.filter((r) => r.layer.startsWith('A')).length >= 2, rt.filter((r) => r.layer.startsWith('A')).map((r) => r.attack).join(','));

const swapsBeforeCancel = state.chunks(id2).filter((x) => x.status === 'success').length;
const cid = await proposeWithHash(c, 'council1', `Cancel mandate #${id2}`, sp.functionCallKind(c.mandate, 'cancel_mandate', { id: id2 }), 'DAO proposal: cancel_mandate');
await voteTx(c, 'council1', cid, 'VoteApprove', 'cancel vote 1/3'); await voteTx(c, 'council3', cid, 'VoteApprove', 'cancel vote 2/3 -> executes');
check('DAO cancel executes on chain', (await mc.getMandate(c.rpc, c.mandate, id2))?.status === 'Cancelled');
const daoUsdtPre = await usdtOf(c.dao);
const ok2 = await runUntil(() => state.runtime(id2).phase === 'done', 240);
const swapsAfterCancel = state.chunks(id2).filter((x) => x.status === 'success').length;
check('worker stops within a tick and returns everything to the DAO', ok2 && swapsAfterCancel - swapsBeforeCancel <= 1, `swaps after cancel: ${swapsAfterCancel - swapsBeforeCancel}`);
const items2 = state.items(id2);
check('cancelled mandate paid nobody except the DAO (real transfers)', items2.length > 0 && items2.every((i) => i.address === c.dao && i.status === 'success' && isTxHash(i.request_id)), items2.map((i) => `${i.kind}:${i.status}`).join(','));
const retBuy2 = items2.find((i) => i.kind === 'return_buy');
check('cancelled run: proceeds (USDT.e) really back in the DAO', !retBuy2 || (await usdtOf(c.dao)) - daoUsdtPre === BigInt(retBuy2.amount), retBuy2 ? `+${retBuy2.amount}` : 'none');

// ---------- evidence: worker API (same code the dashboard reads), proposals, verifier ----------
fromId = nextId;
const api = createApi({
  state, chain, outlayer: ref, nowS, health: () => ({ net: 'testnet', mode: 'testnet-real' }),
  isCouncil: async (a) => ['council1', 'council2', 'council3'].some((k) => c.accounts[k].accountId === a),
  redteam: { chain, outlayer: ref, termsFor: (mm) => termsFor(state, mm), nowS, layerA },
  cfg: { dao: c.dao, rpc: c.rpc, corsOrigin: '*', authRecipient: 'quiet-treasury.worker' },
});
const srv = await api.listen(8791);
const get = async (p: string) => (await fetch(`http://127.0.0.1:8791${p}`)).json() as Promise<any>;
const [chunks, ledger, reportApi, checks, balances] = await Promise.all([get(`/api/mandates/${nextId}/chunks`), get('/api/ledger'), get(`/api/report/${nextId}`), get(`/api/verify/${nextId}`), get('/api/balances')]);
srv.close();
check('GET /api/verify: every check green', Array.isArray(checks) && checks.length > 5 && checks.every((x: any) => x.ok), (checks as any[]).filter((x) => !x.ok).map((x) => x.name).join('; '));

const { anchored: _a, ...reportClean } = state.report(nextId);
const bundle = { attestation: { report: attestation, nonce }, completions: completions.map((x) => ({ label: x.label, model: x.model, requestBody: x.requestBody, responseBody: x.responseBody, signature: x.signature })), report: reportClean };
mkdirSync('data/demo-run', { recursive: true }); mkdirSync('app/public/demo-run', { recursive: true });
if (existsSync('data/demo-run/run.json') && !existsSync('data/demo-run/run-simulated.json')) { copyFileSync('data/demo-run/run.json', 'data/demo-run/run-simulated.json'); copyFileSync('data/demo-run/proof-bundle.json', 'data/demo-run/proof-bundle-simulated.json'); }
if (existsSync('app/public/demo-run/run.json') && !existsSync('app/public/demo-run/run-simulated.json')) copyFileSync('app/public/demo-run/run.json', 'app/public/demo-run/run-simulated.json');
writeFileSync('data/demo-run/proof-bundle.json', JSON.stringify(bundle, null, 2));
const ver = verifyBundle(bundle as any);
check('independent verifier: attestation nonce, TEE signatures, report hash, price floor, no violations', ver.ok, `${ver.checks.filter((x) => x.ok).length}/${ver.checks.length}`);

const proposals = (await sp.listProposals(c.rpc, c.dao, 0, 150)).map((p) => ({ id: p.id, status: p.status, description: p.description, kind: Object.keys(p.kind)[0], votes: p.votes }));
const mandate1 = await mc.getMandate(c.rpc, c.mandate, nextId), mandate2 = await mc.getMandate(c.rpc, c.mandate, id2);
const failed = results.filter((r) => !r[1]);
const swapTxs = chunks1.map((x) => ({ index: x.idx, tx: x.request_id, explorer: explorerTx(x.request_id!), in: x.size, out: x.amount_out }));
const real = {
  vault: { accountId: VAULT, explorer: explorerAccount(VAULT) },
  pool: { before: poolBefore, dex: 'ref-finance-101.testnet' },
  swaps: swapTxs,
  payouts: items1.map((i) => ({ kind: i.kind, label: i.label, to: i.address, token: i.token, amount: i.amount, status: i.status, tx: i.dest_tx ?? i.request_id, explorer: i.request_id ? explorerTx(i.request_id) : null })),
  balanceDeltas: { aliceUsdt: (after.alice - before.alice).toString(), bobUsdt: (after.bob - before.bob).toString(), operatorUsdt: (after.operator - before.operator).toString(), daoUsdt: (after.daoUsdt - before.daoUsdt).toString() },
  oneShot: stored?.oneShot ?? null,
};
const run = {
  recordedAt: new Date().toISOString(),
  note: 'RECORDED RUN on PUBLIC NEAR TESTNET WITH REAL MONEY MOVEMENT. REAL: NEAR AI TEE parsing + signed completions + attestation; Sputnik DAO proposals/votes including a real native-NEAR Transfer proposal that funds the vault; mandate contract state and report anchoring; REAL Ref Finance swaps (wNEAR -> USDT.e); REAL USDT.e payouts and fee to named testnet accounts; REAL leftover returns to the DAO; OutLayer testnet wallet policy (Layer A) denials. NOT PROVEN (mainnet-only): OutLayer TEE custody swaps, confidential swaps, Intents cross-chain payouts. Custody on this path is a worker-held vault key. Testnet token values are worthless play money; Ref testnet pools are thin and have no arbitrageurs.',
  network: 'testnet', mode: 'testnet-real', ids: { ...pub, vault: VAULT, dex: 'ref-finance-101.testnet' }, intent: INTENT,
  parse: { summary: parsed.summary, attempts: parsed.attempts, warnings: parsed.warnings, overrides, model },
  mandate: mandate1, chunks, ledger, report: reportApi, checks, balances, real,
  cancelRun: { mandate: mandate2, items: items2.map((i) => ({ kind: i.kind, to: i.address, amount: i.amount, status: i.status, tx: i.request_id, explorer: i.request_id ? explorerTx(i.request_id) : null })) },
  proposals, redteam: rt, layerA: layerAEvidence, txs, verifier: ver,
  results: results.map(([name, ok, note]) => ({ name, ok, note })),
};
writeFileSync('data/demo-run/run.json', JSON.stringify(run, null, 2));
writeFileSync('app/public/demo-run/run.json', JSON.stringify(run, null, 2));

console.log('\n=========== TESTNET-REAL E2E RESULT ===========');
for (const [nme, ok] of results) console.log(ok ? ' PASS ' : ' FAIL ', nme);
console.log(`${results.length - failed.length}/${results.length} passed`);
console.log('\nOn-chain evidence (public testnet):');
for (const x of txs) console.log(' ', x.label.padEnd(60), explorerTx(x.txHash));
void summaries;
process.exit(failed.length ? 1 : 0);
