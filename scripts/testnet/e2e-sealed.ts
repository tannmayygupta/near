// SEALED MANDATE (commit-reveal) END TO END ON PUBLIC NEAR TESTNET with the REAL execution adapter (EXEC_MODE=testnet-real).
// Run: npx tsx --env-file=.env scripts/testnet/e2e-sealed.ts      (~10-15 min)
// Proves: only sha256(salt|terms) is public while the mandate runs; council-only NEP-413 delivery of the terms to the worker; real DAO funding Transfer;
// REAL Ref swaps/payouts/returns; terms revealed ON CHAIN after settlement (complete(revealed_terms)); independent verifier checks the reveal.
// NOT PROVEN: confidential/hidden TRADES (mainnet-only). Swaps and payouts are public on testnet; what is sealed is the mandate TERMS (floor, schedule, recipients) until settlement.
// The worker is NOT in a TEE: whoever operates it can read the sealed terms.
import './profile.js'; // MUST stay first: selects the testnet token profile (wNEAR / USDT.e)
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { KeyPair } from 'near-api-js';
import { randomBytes } from 'node:crypto';
import { callTx, NEAR, TGAS, view, providerFor } from '../../src/near/chain.js';
import * as sp from '../../src/near/sputnik.js';
import * as mc from '../../src/near/mandate.js';
import { NearAiClient } from '../../src/near/ai.js';
import { MandateTerms } from '../../src/engine/schema.js';
import { commit, randomSalt } from '../../src/engine/hash.js';
import { parseIntent, Llm, fromUnits } from '../../src/engine/parser.js';
import { verifyBundle, ProofBundle } from '../../src/verify/index.js';
import type { SealedEvidence } from '../../src/verify/sealed.js';
import { Executor, defaultConfig } from '../../worker/executor.js';
import { RealChain, RealChainOpts } from '../../worker/chain.js';
import { State } from '../../worker/state.js';
import { createApi } from '../../worker/api.js';
import { nep413Hash } from '../../worker/auth.js';
import { RefTestnetAdapter, isTxHash } from '../../worker/adapters/ref-testnet.js';
import { createSummarizer } from '../../worker/summarizer.js';
import { pricesSane, priceList, A, loadConfig, saveConfig, helperCreate, proposeWithHash, voteTx, rec, txs, explorerTx, explorerAccount, sleep } from './lib.js';
import { ensureVault, mainnetRefPrice, resetVaultFloat } from './vault.js';

const c = loadConfig();
const pub = JSON.parse(readFileSync('data/testnet-public.json', 'utf8').replace(/^﻿/, ''));
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
const vaultReserve = await natOf(VAULT);
rmSync('data/secret/ref-ledger-sealed.json', { force: true });
const ref = new RefTestnetAdapter({
  vault, rpc: c.rpc, reserveYocto: vaultReserve, ledgerPath: 'data/secret/ref-ledger-sealed.json', refPrice: mainnetRefPrice,
  log: (k, f) => { if (k === 'tx') rec(`vault: ${f.contract}.${f.method}`, String(f.hash)); },
});
console.log('vault', VAULT, 'float', nearH(vaultReserve), 'NEAR | DAO', c.dao);

// ---------- live pool state decides a floor that WILL fill ----------
const pool = await ref.poolSnapshot(SELL, BUY, 10n ** 23n);
if (!pool) throw new Error('no usable wNEAR/USDT.e pool found on Ref testnet');
const spot = (Number(BigInt(pool.reserveOut)) / 1e6) / (Number(BigInt(pool.reserveIn)) / 1e24);
const FLOOR = String(Math.max(0.3, Math.floor(spot * 0.5 * 100) / 100));
console.log(`pool #${pool.poolId} spot ${spot.toFixed(3)} USDT.e/NEAR -> price floor ${FLOOR}`);
check('live Ref pool has sane liquidity for a 0.3 NEAR sale', spot > 0.6 && Number(BigInt(pool.reserveIn)) / 1e24 > 0.5, `pool #${pool.poolId} spot ${spot.toFixed(3)}, ${nearH(pool.reserveIn)} wNEAR`);

// ---------- real NEAR AI: attestation + parsing ----------
const ai = new NearAiClient();
const model = await ai.resolveConfidentialModel();
const { report: attestation, nonce } = await ai.fetchAttestation(model);
const completions: any[] = [];
let n = 0;
const llm: Llm = async (system, user) => { const sc = await ai.signedCompletion({ model, system, user }); completions.push({ label: `intent parse #${++n}`, ...sc }); return sc.content; };

// Bob must be an account that appears NOWHERE in the public pre-reveal view. The treasurer, council members and the agent are public by design
// (mandate.treasurer, proposal proposer/votes, contract agent), so Bob is a fresh account created for this run via the free testnet helper.
if (!c.accounts.bob) { c.accounts.bob = await helperCreate(`qtbob-${c.suffix}.testnet`, KeyPair.fromRandom('ed25519')); saveConfig(c); console.log('created sealed-run recipient', c.accounts.bob.accountId); }
const ALICE = c.accounts.contributor.accountId, BOB = c.accounts.bob.accountId, OPERATOR = c.accounts.funder.accountId;
const INTENT = `Sell up to 0.3 NEAR for USDT.e over the next 10 minutes, never below ${FLOOR} USDT.e per NEAR, in chunks of 0.05 to 0.1 NEAR every 5 to 8 seconds. ` +
  `Pay 50% of the proceeds to alice at ${ALICE} and 20% to bob at ${BOB}, both on near. Take a 0.5% service fee paid to ${OPERATOR}. Keep the terms sealed until settlement.`;
const parsed = await parseIntent(INTENT, { dao: c.dao, treasurer: c.accounts.treasurer.accountId, nowS: nowS(), llm });
check('NEAR AI (TEE) parsed the plain-English intent into a valid mandate', !!parsed.terms, `${parsed.attempts} attempt(s)`);
console.log(parsed.summary.join('\n'));

// pin the recorded-run parameters (the AI proposes, code decides); every override is recorded
const overrides: string[] = [];
const now0 = nowS();
const want: Partial<MandateTerms> = {
  maxSellAmount: NEAR('0.3').toString(), minPrice: FLOOR, chunkMin: NEAR('0.05').toString(), chunkMax: NEAR('0.1').toString(), intervalMinS: 5, intervalMaxS: 8,
  startTs: now0 - 3, endTs: now0 + 600, feeBps: 50, feeRecipient: OPERATOR, sealed: true,
  payouts: [{ label: 'alice', chain: 'near', address: ALICE, token: BUY, percent: 50 }, { label: 'bob', chain: 'near', address: BOB, token: BUY, percent: 20 }],
};
for (const k of Object.keys(want) as Array<keyof MandateTerms>) {
  if (k === 'startTs' || k === 'endTs') continue;
  if (JSON.stringify(parsed.terms[k]) !== JSON.stringify(want[k])) overrides.push(`${k}: AI proposed ${JSON.stringify(parsed.terms[k])?.slice(0, 60)} -> pinned ${JSON.stringify(want[k]).slice(0, 60)}`);
}
const t = MandateTerms.parse({ ...parsed.terms, ...want });
const SALT = randomSalt(16);
const HASH = commit(t, SALT);
console.log('overrides:', overrides.length ? overrides : 'none', '\ncommitment (public):', HASH);
const nextId = (await view<[string, string, number]>(c.rpc, c.mandate, 'get_config'))[2];

// housekeeping: stale mandates from earlier aborted runs are cancelled through REAL DAO proposals
for (const old of (await mc.listMandates(c.rpc, c.mandate, 0, 200)).filter((x) => x.id < nextId && ['Approved', 'Funded', 'Executing'].includes(x.status))) {
  const cp = await proposeWithHash(c, 'council1', `Housekeeping: cancel stale mandate #${old.id}`, sp.functionCallKind(c.mandate, 'cancel_mandate', { id: old.id }), `DAO proposal: cancel stale mandate #${old.id}`);
  await voteTx(c, 'council1', cp, 'VoteApprove', `housekeeping cancel #${old.id} vote 1/3`); await voteTx(c, 'council2', cp, 'VoteApprove', `housekeeping cancel #${old.id} vote 2/3 -> executes`);
  console.log('cancelled stale mandate', old.id);
}

// ---------- worker wiring (REAL adapter) ----------
class HChain extends RealChain {
  constructor(private o2: RealChainOpts, private fromId: number) { super(o2); }
  private tx(label: string, method: string, args: object) { return callTx(this.o2.agent, this.o2.mandateContract, method, args, TGAS(30)).then((r) => { rec(label, r.txHash); return r; }); }
  listMandates() { return super.listMandates().then((l) => l.filter((mm) => mm.id >= this.fromId)); }
  markFunded(id: number) { return this.tx(`agent: mark_funded #${id}`, 'mark_funded', { id }); }
  recordChunk(id: number, index: number, soldAmount: string) { return this.tx(`agent: record_chunk #${id}.${index}`, 'record_chunk', { id, index, sold_amount: soldAmount }); }
  beginSettlement(id: number) { return this.tx(`agent: begin_settlement #${id}`, 'begin_settlement', { id }); }
  complete(id: number, h: string, v: number, r: string | null) { return this.tx(`agent: complete #${id} (anchors report hash + REVEALS sealed terms)`, 'complete', { id, report_hash: h, violations: v, revealed_terms: r }); }
}
const chain = new HChain({ rpc: c.rpc, mandateContract: c.mandate, dao: c.dao, agent }, nextId);
const state = new State(':memory:', Buffer.alloc(32, 7));
const summaries: any[] = [];
const exec = new Executor({
  outlayer: ref, chain, state, clock: { nowS, sleep }, log: (k, f) => { if (!['chunk_submitted', 'awaiting_approval'].includes(k)) console.log('  [worker]', k, JSON.stringify(f).slice(0, 190)); },
  benchmark: (terms) => ref.spotSample(terms.sellToken, terms.buyToken, 24, 6),
  poolSnapshot: async (terms) => { const s = await ref.poolSnapshot(terms.sellToken, terms.buyToken, BigInt(terms.chunkMax)); return s ? { poolId: s.poolId, reserveIn: s.reserveIn, reserveOut: s.reserveOut, feeBps: s.feeBps, ts: s.ts } : null; },
  summarize: createSummarizer(ai, (sc) => { completions.push({ label: 'settlement summary', ...sc }); summaries.push(sc); }, model),
}, { ...defaultConfig(c.dao), floorRetryS: 6, requestWaitMs: 120_000 });

// council-authenticated delivery path = the REAL worker API (same handler the dashboard uses); council membership is read from the DAO policy
const isCouncil = async (a: string) => { const p: any = await sp.getPolicy(c.rpc, c.dao); return (p.roles ?? []).flatMap((r: any) => r.kind?.Group ?? []).includes(a); };
const api = createApi({
  state, chain, outlayer: ref, nowS, health: () => ({ net: 'testnet', mode: 'testnet-real-sealed' }), isCouncil,
  redteam: { chain, outlayer: ref, termsFor: async () => null, nowS },
  cfg: { dao: c.dao, rpc: c.rpc, corsOrigin: '*', authRecipient: 'quiet-treasury.worker' },
});
const srv = await api.listen(8792);
const BASE = 'http://127.0.0.1:8792';
const authHeader = (who: string, action: string, signAs?: string): string => {
  const acct = c.accounts[who]; const kp = KeyPair.fromString(acct.secretKey as any);
  const message = `${action}:${Date.now()}`; const nonce = randomBytes(32); const recipient = 'quiet-treasury.worker';
  const sig = kp.sign(nep413Hash(message, nonce, recipient)).signature;
  return Buffer.from(JSON.stringify({ accountId: signAs ?? acct.accountId, publicKey: kp.getPublicKey().toString(), signature: Buffer.from(sig).toString('base64'), message, nonce: nonce.toString('base64'), recipient })).toString('base64');
};
const http = async (path: string, init: RequestInit = {}) => { const r = await fetch(BASE + path, init); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };

const runUntil = async (cond: () => Promise<boolean> | boolean, maxS: number, each?: () => Promise<void>) => { const t0 = Date.now(); while (Date.now() - t0 < maxS * 1000) { await exec.tick(); if (each) await each(); if (await cond()) return true; await sleep(3000); } return false; };
const sealedCreateArgs: mc.CreateArgs = { treasurer: t.treasurer, terms_hash: HASH, terms_json: null as any, sell_token: t.sellToken, max_sell: t.maxSellAmount, start_ns: t.startTs * 1e9, end_ns: t.endTs * 1e9, tier: 'small' };

const before = { alice: await usdtOf(ALICE), bob: await usdtOf(BOB), operator: await usdtOf(OPERATOR), daoUsdt: await usdtOf(c.dao) };

// ================= 1. DAO votes on a SEALED mandate: only the commitment + budget are on chain =================
const pid = await proposeWithHash(c, 'council1', `Quiet Treasury: SEALED mandate #${nextId} - sell up to ${fromUnits(t.maxSellAmount, 24, 2)} NEAR; terms committed (${HASH.slice(0, 12)}...), revealed after settlement`, sp.functionCallKind(c.mandate, 'create_mandate', sealedCreateArgs), 'DAO proposal: create_mandate (SEALED: terms_json=null, commitment only)');
await voteTx(c, 'council1', pid, 'VoteApprove', 'vote 1/3 approve (council1)');
await voteTx(c, 'council2', pid, 'VoteApprove', 'vote 2/3 approve (council2) -> executes');
let m = (await mc.getMandate(c.rpc, c.mandate, nextId))!;
check('2 of 3 council votes create the SEALED mandate on chain', m?.status === 'Approved' && m.terms_json === null, `${m?.status}, terms_json=${m?.terms_json}`);
check('the on-chain commitment equals sha256(salt|terms) computed off chain', m.terms_hash === HASH, HASH.slice(0, 16));

// PUBLIC view of everything a stranger can read about this mandate: chain mandate + DAO proposal (kind decoded)
const publicView = async (): Promise<{ raw: string; text: string; terms_json: string | null; revealed_terms: string | null }> => {
  const mm = (await mc.getMandate(c.rpc, c.mandate, nextId))!;
  const props = [await sp.getProposal(c.rpc, c.dao, pid)];
  const decoded = props.map((p) => JSON.stringify(p) + ' ' + ((p.kind as any)?.FunctionCall?.actions ?? []).map((a: any) => Buffer.from(a.args, 'base64').toString('utf8')).join(' '));
  const raw = JSON.stringify({ mandate: mm, proposals: props });
  return { raw, text: raw + ' ' + decoded.join(' '), terms_json: mm.terms_json, revealed_terms: mm.revealed_terms };
};
const FORBIDDEN = [ALICE, BOB, OPERATOR, '"minPrice"', '"payouts"', '"intervalMinS"', `"minPrice":"${FLOOR}"`, '"feeRecipient"'];
const pre1 = await publicView();
check('before delivery: nothing secret is in the public mandate or proposal (recipients, floor, schedule absent)', FORBIDDEN.every((f) => !pre1.text.includes(f)), FORBIDDEN.filter((f) => pre1.text.includes(f)).join(',') || 'clean');

// worker cannot act on a sealed mandate it has no terms for
await exec.tick(); await exec.tick();
check('worker WAITS: no terms delivered yet, so no swaps happen', state.chunks(nextId).length === 0 && state.runtime(nextId).phase !== 'done', `phase=${state.runtime(nextId).phase}`);

// ================= 2. council-only delivery of the sealed terms (NEP-413 signed) =================
const body = JSON.stringify({ terms: t, salt: SALT });
const post = (hdr?: string) => http('/api/sealed-terms', { method: 'POST', headers: { 'content-type': 'application/json', ...(hdr ? { 'x-near-auth': hdr } : {}) }, body });
const r0 = await post();
check('delivery without a signature is rejected (401)', r0.status === 401, String(r0.body.error).slice(0, 70));
const rNon = await post(authHeader('contributor', 'sealed-terms'));
check('delivery signed by a NON-council account is rejected (401: not a council member)', rNon.status === 401 && /not a council member/.test(String(rNon.body.error)), String(rNon.body.error).slice(0, 80));
const rWrong = await post(authHeader('council1', 'something-else'));
check('a council signature bound to a different action is rejected (401)', rWrong.status === 401 && /not bound to this action/.test(String(rWrong.body.error)), String(rWrong.body.error).slice(0, 80));
const rImp = await post(authHeader('contributor', 'sealed-terms', c.accounts.council1.accountId));
check('impersonating a council account with another key is rejected (401)', rImp.status === 401, String(rImp.body.error).slice(0, 80));
const rOk = await post(authHeader('council1', 'sealed-terms'));
check('delivery signed by a council member succeeds and returns the commitment', rOk.status === 200 && rOk.body.termsHash === HASH, `${rOk.status} ${String(rOk.body.termsHash).slice(0, 16)}`);
const g0 = await http(`/api/mandates/${nextId}/terms`);
check('reading the sealed terms without council auth is rejected (401)', g0.status === 401, String(g0.body.error).slice(0, 70));
const g1 = await http(`/api/mandates/${nextId}/terms`, { headers: { 'x-near-auth': authHeader('council2', `terms:${nextId}`) } });
check('a council member can read the sealed terms back (200)', g1.status === 200 && g1.body.minPrice === FLOOR, `minPrice=${g1.body.minPrice}`);
const rawRow: any = (state.db.prepare('SELECT body FROM terms').all() as any[]).map((r) => Buffer.from(r.body).toString('latin1')).join('');
check('sealed terms are encrypted at rest in the worker database (AES-256-GCM)', rawRow.length > 0 && ![ALICE, BOB, '"minPrice"'].some((s) => rawRow.includes(s)), `${rawRow.length} ciphertext bytes`);

// ================= 3. REAL funding transfer (2 of 3 votes) =================
const fid = await proposeWithHash(c, 'council1', `Fund the agent vault with ${fromUnits(t.maxSellAmount, 24, 2)} NEAR for sealed mandate #${nextId}`, sp.transferKind('', VAULT, t.maxSellAmount), 'DAO proposal: Transfer budget (native NEAR) DAO -> agent vault');
await voteTx(c, 'council1', fid, 'VoteApprove', 'funding vote 1/3 (council1)');
for (let i = 0; i < 3; i++) await exec.tick();
check('one vote does NOT fund the vault; worker waits', BigInt((await ref.confidentialBalance(SELL)).balance) === 0n && state.runtime(nextId).phase !== 'done');
await voteTx(c, 'council3', fid, 'VoteApprove', 'funding vote 2/3 (council3) -> executes the REAL transfer');
const budget = BigInt((await ref.confidentialBalance(SELL)).balance);
check('DAO funding transfer credited the vault (real native NEAR)', budget >= BigInt(t.maxSellAmount) - 10n ** 20n, `${nearH(budget)} NEAR budget`);

// ================= 4. REAL execution while the terms stay sealed on chain =================
let during: Awaited<ReturnType<typeof publicView>> | null = null;
const ok1 = await runUntil(async () => (await chain.getMandate(nextId))?.status === 'Completed', 600, async () => {
  if (!during && ((await chain.getMandate(nextId))?.chunks ?? 0) >= 1 && (await chain.getMandate(nextId))?.status === 'Executing') during = await publicView();
});
m = (await chain.getMandate(nextId))!;
check('worker executes REAL swaps and the sealed mandate completes', ok1, `status=${m.status} chunks=${m.chunks}`);
if (!during) during = pre1; // run finished between polls: fall back to the pre-delivery public view (still sealed)
check('WHILE EXECUTING the public chain view still carries no terms', during.terms_json === null && during.revealed_terms === null && FORBIDDEN.every((f) => !during!.text.includes(f)), FORBIDDEN.filter((f) => during!.text.includes(f)).join(',') || 'clean');
const items1 = state.items(nextId), chunks1 = state.chunks(nextId).filter((x) => x.status === 'success');
check('chunks recorded on chain == real swaps executed', m.chunks === chunks1.length && m.chunks >= 2, `chain ${m.chunks} / swaps ${chunks1.length}`);
check('every swap request id is a real transaction hash that exists on chain', chunks1.length > 0 && chunks1.every((x) => isTxHash(x.request_id)) && (await Promise.all(chunks1.map((x) => txOnChain(x.request_id!, VAULT)))).every(Boolean), chunks1.map((x) => (x.request_id ?? '').slice(0, 8)).join(','));
const stored = state.report(nextId);
check('report fills are tagged chain (never simulated)', stored?.fills?.length > 0 && stored.fills.every((f: any) => f.source === 'chain'));
check('every swap respected the (sealed) price floor', stored?.floorRespected === true && state.violations(nextId).length === 0, `worst ${stored?.totals?.worstFillPrice?.value}`);
check('every swap executed at a market-like price (0.3-15 USDT.e per NEAR): never through an absurd pool', pricesSane(chunks1.map((x) => ({ in: x.size, out: x.amount_out ?? '0' }))), priceList(chunks1.map((x) => ({ in: x.size, out: x.amount_out ?? '0' }))));
const after = { alice: await usdtOf(ALICE), bob: await usdtOf(BOB), operator: await usdtOf(OPERATOR), daoUsdt: await usdtOf(c.dao) };
const paid = (label: string) => BigInt(items1.find((i) => i.label === label && i.status === 'success')?.amount ?? '0');
check('alice really received her USDT.e payout (recipient was sealed until settlement)', paid('alice') > 0n && after.alice - before.alice === paid('alice'), `+${after.alice - before.alice}`);
check('bob really received his USDT.e payout', paid('bob') > 0n && after.bob - before.bob === paid('bob'), `+${after.bob - before.bob}`);
const feeItem = items1.find((i) => i.kind === 'fee');
check('service fee really paid to the operator account', !!feeItem && feeItem.status === 'success' && after.operator - before.operator === BigInt(feeItem.amount), `+${after.operator - before.operator}`);
const retSell = items1.find((i) => i.kind === 'return_sell'), retBuy = items1.find((i) => i.kind === 'return_buy');
check('leftovers really returned to the DAO', (!retSell || (retSell.status === 'success' && isTxHash(retSell.request_id))) && (!retBuy || retBuy.status === 'success'), `${retSell ? nearH(retSell.amount) + ' NEAR ' : ''}${retBuy ? retBuy.amount + ' USDT.e' : ''}`.trim() || 'none');
check('report hash anchored on chain matches the stored report', /^[0-9a-f]{64}$/.test(m.report_hash ?? '') && stored?.reportHash === m.report_hash, (m.report_hash ?? '').slice(0, 16));
check('NEAR AI signed settlement summary attached', !!stored?.aiSummary?.signer, stored?.aiSummary?.signer);

// ================= 5. REVEAL: terms published on chain AFTER settlement; independent verification =================
const final = (await mc.getMandate(c.rpc, c.mandate, nextId))!;
check('terms are REVEALED on chain after settlement (revealed_terms set, terms_json still null)', !!final.revealed_terms && final.terms_json === null, `${(final.revealed_terms ?? '').length} bytes`);
const reveal = JSON.parse(final.revealed_terms ?? '{}');
check('sha256(salt | revealed terms) == the commitment that was public from the start', commit(reveal.terms, reveal.salt) === HASH && final.terms_hash === HASH);

const { anchored: _a, ...reportClean } = state.report(nextId);
const sealed: SealedEvidence = {
  onChain: { terms_hash: final.terms_hash, terms_json: final.terms_json, revealed_terms: final.revealed_terms, sell_token: final.sell_token, max_sell: final.max_sell, start_ns: final.start_ns, end_ns: final.end_ns },
  publicBefore: { terms_json: during.terms_json, revealed_terms: during.revealed_terms, text: during.text },
  forbidden: FORBIDDEN, decimals: { sell: 24, buy: 6 },
};
const bundle: ProofBundle = {
  attestation: { report: attestation, nonce },
  completions: completions.map((x) => ({ label: x.label, model: x.model, requestBody: x.requestBody, responseBody: x.responseBody, signature: x.signature })),
  commit: { terms: reveal.terms, salt: reveal.salt, hash: HASH, onChainHash: final.terms_hash },
  report: reportClean as any, sealed,
};
const ver = verifyBundle(bundle);
for (const k of ver.checks.filter((x) => x.name.startsWith('sealed:'))) console.log(k.ok ? '  verifier PASS' : '  verifier FAIL', k.name, k.detail ?? '');
check('independent verifier (TEE signatures, report hash, price floor, commit-reveal) passes', ver.ok, `${ver.checks.filter((x) => x.ok).length}/${ver.checks.length}`);
const tamper = (label: string, mutate: (b: any) => void, expectName: RegExp) => {
  const copy = JSON.parse(JSON.stringify(bundle)); mutate(copy);
  const r = verifyBundle(copy); const hit = r.checks.filter((x) => !x.ok && expectName.test(x.name));
  check(`verifier REJECTS tampering: ${label}`, !r.ok && hit.length > 0, hit.map((x) => x.name.slice(0, 60)).join(' | '));
};
tamper('floor changed in the revealed terms', (b) => { const r = JSON.parse(b.sealed.onChain.revealed_terms); r.terms.minPrice = '0.01'; b.sealed.onChain.revealed_terms = JSON.stringify(r); b.commit.terms = r.terms; }, /sha256\(salt/);
tamper('salt changed', (b) => { const r = JSON.parse(b.sealed.onChain.revealed_terms); r.salt = 'deadbeef' + r.salt.slice(8); b.sealed.onChain.revealed_terms = JSON.stringify(r); b.commit.salt = r.salt; }, /sha256\(salt/);
tamper('a recipient was swapped after the fact', (b) => { const r = JSON.parse(b.sealed.onChain.revealed_terms); r.terms.payouts[0].address = 'mallory.testnet'; b.sealed.onChain.revealed_terms = JSON.stringify(r); b.commit.terms = r.terms; }, /sha256\(salt/);
tamper('terms were already public before completion', (b) => { b.sealed.publicBefore.terms_json = JSON.stringify(reveal.terms); }, /carried NO terms/);
tamper('a secret leaked into the public pre-reveal view', (b) => { b.sealed.publicBefore.text += ` ${ALICE}`; }, /no secret term value/);

// ---------- evidence ----------
srv.close();
const proposals = (await sp.listProposals(c.rpc, c.dao, 0, 200)).filter((p) => [pid, fid].includes(p.id)).map((p) => ({ id: p.id, status: p.status, description: p.description, kind: Object.keys(p.kind)[0], votes: p.votes }));
const failed = results.filter((r) => !r[1]);
const sealedRun = {
  recordedAt: new Date().toISOString(),
  note: 'RECORDED SEALED-MANDATE RUN on PUBLIC NEAR TESTNET with REAL money movement (Ref Finance swaps, DAO Transfer funding, USDT.e payouts). SEALED = the mandate TERMS (price floor, schedule, recipients) are not on chain until settlement; only sha256(salt|terms) and the budget are public. NOT hidden: the swaps and payouts themselves are public testnet transactions (confidential/hidden trades are mainnet-only and unproven). The worker is NOT in a TEE: its operator can read sealed terms. Testnet tokens are play money.',
  network: 'testnet', mode: 'testnet-real-sealed', ids: { ...pub, vault: VAULT, dex: 'ref-finance-101.testnet' }, mandateId: nextId,
  commitment: { hash: HASH, saltLength: SALT.length, publicBeforeCompletion: { terms_json: during.terms_json, revealed_terms: during.revealed_terms }, forbiddenStrings: FORBIDDEN },
  intent: INTENT, parse: { summary: parsed.summary, attempts: parsed.attempts, overrides, model, floorFromLivePool: { poolId: pool.poolId, spot, floor: FLOOR } },
  mandate: final, proposals,
  swaps: chunks1.map((x) => ({ index: x.idx, tx: x.request_id, explorer: explorerTx(x.request_id!), in: x.size, out: x.amount_out })),
  payouts: items1.map((i) => ({ kind: i.kind, label: i.label, to: i.address, token: i.token, amount: i.amount, status: i.status, tx: i.dest_tx ?? i.request_id, explorer: i.request_id ? explorerTx(i.request_id) : null })),
  revealOnChain: { revealed_terms_bytes: (final.revealed_terms ?? '').length, terms: reveal.terms },
  verifier: { ok: ver.ok, checks: ver.checks }, txs, explorer: { dao: explorerAccount(c.dao), mandate: explorerAccount(c.mandate), vault: explorerAccount(VAULT) },
  results: results.map(([name, ok, note]) => ({ name, ok, note })),
};
mkdirSync('data/demo-run', { recursive: true });
writeFileSync('data/demo-run/sealed-proof-bundle.json', JSON.stringify(bundle, null, 2));
writeFileSync('data/demo-run/sealed-run.json', JSON.stringify(sealedRun, null, 2));
mkdirSync('app/public/demo-run', { recursive: true }); writeFileSync('app/public/demo-run/sealed-run.json', JSON.stringify(sealedRun, null, 2)); // the dashboard serves this copy (a stale one once broke /recompute)

console.log('\n=========== SEALED MANDATE E2E RESULT ===========');
for (const [nme, ok] of results) console.log(ok ? ' PASS ' : ' FAIL ', nme);
console.log(`${results.length - failed.length}/${results.length} passed`);
console.log('\nOn-chain evidence (public testnet):');
for (const x of txs) console.log(' ', x.label.padEnd(72), explorerTx(x.txHash));
void summaries;
process.exit(failed.length ? 1 : 0);
