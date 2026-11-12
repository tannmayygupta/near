// FULL END-TO-END ON PUBLIC NEAR TESTNET (EXEC_MODE=simulated).
//  REAL here: NEAR AI Cloud TEE parsing + signed completions + attestation, Sputnik DAO proposals/votes, mandate contract state + anchoring,
//             OutLayer testnet wallet POLICY (Layer A) denials, 1Click read-only dry quotes (prices).
//  SIMULATED (source tag 'simulated', request ids `sim-*`): swap fills, payouts, leftovers sweep. They are NOT trades; Intents is mainnet-only.
// Run: npx tsx --env-file=.env scripts/testnet/e2e.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { callTx, NEAR, TGAS, view } from '../../src/near/chain.js';
import * as sp from '../../src/near/sputnik.js';
import * as mc from '../../src/near/mandate.js';
import { NearAiClient } from '../../src/near/ai.js';
import { OutLayerWallet, layerAVerdict } from '../../src/near/outlayer-policy.js';
import { dryQuote, quoteToSample } from '../../src/near/intents.js';
import { BOUNDS, MandateTerms } from '../../src/engine/schema.js';
import { hashJson } from '../../src/engine/hash.js';
import { parseIntent, Llm } from '../../src/engine/parser.js';
import { verifyBundle } from '../../src/verify/index.js';
import { Executor, defaultConfig } from '../../worker/executor.js';
import { RealChain, RealChainOpts } from '../../worker/chain.js';
import { State } from '../../worker/state.js';
import { createApi, termsFor } from '../../worker/api.js';
import { runAttack, ATTACKS } from '../../worker/redteam.js';
import { SimulatedOutLayer } from '../../worker/adapters/simulated-outlayer.js';
import { createSummarizer } from '../../worker/summarizer.js';
import { A, loadConfig, proposeWithHash, voteTx, rec, txs, explorerTx, sleep } from './lib.js';

process.env.EXEC_MODE = 'simulated';
const c = loadConfig();
const pub = JSON.parse(readFileSync('data/testnet-public.json', 'utf8').replace(/^\uFEFF/, ''));
const layerAEvidence = JSON.parse(readFileSync('data/testnet-layer-a.json', 'utf8').replace(/^\uFEFF/, ''));
const SELL = 'nep141:wrap.near', BUY = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const SOL = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', BASE = '0x1111111111111111111111111111111111111111';
const results: Array<[string, boolean, string]> = [];
const check = (n: string, ok: boolean, note = '') => { results.push([n, ok, note]); console.log(ok ? 'PASS' : 'FAIL', n, note); };
const agent = A(c, 'agent');
const nowS = () => Math.floor(Date.now() / 1000);

// ---------- real NEAR AI: attestation + parsing (every completion kept for the verifier) ----------
const ai = new NearAiClient();
const model = await ai.resolveConfidentialModel();
const { report: attestation, nonce } = await ai.fetchAttestation(model);
const completions: any[] = [];
let n = 0;
const llm: Llm = async (system, user) => { const sc = await ai.signedCompletion({ model, system, user }); completions.push({ label: `intent parse #${++n}`, ...sc }); return sc.content; };

const INTENT = `Sell up to 6 NEAR for USDC over the next 5 minutes, never below 1 USDC per NEAR, in chunks of 1 to 2 NEAR every 5 to 8 seconds. ` +
  `Pay 60% of the proceeds to alice on Solana address ${SOL} and 30% to bob on Base address ${BASE}. Take a 0.5% service fee paid to ${c.accounts.contributor.accountId}.`;
const parsed = await parseIntent(INTENT, { dao: c.dao, treasurer: c.accounts.treasurer.accountId, nowS: nowS(), llm });
check('NEAR AI (TEE) parsed the plain-English intent into a valid mandate', !!parsed.terms, `${parsed.attempts} attempt(s)`);
console.log(parsed.summary.join('\n'));

// the recorded run must finish in minutes: enforce a short window and disclose every override of the AI output
const overrides: string[] = [];
let t = { ...parsed.terms } as MandateTerms;
const now0 = nowS();
const fix = (cond: boolean, msg: string, patch: Partial<MandateTerms>) => { if (cond) { overrides.push(msg); t = { ...t, ...patch } as MandateTerms; } };
fix(t.endTs - now0 > 420 || t.endTs - now0 < 90, `window set to 5 minutes for the recorded run (AI proposed ${t.endTs - t.startTs}s)`, { startTs: now0 - 3, endTs: now0 + 300 });
fix(t.intervalMaxS > 10, `intervals set to 5-8 s (AI proposed ${t.intervalMinS}-${t.intervalMaxS}s)`, { intervalMinS: 5, intervalMaxS: 8 });
fix(!t.feeRecipient || t.feeBps === 0, 'fee 0.5% to the contributor account (AI omitted it)', { feeBps: 50, feeRecipient: c.accounts.contributor.accountId });
t = MandateTerms.parse(t);
const nextId = (await view<[string, string, number]>(c.rpc, c.mandate, 'get_config'))[2];
console.log('mandate overrides:', overrides.length ? overrides : 'none');

// ---------- DAO vote creates the mandate (real Sputnik, real tx hashes) ----------
const sim = new SimulatedOutLayer({ recipient: layerAEvidence.wallet.address });
class HChain extends RealChain {
  constructor(private o2: RealChainOpts) { super(o2); }
  private tx(label: string, method: string, args: object) { return callTx(this.o2.agent, this.o2.mandateContract, method, args, TGAS(30)).then((r) => { rec(label, r.txHash); return r; }); }
  listMandates() { return super.listMandates().then((l) => l.filter((mm) => mm.id >= nextId)); } // only this run's mandates (older test mandates stay untouched)
  markFunded(id: number) { return this.tx(`agent: mark_funded #${id}`, 'mark_funded', { id }); }
  recordChunk(id: number, index: number, soldAmount: string) { return this.tx(`agent: record_chunk #${id}.${index}`, 'record_chunk', { id, index, sold_amount: soldAmount }); }
  beginSettlement(id: number) { return this.tx(`agent: begin_settlement #${id}`, 'begin_settlement', { id }); }
  complete(id: number, h: string, v: number, r: string | null) { return this.tx(`agent: complete #${id} (anchors report hash)`, 'complete', { id, report_hash: h, violations: v, revealed_terms: r }); }
}
const chain = new HChain({ rpc: c.rpc, mandateContract: c.mandate, dao: c.dao, agent });
const state = new State(':memory:', Buffer.alloc(32, 9));
const summaries: any[] = [];
const exec = new Executor({
  outlayer: sim, chain, state, clock: { nowS, sleep }, log: (k, f) => { if (!['chunk_submitted'].includes(k)) console.log('  [worker]', k, JSON.stringify(f).slice(0, 170)); },
  benchmark: async (terms, ts) => quoteToSample(await dryQuote({ originAsset: terms.sellToken, destinationAsset: terms.buyToken, amount: (10n ** 23n).toString(), recipient: layerAEvidence.wallet.address, refundTo: layerAEvidence.wallet.address, nowS: () => ts }), terms.sellToken, terms.buyToken),
  summarize: createSummarizer(ai, (sc) => { completions.push({ label: 'settlement summary', ...sc }); summaries.push(sc); }, model),
}, { ...defaultConfig(c.dao), floorRetryS: 5 });
const runUntil = async (cond: () => Promise<boolean> | boolean, maxS: number) => { const t0 = Date.now(); while (Date.now() - t0 < maxS * 1000) { await exec.tick(); if (await cond()) return true; await sleep(3000); } return false; };

const createArgs = (terms: MandateTerms, tier: 'small' | 'mid' | 'large'): mc.CreateArgs => ({ treasurer: terms.treasurer, terms_hash: hashJson(terms), terms_json: JSON.stringify(terms), sell_token: terms.sellToken, max_sell: terms.maxSellAmount, start_ns: terms.startTs * 1e9, end_ns: terms.endTs * 1e9, tier });
const pid = await proposeWithHash(c, 'council1', `Quiet Treasury: sell ${Number(BigInt(t.maxSellAmount) / 10n ** 20n) / 10000} NEAR quietly (mandate #${nextId})`, sp.functionCallKind(c.mandate, 'create_mandate', createArgs(t, 'small')), 'DAO proposal: create_mandate (AI-parsed terms)');
await exec.tick();
check('no execution before the DAO vote', (await mc.getMandate(c.rpc, c.mandate, nextId)) === null && sim.swaps.length === 0);
await voteTx(c, 'council1', pid, 'VoteApprove', 'vote 1/3 approve (council1)');
await voteTx(c, 'council2', pid, 'VoteApprove', 'vote 2/3 approve (council2) -> executes');
let m = (await mc.getMandate(c.rpc, c.mandate, nextId))!;
check('2 of 3 council votes create the mandate on chain', m?.status === 'Approved', m?.status);

// SIMULATED stand-in for "the DAO transfer credited the agent" (that transfer is mainnet-only and unproven)
sim.fund(SELL, BigInt(m.max_sell));
const ok1 = await runUntil(async () => (await chain.getMandate(nextId))?.status === 'Completed', 300);
m = (await chain.getMandate(nextId))!;
check('worker executes chunks and the mandate completes', ok1, `status=${m.status} chunks=${m.chunks}`);
check('chunks recorded on chain == simulated fills', m.chunks === sim.swaps.length && m.chunks >= 2, `chain ${m.chunks} / fills ${sim.swaps.length}`);
check('sold never exceeds the DAO-approved budget', BigInt(m.sold) <= BigInt(m.max_sell), `${m.sold} / ${m.max_sell}`);
check('every swap carried a price floor', sim.swaps.every((s) => !!s.min_amount_out));
const listed = new Set([SOL, BASE, c.accounts.contributor.accountId, c.dao]);
check('every withdrawal goes to the payout list / fee recipient / DAO', sim.withdrawals.length > 0 && sim.withdrawals.every((w) => listed.has(String(w.to))), sim.withdrawals.map((w) => w.to).join(','));
const swapsRun1 = sim.swaps.length;
const stored = state.report(nextId);
check('report hash anchored on chain matches the stored report', /^[0-9a-f]{64}$/.test(m.report_hash ?? '') && stored?.reportHash === m.report_hash, (m.report_hash ?? '').slice(0, 16));
check('fills in the report are tagged "simulated" (never presented as real)', stored?.fills?.length > 0 && stored.fills.every((f: any) => f.source === 'simulated'));
check('NEAR AI signed settlement summary attached', !!stored?.aiSummary?.signer, stored?.aiSummary?.signer);
check('treasurer earned trust on chain', (await mc.getTrust(c.rpc, c.mandate, t.treasurer)) >= 1);

// ---------- run 2: DAO cancels mid-run + red-team ----------
const id2 = (await view<[string, string, number]>(c.rpc, c.mandate, 'get_config'))[2];
const now2 = nowS();
const t2 = MandateTerms.parse({
  dao: c.dao, treasurer: c.accounts.treasurer.accountId, sellToken: SELL, buyToken: BUY, maxSellAmount: NEAR(10).toString(), minPrice: '1.0', startTs: now2 - 3, endTs: now2 + 600,
  chunkMin: NEAR(1).toString(), chunkMax: NEAR(2).toString(), intervalMinS: 5, intervalMaxS: 6,
  payouts: [{ label: 'alice (Solana)', chain: 'solana', address: SOL, token: BUY, percent: 60 }],
  feeBps: 50, feeRecipient: c.accounts.contributor.accountId, returnTo: c.dao, sealed: false,
});
const pid2 = await proposeWithHash(c, 'council1', `Second mandate #${id2} (will be cancelled mid-run)`, sp.functionCallKind(c.mandate, 'create_mandate', createArgs(t2, 'small')), 'DAO proposal: create_mandate #2');
await voteTx(c, 'council2', pid2, 'VoteApprove', 'vote 1/3 approve (council2)'); await voteTx(c, 'council3', pid2, 'VoteApprove', 'vote 2/3 approve (council3) -> executes');
sim.fund(SELL, BigInt(t2.maxSellAmount));
const ok2a = await runUntil(async () => ((await chain.getMandate(id2))?.chunks ?? 0) >= 2, 150);
check('second mandate starts trading', ok2a, `chunks=${(await chain.getMandate(id2))?.chunks}`);

// red team while the mandate is Executing: every attack is a REAL attempt
const wallet = new OutLayerWallet({ owner: { accountId: c.accounts.agent.accountId, secretKey: c.accounts.agent.secretKey }, seed: `quiet-treasury-${c.suffix}` });
const layerA = { transfer: (b: { to: string; amount: string }) => wallet.transfer(b), verdict: layerAVerdict, unlistedTo: 'attacker-unlisted.testnet', allowedTo: c.accounts.contributor.accountId, smallAmount: NEAR('0.01').toString(), overCapAmount: NEAR('0.5').toString() };
const rt: any[] = [];
for (const a of ATTACKS) rt.push(await runAttack(a, id2, { chain, outlayer: sim, termsFor: (mm) => termsFor(state, mm), nowS, layerA }));
for (const r of rt) console.log(r.blocked ? '  blocked' : '  NOT BLOCKED', r.attack.padEnd(16), r.layer, '|', String(r.error).slice(0, 110));
check('red-team: all 6 real attacks blocked, each naming its layer', rt.length === 6 && rt.every((r) => r.blocked && /^(A|B)/.test(r.layer)), rt.map((r) => `${r.attack}:${r.layer[0]}`).join(' '));
check('Layer A (OutLayer wallet policy) produced real denials', rt.filter((r) => r.layer.startsWith('A')).length >= 2, rt.filter((r) => r.layer.startsWith('A')).map((r) => r.attack).join(','));

const swapsBeforeCancel = sim.swaps.length;
const cid = await proposeWithHash(c, 'council1', `Cancel mandate #${id2}`, sp.functionCallKind(c.mandate, 'cancel_mandate', { id: id2 }), 'DAO proposal: cancel_mandate');
await voteTx(c, 'council1', cid, 'VoteApprove', 'cancel vote 1/3'); await voteTx(c, 'council3', cid, 'VoteApprove', 'cancel vote 2/3 -> executes');
check('DAO cancel executes on chain', (await mc.getMandate(c.rpc, c.mandate, id2))?.status === 'Cancelled');
const ok2 = await runUntil(() => state.runtime(id2).phase === 'done', 90);
const swapsAfterCancel = sim.swaps.length;
check('worker stops within a tick and returns everything to the DAO', ok2 && swapsAfterCancel - swapsBeforeCancel <= 1, `swaps after cancel: ${swapsAfterCancel - swapsBeforeCancel}`);
const w2 = sim.withdrawals.slice(sim.withdrawals.length - state.items(id2).length);
check('cancelled mandate paid nobody except the DAO', w2.length > 0 && w2.every((w) => w.to === c.dao), w2.map((w) => w.to).join(','));

// ---------- collect evidence: worker API (same code the dashboard reads), proposals, verifier ----------
const api = createApi({
  state, chain, outlayer: sim, nowS, health: () => ({ net: 'testnet', mode: 'simulated' }),
  isCouncil: async (a) => ['council1', 'council2', 'council3'].some((k) => c.accounts[k].accountId === a),
  redteam: { chain, outlayer: sim, termsFor: (mm) => termsFor(state, mm), nowS, layerA },
  cfg: { dao: c.dao, rpc: c.rpc, corsOrigin: '*', authRecipient: 'quiet-treasury.worker' },
});
const srv = await api.listen(8790);
const get = async (p: string) => (await fetch(`http://127.0.0.1:8790${p}`)).json() as Promise<any>;
const [chunks, ledger, reportApi, checks, balances] = await Promise.all([get(`/api/mandates/${nextId}/chunks`), get('/api/ledger'), get(`/api/report/${nextId}`), get(`/api/verify/${nextId}`), get('/api/balances')]);
srv.close();
check('GET /api/verify: every check green', Array.isArray(checks) && checks.length > 5 && checks.every((x: any) => x.ok), (checks as any[]).filter((x) => !x.ok).map((x) => x.name).join('; '));

const { anchored: _a, ...reportClean } = state.report(nextId);
const bundle = { attestation: { report: attestation, nonce }, completions: completions.map((x) => ({ label: x.label, model: x.model, requestBody: x.requestBody, responseBody: x.responseBody, signature: x.signature })), report: reportClean };
mkdirSync('data/demo-run', { recursive: true }); mkdirSync('app/public/demo-run', { recursive: true });
writeFileSync('data/demo-run/proof-bundle.json', JSON.stringify(bundle, null, 2));
const ver = verifyBundle(bundle as any);
check('independent verifier: attestation nonce, TEE signatures, report hash, price floor, no violations', ver.ok, `${ver.checks.filter((x) => x.ok).length}/${ver.checks.length}`);

const proposals = (await sp.listProposals(c.rpc, c.dao, 0, 100)).map((p) => ({ id: p.id, status: p.status, description: p.description, kind: Object.keys(p.kind)[0], votes: p.votes }));
const mandate1 = await mc.getMandate(c.rpc, c.mandate, nextId), mandate2 = await mc.getMandate(c.rpc, c.mandate, id2);
const failed = results.filter((r) => !r[1]);
const run = {
  recordedAt: new Date().toISOString(),
  note: 'RECORDED RUN on PUBLIC NEAR TESTNET. REAL: NEAR AI TEE parsing + signed completions + attestation, Sputnik DAO proposals/votes, mandate contract state and report anchoring, OutLayer testnet wallet policy (Layer A) denials, 1Click read-only dry quotes. SIMULATED (source "simulated", request ids sim-*): swap fills, payouts and leftover sweeps. They are NOT real trades (NEAR Intents exists only on mainnet).',
  network: 'testnet', mode: 'simulated fills', ids: pub, intent: INTENT, parse: { summary: parsed.summary, attempts: parsed.attempts, warnings: parsed.warnings, overrides, model },
  mandate: mandate1, chunks, ledger, report: reportApi, checks, balances,
  cancelRun: { mandate: mandate2, items: state.items(id2).map((i) => ({ kind: i.kind, to: i.address, amount: i.amount, status: i.status })) },
  proposals, redteam: rt, layerA: layerAEvidence, txs, verifier: ver,
  results: results.map(([name, ok, note]) => ({ name, ok, note })),
};
writeFileSync('data/demo-run/run.json', JSON.stringify(run, null, 2));
writeFileSync('app/public/demo-run/run.json', JSON.stringify(run, null, 2));

console.log('\n=========== TESTNET E2E RESULT ===========');
for (const [nme, ok] of results) console.log(ok ? ' PASS ' : ' FAIL ', nme);
console.log(`${results.length - failed.length}/${results.length} passed`);
console.log('\nOn-chain evidence (public testnet):');
for (const x of txs) console.log(' ', x.label.padEnd(52), explorerTx(x.txHash));
void swapsRun1; void summaries;
process.exit(failed.length ? 1 : 0);




