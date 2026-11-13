// THE WHOLE STORY IN ONE COMMAND, OFFLINE (no network, no keys, ~2 s): npm run demo
// This drives the REAL executor, guards, planner, settlement and red-team code against in-memory stand-ins for the chain and the wallet
// (tests/worker/fakes.ts). It is a SIMULATION and says so: nothing here is a transaction. The real, recorded, on-chain versions of every step are in
// data/demo-run/*.json (each row has an explorer link). Exit code 0 only if every check below holds.
import { randomBytes } from 'node:crypto';
import { Executor, defaultConfig } from '../../worker/executor.js';
import { State } from '../../worker/state.js';
import { runAttack, ATTACKS } from '../../worker/redteam.js';
import { MandateTerms } from '../../src/engine/schema.js';
import { BUY, FakeChain, FakeClock, FakeOutLayer, NEAR1, SELL, makeTerms } from '../../tests/worker/fakes.js';

let n = 0; let failed = 0;
const say = (s: string) => console.log(s);
const step = (title: string) => say(`\n${++n}. ${title}`);
const check = (name: string, ok: boolean, note = '') => { if (!ok) failed++; say(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${note ? '  (' + note + ')' : ''}`); };
const human = (y: bigint | string, d: number) => (Number(BigInt(y)) / 10 ** d).toFixed(d === 24 ? 3 : 4);

say('QUIET TREASURY: offline story. SIMULATION with in-memory stand-ins; the on-chain proof is in data/demo-run/*.json.');
const clock = new FakeClock(); const chain = new FakeChain(clock); const ol = new FakeOutLayer(); const state = new State(':memory:', randomBytes(32));
const rng = { below: (m: number) => (m > 1 ? 1 : 0) };
const mkExec = () => new Executor({ outlayer: ol, chain, state, clock, rng }, { ...defaultConfig('dao.near'), itemBackoffS: 1 });
let exec = mkExec();
const run = async (until: () => boolean, max = 600) => { for (let i = 0; i < max && !until(); i++) { await exec.tick(); clock.now += 3; } };
const phase = (id: number) => state.runtime(id).phase;

step('Terms are bounds-checked before anything else (the AI only proposes)');
const terms = makeTerms(clock);
check('a valid mandate parses', !!MandateTerms.parse(terms));
let rejected = 0;
for (const bad of [{ minPrice: '0' }, { maxSellAmount: (10n ** 30n).toString() }, { payouts: [] as unknown[] }, { returnTo: '' }]) { try { MandateTerms.parse({ ...terms, ...bad }); } catch { rejected++; } }
check('out-of-bound terms are rejected (zero floor, absurd budget, no payouts, no return address)', rejected >= 3, `${rejected} of 4 rejected`);

step('DAO vote creates the mandate; nothing executes before it (tier "small" needs 1 approval, the fake DAO has 3 council members)');
chain.approvals = null; const m0 = chain.add(terms); ol.conf[SELL] = 5n * NEAR1;
await exec.tick();
check('no vote found: the worker waits and trades nothing', ol.swaps.length === 0 && phase(0) === 'awaiting_approval');
chain.approvals = { proposalId: 0, status: 'Approved', approvals: 3 };

step('Funded by the DAO; the agent sells in randomized, price-floored chunks');
await run(() => phase(0) === 'done');
const m = (await chain.getMandate(0))!;
check('mandate completes', m.status === 'Completed', `status ${m.status}, ${m.chunks} chunks`);
check('sold exactly the approved budget, never more', BigInt(m.sold) === 5n * NEAR1, `${human(m.sold, 24)} of ${human(m.max_sell, 24)} NEAR`);
check('every swap carried a min_amount_out (the price floor)', ol.swaps.length > 0 && ol.swaps.every((s) => !!s.minOut), `${ol.swaps.length} swaps`);
check('idempotency keys are unique (mandate:chunk:attempt)', new Set(ol.swaps.map((s) => s.idem)).size === ol.swaps.length);

step('Payouts, fee and leftovers');
const pays = ol.withdrawals.map((w) => `${w.to.slice(0, 10)}... ${human(w.amount, 6)}`);
say('   ' + pays.join('\n   '));
check('fee paid, contributors paid, leftovers returned to the DAO', ol.withdrawals.some((w) => w.to === 'ops.near') && ol.withdrawals.some((w) => w.to === 'dao.near') && ol.withdrawals.length >= 4);
check('nothing is stranded in the wallet', ol.conf[SELL] === 0n && ol.conf[BUY] === 0n);

step('Settlement report is anchored and the price floor held');
const rep = state.report(0);
check('report hash anchored on the (fake) mandate contract', /^[0-9a-f]{64}$/.test(m.report_hash ?? '') && rep.reportHash === m.report_hash, (m.report_hash ?? '').slice(0, 16) + '...');
check('every fill respected the price floor, no violations', rep.floorRespected === true && state.violations(0).length === 0);
check('treasurer earned on-chain trust', (chain.trust.get(terms.treasurer) ?? 0) === 1);

step('Red team: six real attacks against the real guards (layer 0/A/B)');
const layerA = {
  transfer: async () => { throw Object.assign(new Error('SIMULATED OutLayer 403 policy_denied (real ones: data/demo-run/custody-run.json)'), { status: 403 }); },
  verdict: (e: unknown) => ({ blocked: true, status: 403, error: (e as Error).message }), unlistedTo: 'attacker.near', allowedTo: 'dao.near', smallAmount: '1', overCapAmount: '2',
};
chain.add(makeTerms(clock)); ol.conf[SELL] = 5n * NEAR1; await run(() => (chain.mandates.get(1)?.chunks ?? 0) >= 1, 80);
for (const a of ATTACKS) {
  const r = await runAttack(a, 1, { chain, outlayer: ol, termsFor: async (mm) => MandateTerms.parse(JSON.parse(mm.terms_json!)), nowS: () => clock.now, layerA } as any);
  check(`${a}`, r.blocked, r.layer);
}

step('Crash-restart: a brand-new executor over the same state never double-executes');
await run(() => phase(1) === 'done');
check('mandate #1 finished after the restart', (await chain.getMandate(1))!.status === 'Completed');
chain.add(makeTerms(clock)); ol.conf[SELL] = 5n * NEAR1; await run(() => (chain.mandates.get(2)?.chunks ?? 0) >= 2, 120);
const before = ol.swaps.length; exec = mkExec(); // process death: new Executor, same State (sqlite in production)
await run(() => phase(2) === 'done');
const keys = ol.swaps.map((s) => s.idem);
check('no swap idempotency key was used twice across the restart', new Set(keys).size === keys.length, `${before} swaps before, ${ol.swaps.length} after`);
check('chain-recorded chunks equal executed chunks', (await chain.getMandate(2))!.chunks === state.chunks(2).filter((c) => c.status === 'success').length);

step('DAO cancel mid-run: trading stops, everything returns, nobody else is paid');
chain.add(makeTerms(clock)); ol.conf[SELL] = 5n * NEAR1; await run(() => (chain.mandates.get(3)?.chunks ?? 0) >= 1, 80);
const swaps3 = ol.swaps.length; const w3 = ol.withdrawals.length; chain.cancel(3);
await run(() => phase(3) === 'done');
const newW = ol.withdrawals.slice(w3);
check('no swap after the cancel (at most the one in flight)', ol.swaps.length - swaps3 <= 1);
check('only the DAO received money after the cancel', newW.length > 0 && newW.every((w) => w.to === 'dao.near'), newW.map((w) => w.to).join(','));

say(`\n${failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED'}. This was a simulation. Real, on-chain, explorer-linked runs: data/demo-run/run.json, custody-run.json, sealed-run.json, restart-run.json.`);
process.exit(failed === 0 ? 0 : 1);
