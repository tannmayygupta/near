// THE MAINNET SLICE, END TO END (or, with QT_NET=testnet, a rehearsal of the very same script on public testnet).
// One mandate, tiny on purpose: the owner's real NEAR is sold on Ref Finance through a DAO-voted mandate; real USDC goes to named accounts, the service fee,
// and the leftovers return to the DAO; the report hash is anchored on chain. Nothing here is simulated and nothing here is a claim about size.
// REAL: NEAR AI (TEE) parsing + signed completions + attestation; Sputnik DAO proposals and 2-of-3 votes incl. a native-NEAR Transfer proposal that funds the vault;
//       the mandate contract (committed wasm, code hash checked); a FUNCTION-CALL agent key (Layer 0); Ref Finance swaps; USDC payouts/fee/returns.
// NOT IN THIS RUN (stated in the docs): OutLayer custody/policy (the vault is a key held by the worker: Layer A is not part of the mainnet slice), cancel run, red team
// (both are proven on testnet), confidential swaps, Intents payouts.
// Run: $env:ALLOW_MAINNET='1'; npx tsx --env-file=.env scripts/mainnet/e2e-mainnet.ts        (rehearsal: $env:QT_NET='testnet')
import './profile.js'; // MUST stay first
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { baseEncode } from 'near-api-js';
import { createHash } from 'node:crypto';
import { callTx, NEAR, TGAS, view, providerFor, accountFor } from '../../src/near/chain.js';
import * as sp from '../../src/near/sputnik.js';
import * as mc from '../../src/near/mandate.js';
import { NearAiClient } from '../../src/near/ai.js';
import { MandateTerms } from '../../src/engine/schema.js';
import { hashJson } from '../../src/engine/hash.js';
import { parseIntent, Llm, fromUnits } from '../../src/engine/parser.js';
import { verifyBundle } from '../../src/verify/index.js';
import { Executor, defaultConfig } from '../../worker/executor.js';
import { RealChain, RealChainOpts } from '../../worker/chain.js';
import { State } from '../../worker/state.js';
import { createApi } from '../../worker/api.js';
import { RefTestnetAdapter as RefAdapter, isTxHash } from '../../worker/adapters/ref-testnet.js';
import { createSummarizer } from '../../worker/summarizer.js';
import { pricesSane, priceList, loadConfig, proposeWithHash, voteTx, rec, txs, explorerTx, explorerAccount, sleep, PUBLIC_PATH, TAG } from '../testnet/lib.js';
import { mainnetRefPrice } from '../testnet/vault.js';
import { P, IS_MAINNET, LIMITS, requireMainnetConsent } from './net.js';

requireMainnetConsent('sell real NEAR on Ref Finance');
const c = loadConfig();
const pub = JSON.parse(readFileSync(PUBLIC_PATH, 'utf8').replace(/^﻿/, ''));
const SELL = P.sellToken, BUY = P.buyToken, STABLE = P.stable, SYM = P.stableSymbol;
const OUT = IS_MAINNET ? 'data/demo-run/mainnet' : `data/secret/${TAG}`;
const results: Array<[string, boolean, string]> = [];
const check = (n: string, ok: boolean, note = '') => { results.push([n, ok, note]); console.log(ok ? 'PASS' : 'FAIL', n, note); };
const nowS = () => Math.floor(Date.now() / 1000);
const nearH = (y: bigint | string) => (Number(BigInt(y) / 10n ** 20n) / 10_000).toString();
const stableOf = async (acct: string) => BigInt(await view<string>(c.rpc, STABLE, 'ft_balance_of', { account_id: acct }).catch(() => '0'));
const natOf = async (acct: string) => BigInt((await providerFor(c.rpc).viewAccount({ accountId: acct })).amount);
const txOnChain = async (hash: string, signer: string) => { try { const o: any = await providerFor(c.rpc).viewTransactionStatus({ txHash: hash, accountId: signer, waitUntil: 'EXECUTED_OPTIMISTIC' } as any); return !!(o?.transaction?.hash ?? o?.transaction_outcome?.id); } catch { return false; } };
const die = (m: string): never => { console.error('STOP:', m); process.exit(1); };

// ---------- who is who
const VAULT = c.accounts.vault?.accountId ?? die('no vault in the config: run scripts/mainnet/setup.ts first');
const vault = accountFor(c.rpc, VAULT, c.accounts.vault.secretKey);
const ALICE = c.accounts.contributor.accountId, BOB = c.accounts.treasurer.accountId, FEE = c.accounts.funder.accountId;
const scopedFile = JSON.parse(readFileSync(`data/secret/${TAG}-scoped-key.json`, 'utf8'));
const agent = accountFor(c.rpc, c.accounts.agent.accountId, scopedFile.secretKey); // FUNCTION-CALL key only: it can call 5 methods on the mandate contract and nothing else

// ---------- pre-flight (all read-only): refuse to start on anything unexpected
const wasm = readFileSync('contracts/mandate/out/mandate.wasm');
const localHash = baseEncode(createHash('sha256').update(wasm).digest());
const acctInfo: any = await providerFor(c.rpc).viewAccount({ accountId: c.mandate });
const stats: any = await view(c.rpc, c.mandate, 'get_stats');
if ((acctInfo.codeHash ?? acctInfo.code_hash) !== localHash) die('the mandate contract on chain is not the committed wasm');
if (stats.dao !== c.dao || stats.agent !== c.accounts.agent.accountId || stats.version !== 2) die('the mandate contract is not initialised for this DAO and agent');
const treasuryBefore = await natOf(c.dao);
if (treasuryBefore < NEAR('1.5')) die(`the DAO treasury holds only ${nearH(treasuryBefore)} NEAR; it must fund the budget`);

// the vault's gas/storage float BEFORE any DAO funding; remembered in a file so a re-run after a partial run cannot mistake funding for float
const RESERVE_FILE = `data/secret/${TAG}-vault-reserve.json`;
let vaultReserve: bigint;
if (existsSync(RESERVE_FILE)) vaultReserve = BigInt(JSON.parse(readFileSync(RESERVE_FILE, 'utf8')).yocto);
else { vaultReserve = await natOf(VAULT); writeFileSync(RESERVE_FILE, JSON.stringify({ yocto: vaultReserve.toString() })); }
const ref = new RefAdapter({
  vault, rpc: c.rpc, dex: P.dex, wrap: P.wrap, poolIds: P.poolIds, reserveYocto: vaultReserve, ledgerPath: `data/secret/ref-ledger-${TAG}.json`, refPrice: mainnetRefPrice,
  log: (k, f) => { if (k === 'tx') rec(`vault: ${f.contract}.${f.method}`, String(f.hash)); },
});
console.log(`network ${P.name} | vault ${VAULT} float ${nearH(vaultReserve)} NEAR | DAO ${c.dao} treasury ${nearH(treasuryBefore)} NEAR | contract ${c.mandate}`);

// ---------- real NEAR AI: attestation + parsing
const ai = new NearAiClient();
const model = await ai.resolveConfidentialModel();
const { report: attestation, nonce } = await ai.fetchAttestation(model);
const completions: any[] = [];
let n = 0;
const llm: Llm = async (system, user) => { const sc = await ai.signedCompletion({ model, system, user }); completions.push({ label: `intent parse #${++n}`, ...sc }); return sc.content; };
const INTENT = `Sell up to ${LIMITS.maxSellNear} NEAR for ${SYM} over the next 6 minutes, never below 2 ${SYM} per NEAR, in chunks of 0.1 to 0.2 NEAR every 20 to 40 seconds. ` +
  `Pay 50% of the proceeds to alice at ${ALICE} and 20% to bob at ${BOB}, both on near. Take a 0.5% service fee paid to ${FEE}.`;
const parsed = await parseIntent(INTENT, { dao: c.dao, treasurer: c.accounts.treasurer.accountId, nowS: nowS(), llm });
check('NEAR AI (TEE) parsed the plain-English intent into a valid mandate', !!parsed.terms, `${parsed.attempts} attempt(s)`);
console.log(parsed.summary.join('\n'));

// deterministic overrides: the AI proposes, code decides (every override is recorded in the run)
const overrides: string[] = [];
let t = { ...parsed.terms } as MandateTerms;
const now0 = nowS();
const fix = (cond: boolean, msg: string, patch: Partial<MandateTerms>) => { if (cond) { overrides.push(msg); t = { ...t, ...patch } as MandateTerms; } };
fix(BigInt(t.maxSellAmount) > NEAR(LIMITS.maxSellNear), `budget capped at ${LIMITS.maxSellNear} NEAR (hard limit of the mainnet slice; AI proposed ${fromUnits(t.maxSellAmount, 24, 2)})`, { maxSellAmount: NEAR(LIMITS.maxSellNear).toString() });
fix(t.endTs - now0 > 600 || t.endTs - now0 < 120, `window set to 6 minutes (AI proposed ${t.endTs - t.startTs}s)`, { startTs: now0 - 3, endTs: now0 + 360 });
fix(t.intervalMinS < 15 || t.intervalMaxS > 60, `intervals set to 20-40 s (AI proposed ${t.intervalMinS}-${t.intervalMaxS}s)`, { intervalMinS: 20, intervalMaxS: 40 });
fix(BigInt(t.chunkMax) > NEAR('0.25') || BigInt(t.chunkMin) < NEAR('0.05'), 'chunks set to 0.1-0.2 NEAR', { chunkMin: NEAR('0.1').toString(), chunkMax: NEAR('0.2').toString() });
fix(!t.feeRecipient || t.feeBps !== 50 || t.feeRecipient !== FEE, 'fee 0.5% to the fee account', { feeBps: 50, feeRecipient: FEE });
fix(t.payouts.length !== 2 || t.payouts[0]?.address !== ALICE || t.payouts[1]?.address !== BOB, 'payouts set to alice 50% / bob 20%', { payouts: [
  { label: 'alice', chain: 'near', address: ALICE, token: BUY, percent: 50 }, { label: 'bob', chain: 'near', address: BOB, token: BUY, percent: 20 }] });
fix(Number(t.minPrice) > 2.8 || Number(t.minPrice) < 1.5, `price floor set to 2 (AI proposed ${t.minPrice})`, { minPrice: '2' });
fix(t.sellToken !== SELL || t.buyToken !== BUY, 'tokens set to wNEAR / the stable token of this network', { sellToken: SELL, buyToken: BUY });
t = MandateTerms.parse(t);
const nextId = (await view<[string, string, number]>(c.rpc, c.mandate, 'get_config'))[2];
console.log('mandate overrides:', overrides.length ? overrides : 'none');

// ---------- worker wiring
class HChain extends RealChain {
  constructor(private o2: RealChainOpts, private fromId: () => number) { super(o2); }
  private tx(label: string, method: string, args: object) { return callTx(this.o2.agent, this.o2.mandateContract, method, args, TGAS(30)).then((r) => { rec(label, r.txHash); return r; }); }
  listMandates() { return super.listMandates().then((l) => l.filter((mm) => mm.id >= this.fromId())); }
  markFunded(id: number) { return this.tx(`agent: mark_funded #${id}`, 'mark_funded', { id }); }
  recordChunk(id: number, index: number, soldAmount: string) { return this.tx(`agent: record_chunk #${id}.${index}`, 'record_chunk', { id, index, sold_amount: soldAmount }); }
  beginSettlement(id: number) { return this.tx(`agent: begin_settlement #${id}`, 'begin_settlement', { id }); }
  complete(id: number, h: string, v: number, r: string | null) { return this.tx(`agent: complete #${id} (anchors report hash)`, 'complete', { id, report_hash: h, violations: v, revealed_terms: r }); }
}
const chain = new HChain({ rpc: c.rpc, mandateContract: c.mandate, dao: c.dao, agent }, () => nextId);
const state = new State(':memory:', Buffer.alloc(32, 9));
const summaries: any[] = [];
const exec = new Executor({
  outlayer: ref, chain, state, clock: { nowS, sleep }, log: (k, f) => { if (!['chunk_submitted', 'awaiting_approval'].includes(k)) console.log('  [worker]', k, JSON.stringify(f).slice(0, 190)); },
  benchmark: (terms) => ref.spotSample(terms.sellToken, terms.buyToken, 24, 6),
  poolSnapshot: async (terms) => { const s = await ref.poolSnapshot(terms.sellToken, terms.buyToken, BigInt(terms.chunkMax)); return s ? { poolId: s.poolId, reserveIn: s.reserveIn, reserveOut: s.reserveOut, feeBps: s.feeBps, ts: s.ts } : null; },
  summarize: createSummarizer(ai, (sc) => { completions.push({ label: 'settlement summary', ...sc }); summaries.push(sc); }, model),
}, { ...defaultConfig(c.dao), floorRetryS: 15, requestWaitMs: 180_000 });
const runUntil = async (cond: () => Promise<boolean> | boolean, maxS: number) => { const t0 = Date.now(); while (Date.now() - t0 < maxS * 1000) { await exec.tick(); if (await cond()) return true; await sleep(3000); } return false; };
const createArgs = (terms: MandateTerms): mc.CreateArgs => ({ treasurer: terms.treasurer, terms_hash: hashJson(terms), terms_json: JSON.stringify(terms), sell_token: terms.sellToken, max_sell: terms.maxSellAmount, start_ns: terms.startTs * 1e9, end_ns: terms.endTs * 1e9, tier: 'small' });

const before = { alice: await stableOf(ALICE), bob: await stableOf(BOB), fee: await stableOf(FEE), daoStable: await stableOf(c.dao) };
const poolBefore = await ref.poolSnapshot(SELL, BUY, 10n ** 22n);

// ================= DAO vote -> REAL funding transfer -> REAL swaps -> REAL payouts =================
const pid = await proposeWithHash(c, 'council1', `Quiet Treasury: sell ${fromUnits(t.maxSellAmount, 24, 2)} NEAR quietly for ${SYM} (mandate #${nextId})`, sp.functionCallKind(c.mandate, 'create_mandate', createArgs(t)), 'DAO proposal: create_mandate (AI-parsed terms)');
await exec.tick();
check('no execution before the DAO vote', (await mc.getMandate(c.rpc, c.mandate, nextId)) === null && (await ref.confidentialBalance(SELL)).balance === '0');
await voteTx(c, 'council1', pid, 'VoteApprove', 'vote 1/3 approve (council1)');
await voteTx(c, 'council2', pid, 'VoteApprove', 'vote 2/3 approve (council2) -> executes');
let m = (await mc.getMandate(c.rpc, c.mandate, nextId))!;
check('2 of 3 council votes create the mandate on chain', m?.status === 'Approved', m?.status);

const fid = await proposeWithHash(c, 'council1', `Fund the agent vault with ${fromUnits(t.maxSellAmount, 24, 2)} NEAR for mandate #${nextId}`, sp.transferKind('', VAULT, t.maxSellAmount), 'DAO proposal: Transfer budget (native NEAR) DAO -> agent vault');
await voteTx(c, 'council1', fid, 'VoteApprove', 'funding vote 1/3 (council1)');
for (let i = 0; i < 3; i++) await exec.tick();
check('one vote does NOT fund the vault; worker waits', BigInt((await ref.confidentialBalance(SELL)).balance) === 0n && state.runtime(nextId).phase !== 'done');
await voteTx(c, 'council3', fid, 'VoteApprove', 'funding vote 2/3 (council3) -> executes the REAL transfer');
const budget = BigInt((await ref.confidentialBalance(SELL)).balance);
check('DAO funding transfer credited the vault (real native NEAR)', budget >= BigInt(t.maxSellAmount) - 10n ** 20n, `${nearH(budget)} NEAR budget`);

const ok1 = await runUntil(async () => (await chain.getMandate(nextId))?.status === 'Completed', 900);
m = (await chain.getMandate(nextId))!;
check('worker executes REAL swaps and the mandate completes', ok1, `status=${m.status} chunks=${m.chunks}`);
const items1 = state.items(nextId), chunks1 = state.chunks(nextId).filter((x) => x.status === 'success');
check('chunks recorded on chain == real swaps executed', m.chunks === chunks1.length && m.chunks >= 2, `chain ${m.chunks} / swaps ${chunks1.length}`);
check('sold never exceeds the DAO-approved budget', BigInt(m.sold) <= BigInt(m.max_sell), `${nearH(m.sold)} / ${nearH(m.max_sell)} NEAR`);
check('every swap request id is a real transaction hash that exists on chain', chunks1.length > 0 && chunks1.every((x) => isTxHash(x.request_id)) && (await Promise.all(chunks1.map((x) => txOnChain(x.request_id!, VAULT)))).every(Boolean), chunks1.map((x) => (x.request_id ?? '').slice(0, 8)).join(','));
const stored = state.report(nextId);
check('report fills are tagged chain (never simulated)', stored?.fills?.length > 0 && stored.fills.every((f: any) => f.source === 'chain'));
check('every swap respected the price floor', stored?.floorRespected === true && state.violations(nextId).length === 0, `worst ${stored?.totals?.worstFillPrice?.value}`);
const rows = chunks1.map((x) => ({ in: x.size, out: x.amount_out ?? '0' }));
check(`every swap executed at a market-like price (0.3-15 ${SYM} per NEAR)`, pricesSane(rows), priceList(rows));
const after = { alice: await stableOf(ALICE), bob: await stableOf(BOB), fee: await stableOf(FEE), daoStable: await stableOf(c.dao) };
const paid = (label: string) => BigInt(items1.find((i) => i.label === label && i.status === 'success')?.amount ?? '0');
check(`alice (named account) really received her ${SYM} payout`, paid('alice') > 0n && after.alice - before.alice === paid('alice'), `+${after.alice - before.alice} (expected ${paid('alice')})`);
check(`bob (named account) really received his ${SYM} payout`, paid('bob') > 0n && after.bob - before.bob === paid('bob'), `+${after.bob - before.bob} (expected ${paid('bob')})`);
const feeItem = items1.find((i) => i.kind === 'fee');
check('service fee really paid to the fee account', !!feeItem && feeItem.status === 'success' && after.fee - before.fee === BigInt(feeItem.amount), `+${after.fee - before.fee}`);
const retBuy = items1.find((i) => i.kind === 'return_buy'), retSell = items1.find((i) => i.kind === 'return_sell');
check(`leftover proceeds (${SYM}) really returned to the DAO`, !retBuy || (retBuy.status === 'success' && after.daoStable - before.daoStable === BigInt(retBuy.amount)), retBuy ? `+${retBuy.amount}` : 'none left');
check('unspent budget (native NEAR) really returned to the DAO', !retSell || (retSell.status === 'success' && isTxHash(retSell.request_id)), retSell ? `${nearH(retSell.amount)} NEAR` : 'fully sold');
check('report hash anchored on chain matches the stored report', /^[0-9a-f]{64}$/.test(m.report_hash ?? '') && stored?.reportHash === m.report_hash, (m.report_hash ?? '').slice(0, 16));
check('NEAR AI signed settlement summary attached', !!stored?.aiSummary?.signer, stored?.aiSummary?.signer);
check('report states what ONE swap would have returned (honest AMM baseline)', !!stored?.oneShot, stored?.oneShot ? `chunked vs one-shot ${stored.oneShot.chunkedVsOneShotBps} bps` : 'missing');
check('treasurer earned trust on chain', (await mc.getTrust(c.rpc, c.mandate, t.treasurer)) >= 1);
{ const ak: any = await providerFor(c.rpc).viewAccessKey({ accountId: c.accounts.agent.accountId, publicKey: scopedFile.publicKey } as any).catch(() => null); const fc = ak?.permission?.FunctionCall;
  check('the worker drives the mandate contract with a FUNCTION-CALL key (not full access): receiver = the mandate contract, only the 5 agent methods', !!fc && fc.receiver_id === c.mandate && fc.method_names.length === 5 && ['mark_funded', 'record_chunk', 'begin_settlement', 'complete', 'expire'].every((x) => fc.method_names.includes(x)), fc ? fc.method_names.join(',') : 'key not found'); }
check('the deployed contract code hash equals the committed wasm', (acctInfo.codeHash ?? acctInfo.code_hash) === localHash, localHash);

// ---------- evidence: worker API (same code the dashboard reads), proposals, verifier
const api = createApi({
  state, chain, outlayer: ref, nowS, health: () => ({ net: P.name, mode: 'key-held-vault' }),
  isCouncil: async (a) => ['council1', 'council2', 'council3'].some((k) => c.accounts[k].accountId === a),
  redteam: undefined as any,
  cfg: { dao: c.dao, rpc: c.rpc, corsOrigin: '*', authRecipient: 'quiet-treasury.worker' },
});
const srv = await api.listen(8792);
const get = async (p: string) => (await fetch(`http://127.0.0.1:8792${p}`)).json() as Promise<any>;
const [chunks, ledger, reportApi, checks, balances] = await Promise.all([get(`/api/mandates/${nextId}/chunks`), get('/api/ledger'), get(`/api/report/${nextId}`), get(`/api/verify/${nextId}`), get('/api/balances')]);
srv.close();
check('GET /api/verify: every check green', Array.isArray(checks) && checks.length > 5 && checks.every((x: any) => x.ok), (checks as any[]).filter((x) => !x.ok).map((x) => x.name).join('; '));
const { anchored: _a, ...reportClean } = state.report(nextId);
const bundle = { attestation: { report: attestation, nonce }, completions: completions.map((x) => ({ label: x.label, model: x.model, requestBody: x.requestBody, responseBody: x.responseBody, signature: x.signature })), report: reportClean };
mkdirSync('data/demo-run', { recursive: true }); mkdirSync('app/public/demo-run', { recursive: true }); mkdirSync('data/secret', { recursive: true });
writeFileSync(`${OUT}-proof-bundle.json`, JSON.stringify(bundle, null, 2));
const ver = verifyBundle(bundle as any);
check('independent verifier: attestation nonce, TEE signatures, report hash, price floor, no violations', ver.ok, `${ver.checks.filter((x) => x.ok).length}/${ver.checks.length}`);

const proposals = (await sp.listProposals(c.rpc, c.dao, 0, 50)).map((p) => ({ id: p.id, status: p.status, description: p.description, kind: Object.keys(p.kind)[0], votes: p.votes }));
const mandate1 = await mc.getMandate(c.rpc, c.mandate, nextId);
const failed = results.filter((r) => !r[1]);
const real = {
  vault: { accountId: VAULT, explorer: explorerAccount(VAULT) },
  pool: { before: poolBefore, dex: P.dex },
  swaps: chunks1.map((x) => ({ index: x.idx, tx: x.request_id, explorer: explorerTx(x.request_id!), in: x.size, out: x.amount_out })),
  payouts: items1.map((i) => ({ kind: i.kind, label: i.label, to: i.address, token: i.token, amount: i.amount, status: i.status, tx: i.dest_tx ?? i.request_id, explorer: i.request_id ? explorerTx(i.request_id) : null })),
  balanceDeltas: { aliceStable: (after.alice - before.alice).toString(), bobStable: (after.bob - before.bob).toString(), feeStable: (after.fee - before.fee).toString(), daoStable: (after.daoStable - before.daoStable).toString() },
  oneShot: stored?.oneShot ?? null,
};
const run = {
  recordedAt: new Date().toISOString(),
  note: IS_MAINNET
    ? 'RECORDED RUN ON NEAR MAINNET WITH REAL MONEY (a few US dollars on purpose). REAL: NEAR AI TEE parsing + signed completions + attestation; a Sputnik DAO and 2-of-3 votes by council accounts that the AUTHORS control; the mandate contract (committed wasm, code hash checked); a function-call agent key; Ref Finance swaps wNEAR -> USDC; USDC payouts/fee/returns to accounts the authors control. NOT IN THIS RUN: OutLayer custody and wallet policy (the vault is a key held by the worker), confidential swaps, Intents payouts, a cancel run and a red team (both proven on testnet).'
    : 'REHEARSAL of the mainnet script on public testnet. Not evidence of anything on mainnet.',
  network: IS_MAINNET ? 'mainnet' : 'testnet', mode: 'key-held-vault', ids: { ...pub, vault: VAULT, dex: P.dex, mandateContract: c.mandate, agent: c.accounts.agent.accountId }, intent: INTENT,
  parse: { summary: parsed.summary, attempts: parsed.attempts, warnings: parsed.warnings, overrides, model },
  mandate: mandate1, chunks, ledger, report: reportApi, checks, balances, real, proposals, txs, verifier: ver,
  results: results.map(([name, ok, note]) => ({ name, ok, note })),
};
writeFileSync(`${OUT}-run.json`, JSON.stringify(run, null, 2));
if (IS_MAINNET) { copyFileSync(`${OUT}-run.json`, 'app/public/demo-run/mainnet-run.json'); copyFileSync(`${OUT}-proof-bundle.json`, 'app/public/demo-run/mainnet-proof-bundle.json'); }

console.log(`\n=========== ${P.name.toUpperCase()} E2E RESULT ===========`);
for (const [nme, ok] of results) console.log(ok ? ' PASS ' : ' FAIL ', nme);
console.log(`${results.length - failed.length}/${results.length} passed`);
console.log('\nOn-chain evidence:');
for (const x of txs) console.log(' ', x.label.padEnd(60), explorerTx(x.txHash));
void summaries;
process.exit(failed.length ? 1 : 0);
