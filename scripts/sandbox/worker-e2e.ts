// END-TO-END on the LOCAL sandbox chain: real Sputnik DAO votes -> real mandate contract -> real worker (real OutLayerClient over HTTP)
// -> payouts -> settlement -> report anchored on chain; then a second mandate that the DAO cancels mid-run.
// The OutLayer API here is the TEST-ONLY local stand-in (scripts/sandbox/fake-outlayer.ts). Nothing here proves live OutLayer behaviour.
import { readFileSync } from 'node:fs';
import { KeyPair } from 'near-api-js';
import { RPC, accountFor, TGAS, NEAR } from '../../src/near/chain';
import * as sp from '../../src/near/sputnik';
import * as mc from '../../src/near/mandate';
import { MandateTerms } from '../../src/engine/schema';
import { hashJson } from '../../src/engine/hash';
import { OutLayerClient } from '../../src/near/outlayer';
import { Executor, defaultConfig } from '../../worker/executor';
import { RealChain } from '../../worker/chain';
import { State } from '../../worker/state';
import { createApi } from '../../worker/api';
import { startFakeOutLayer } from './fake-outlayer';

const cfg = JSON.parse(readFileSync('data/secret/sandbox-accounts.json', 'utf8'));
const root = JSON.parse(readFileSync('data/secret/sandbox-root.json', 'utf8').replace(/^﻿/, ''));
const A = (n: string) => accountFor(RPC.sandbox, cfg.accounts[n].accountId, cfg.accounts[n].secretKey);
const rootAcc = accountFor(RPC.sandbox, root.account_id, root.secret_key);
const SELL = 'nep141:wrap.near', BUY = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const results: Array<[string, boolean, string]> = [];
const check = (n: string, ok: boolean, note = '') => { results.push([n, ok, note]); console.log(ok ? 'PASS' : 'FAIL', n, note); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- deploy a fresh mandate contract for this run
const mk = KeyPair.fromRandom('ed25519'); const MID = `mandate${Date.now()}.${root.account_id}`;
await rootAcc.createAccount({ newAccountId: MID, publicKey: mk.getPublicKey(), nearToTransfer: NEAR(20) });
const mAcc = accountFor(RPC.sandbox, MID, mk.toString());
await mAcc.deployContract(readFileSync('contracts/mandate/out/mandate.wasm'));
await mAcc.callFunction({ contractId: MID, methodName: 'new', args: { dao: cfg.dao, agent: cfg.accounts.agent.accountId }, gas: TGAS(30) });
console.log('mandate contract', MID);

const fake = await startFakeOutLayer(8899, 3.7);
fake.conf[SELL] = 15n * 10n ** 24n; // test funding (DAO->agent funding path is verified separately, gate G3)
const outlayer = new OutLayerClient({ baseUrl: fake.url, apiKey: 'wk_test_only' });
const chain = new RealChain({ rpc: RPC.sandbox, mandateContract: MID, dao: cfg.dao, agent: A('agent') });
const state = new State(':memory:', Buffer.alloc(32, 7));
const exec = new Executor({ outlayer, chain, state, clock: { nowS: () => Math.floor(Date.now() / 1000), sleep } }, { ...defaultConfig(cfg.dao), floorRetryS: 5 });

const council = async (id: number) => { await sp.vote(RPC.sandbox, A('council1'), cfg.dao, id, 'VoteApprove'); await sp.vote(RPC.sandbox, A('council2'), cfg.dao, id, 'VoteApprove'); };
async function propose(maxNear: number, tier: 'small' | 'mid' | 'large', windowS: number) {
  const now = Math.floor(Date.now() / 1000);
  const terms = MandateTerms.parse({
    dao: cfg.dao, treasurer: cfg.accounts.treasurer.accountId, sellToken: SELL, buyToken: BUY, maxSellAmount: (BigInt(maxNear) * 10n ** 24n).toString(), minPrice: '3.0',
    startTs: now - 2, endTs: now + windowS, chunkMin: (10n ** 24n).toString(), chunkMax: (2n * 10n ** 24n).toString(), intervalMinS: 5, intervalMaxS: 6,
    payouts: [
      { label: 'contributor (Solana)', chain: 'solana', address: 'SoLaddrContributor1111111111111111111111111', token: BUY, percent: 60 },
      { label: 'contributor (Base)', chain: 'base', address: '0x00000000000000000000000000000000000C0FFE', token: BUY, percent: 30 },
    ],
    feeBps: 50, feeRecipient: cfg.accounts.contributor.accountId, returnTo: cfg.dao, sealed: false,
  });
  const args: mc.CreateArgs = { treasurer: terms.treasurer, terms_hash: hashJson(terms), terms_json: JSON.stringify(terms), sell_token: SELL, max_sell: terms.maxSellAmount,
    start_ns: terms.startTs * 1e9, end_ns: terms.endTs * 1e9, tier };
  const pid = await sp.addProposal(RPC.sandbox, A('council1'), cfg.dao, `Sell ${maxNear} NEAR quietly`, sp.functionCallKind(MID, 'create_mandate', args));
  return { pid, terms };
}
async function runUntil(cond: () => Promise<boolean> | boolean, maxS: number) { const t0 = Date.now(); while (Date.now() - t0 < maxS * 1000) { await exec.tick(); if (await cond()) return true; await sleep(1000); } return false; }

// ================= RUN 1: full happy path =================
const r1 = await propose(5, 'small', 120);
await exec.tick(); // mandate does not exist yet (no vote) -> nothing happens
check('no execution before the DAO vote', (await chain.listMandates()).length === 0 && fake.swaps.length === 0);
await council(r1.pid);
const ml = await chain.listMandates();
check('2 of 3 council votes create the mandate on chain', ml.length === 1 && ml[0].status === 'Approved', ml[0]?.status);
const ok1 = await runUntil(async () => (await chain.getMandate(0))?.status === 'Completed', 150);
const m0 = (await chain.getMandate(0))!;
check('worker executes chunks and the mandate completes', ok1, `status=${m0.status} chunks=${m0.chunks}`);
check('chunks recorded on chain == swaps made', m0.chunks === fake.swaps.length && m0.chunks >= 3, `chain ${m0.chunks} / swaps ${fake.swaps.length}`);
check('sold == max budget, never above', BigInt(m0.sold) === 5n * 10n ** 24n, m0.sold);
check('every swap carried a price floor (min_amount_out)', fake.swaps.every((s) => !!s.min_amount_out));
check('payouts made to listed addresses (fee, solana, base)', ['SoLaddrContributor1111111111111111111111111', '0x00000000000000000000000000000000000C0FFE', cfg.accounts.contributor.accountId].every((a) => fake.withdrawals.some((w) => w.to === a)));
check('all withdrawals go to payout list / fee recipient / returnTo', fake.withdrawals.every((w) => ['SoLaddrContributor1111111111111111111111111', '0x00000000000000000000000000000000000C0FFE', cfg.accounts.contributor.accountId, cfg.dao].includes(w.to)));
check('nothing stranded in the wallet', (fake.conf[SELL] ?? 0n) === 10n * 10n ** 24n && (fake.conf[BUY] ?? 0n) === 0n, `sell=${fake.conf[SELL]} buy=${fake.conf[BUY]}`);
check('report hash anchored on chain', /^[0-9a-f]{64}$/.test(m0.report_hash ?? ''), m0.report_hash?.slice(0, 16));
check('treasurer earned trust on chain', (await mc.getTrust(RPC.sandbox, MID, cfg.accounts.treasurer.accountId)) === 1);

// API + verifier over the same run
const api = createApi({ state, chain, outlayer, nowS: () => Math.floor(Date.now() / 1000), health: () => ({}),
  isCouncil: async (a) => ['council1', 'council2', 'council3'].some((n) => cfg.accounts[n].accountId === a),
  redteam: { chain, outlayer, termsFor: async (m) => MandateTerms.parse(JSON.parse(m.terms_json!)), nowS: () => Math.floor(Date.now() / 1000) },
  cfg: { dao: cfg.dao, rpc: RPC.sandbox, corsOrigin: '*', authRecipient: 'quiet-treasury.worker' } });
const srv = await api.listen(8788);
const get = async (p: string) => (await fetch(`http://127.0.0.1:8788${p}`)).json() as Promise<any>;
const checks = await get('/api/verify/0');
check('GET /api/verify/0: every check green', checks.length > 5 && checks.every((c: any) => c.ok), checks.filter((c: any) => !c.ok).map((c: any) => c.name).join('; '));
const rep = await get('/api/report/0');
check('GET /api/report/0 matches chain anchor', rep.reportHash === m0.report_hash && rep.anchored === true && rep.violations === 0);
check('GET /api/mandates/0/chunks lists real chunks', (await get('/api/mandates/0/chunks')).filter((c: any) => c.status === 'success').length === m0.chunks);
const rt = await Promise.all(['over_budget', 'wrong_token', 'after_expiry', 'unlisted_payout', 'non_dao_create'].map((a) => fetch(`http://127.0.0.1:8788/api/redteam/${a}`, { method: 'POST', body: '{}' }).then((r) => r.json() as Promise<any>)));
check('red-team attacks: all 5 blocked with a named layer', rt.every((r) => r.blocked && /^(A|B)/.test(r.layer)), rt.map((r) => `${r.attack}:${r.layer}`).join(' | '));
srv.close();

// ================= RUN 2: DAO cancels mid-run =================
const swapsBefore = fake.swaps.length, wBefore = fake.withdrawals.length;
const r2 = await propose(10, 'small', 300);
await council(r2.pid);
const ok2a = await runUntil(async () => ((await chain.getMandate(1))?.chunks ?? 0) >= 2, 120);
check('second mandate starts trading', ok2a, `chunks=${(await chain.getMandate(1))?.chunks}`);
const cid = await sp.addProposal(RPC.sandbox, A('council1'), cfg.dao, 'Cancel mandate #1', sp.functionCallKind(MID, 'cancel_mandate', { id: 1 }));
await council(cid);
const swapsAtCancel = fake.swaps.length;
check('DAO cancel executes on chain', (await chain.getMandate(1))?.status === 'Cancelled');
const ok2 = await runUntil(() => state.runtime(1).phase === 'done', 60);
check('worker stops within a tick and returns everything', ok2 && fake.swaps.length === swapsAtCancel, `swaps after cancel: ${fake.swaps.length - swapsAtCancel}`);
const w2 = fake.withdrawals.slice(wBefore);
check('cancel run paid nobody except the DAO (no payouts, no fee)', w2.length > 0 && w2.every((w) => w.to === cfg.dao), w2.map((w) => w.to).join(','));
check('cancelled mandate leaves nothing stranded', (fake.conf[BUY] ?? 0n) === 0n && (fake.conf[SELL] ?? 0n) === 0n, `sell=${fake.conf[SELL]} buy=${fake.conf[BUY]}`);
void swapsBefore;

fake.server.close();
const failed = results.filter((r) => !r[1]);
console.log('\n=========== E2E RESULT ===========');
for (const [n, ok] of results) console.log(ok ? ' PASS ' : ' FAIL ', n);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

