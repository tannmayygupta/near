// JAVASCRIPT INTEGRATION TEST of the deployed mandate contract (mainnet by default; QT_NET=testnet QT_TAG=rehearsal for the rehearsal contract).
//
//   npm run mainnet:test            READ-ONLY: calls every view method and validates what comes back. No key, no transaction, no ALLOW_MAINNET.
//   npm run mainnet:test -- --auth  ADDS the authorisation tests: every access-restricted method is called by an UNPRIVILEGED account (the payee qt-alice)
//                                   and must be refused with the right panic. Sends 11 transactions that are expected to FAIL (cost: gas only, a few thousandths of a NEAR).
//                                   On mainnet this needs ALLOW_MAINNET=1 in the shell and the payee's key in the secret directory.
//
// Safety: every authorisation call uses arguments the contract would reject by its own validation even if its guard were missing, and the two methods that cannot
// be given invalid arguments are only sent when they would be a no-op (see src/near/contract-auth-matrix.ts). No method that changes the DAO, the agent, the pause flag
// or a mandate is ever sent with arguments that could succeed. The report below says exactly which calls were made.
import './profile.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { actions } from 'near-api-js';
import { accountFor, TGAS } from '../../src/near/chain.js';
import { AUTH_MATRIX, COVERED_VIEWS, classifyAuthOutcome, outcomeError, skipReason } from '../../src/near/contract-auth-matrix.js';
import { explorerAddress, validateMandate, validateStats } from '../../src/near/contract-verify.js';
import { inventory } from '../../src/near/contract-methods.js';
import { fromYocto } from '../../src/near/setup-plan.js';
import { PUBLIC_PATH, TAG, explorerTx, loadConfig, hasConfig } from '../testnet/lib.js';
import { chainReader } from './readers.js';
import { IS_MAINNET, P, requireMainnetConsent } from './net.js';

const AUTH = process.argv.includes('--auth');
for (const a of process.argv.slice(2)) if (a !== '--auth') { console.error(`unknown argument "${a}" (allowed: --auth)`); process.exit(1); }
if (!existsSync(PUBLIC_PATH)) { console.error(`NOT TESTED: ${PUBLIC_PATH} does not exist: no ${P.name} contract has been set up by this repository yet.`); process.exit(2); }
const pub = JSON.parse(readFileSync(PUBLIC_PATH, 'utf8').replace(/^﻿/, ''));
const net = IS_MAINNET ? 'mainnet' : 'testnet';
if (pub.network && pub.network !== net) { console.error(`NOT TESTED: ${PUBLIC_PATH} describes ${pub.network}, this command targets ${net}. Check QT_NET.`); process.exit(2); }
const contract: string = pub.mandateContract, rpc = P.rpc;
const reader = chainReader(rpc);
const v = (m: string, a: object = {}) => reader.view(contract, m, a);

type Row = { method: string; kind: string; input: string; expected: string; actual: string; tx: string | null; status: 'PASS' | 'FAIL' | 'SKIP'; evidence?: string };
const rows: Row[] = [];
let authSummary: unknown = null;
const rec = (r: Row) => { rows.push(r); console.log(`${r.status.padEnd(4)}  ${r.method.padEnd(26)} ${r.evidence ? `[${r.evidence}] ` : ''}${r.actual}${r.tx ? `\n      tx ${r.tx}` : ''}`); };
const safe = async <T>(f: () => Promise<T>): Promise<{ v?: T; err?: string }> => { try { return { v: await f() }; } catch (e) { return { err: String((e as Error).message ?? e).slice(0, 200) }; } };
const J = (x: unknown) => JSON.stringify(x);

console.log(`CONTRACT TEST  ${net.toUpperCase()}  ${contract}  (${AUTH ? 'views + authorisation tests' : 'views only: read-only'})\n`);
const cid = await safe(() => reader.chainId());
if (cid.v !== net) { console.error(`STOP: RPC reports chain_id "${cid.v ?? cid.err}", expected "${net}"`); process.exit(1); }
const acc = await reader.viewAccountFull(contract);
if (!acc) { console.error(`STOP: ${contract} does not exist on ${net}`); process.exit(1); }

// ---------------- the method list the tests are built from (source + compiled wasm)
const inv = inventory(readFileSync('contracts/mandate/src/lib.rs', 'utf8'), readFileSync('contracts/mandate/out/mandate.wasm'));
const viewMethods = inv.methods.filter((m) => m.kind === 'view').map((m) => m.name);
console.log(`method inventory: ${inv.counts.total} (${inv.counts.production} in the production wasm): ${inv.counts.view} views, ${inv.counts.dao} DAO-only, ${inv.counts.agent} agent-only, ${inv.counts.proposedDao} proposed-DAO, ${inv.counts.init} init, ${inv.counts.metadata} SDK metadata, ${inv.counts.featureGated} feature-gated (not in this wasm)\n`);

// ---------------- 1. views (read-only)
const stats0 = (await safe(() => v('get_stats'))).v as any;
const sp = validateStats(stats0);
rec({ method: 'get_stats', kind: 'view', input: '{}', expected: 'well-formed, status counts add up', status: sp.length ? 'FAIL' : 'PASS', tx: null, actual: sp.length ? sp.join('; ') : `mandates ${stats0.mandates}, chunks ${stats0.chunks_recorded}, completed ${stats0.completed}, paused ${stats0.paused}, pending_dao ${J(stats0.pending_dao)}` });
if (sp.length) { await finish(); }
{ const r = await safe(() => v('get_version')); rec({ method: 'get_version', kind: 'view', input: '{}', expected: '2', actual: J(r.v ?? r.err), tx: null, status: r.v === 2 ? 'PASS' : 'FAIL' }); }
{ const r = await safe(() => v('get_config')); const c = r.v as any; const ok = Array.isArray(c) && c.length === 3 && c[0] === stats0.dao && c[1] === stats0.agent && c[2] === stats0.mandates; rec({ method: 'get_config', kind: 'view', input: '{}', expected: '[dao, agent, next_id] equal to get_stats', actual: J(r.v ?? r.err), tx: null, status: ok ? 'PASS' : 'FAIL' }); }
{ const r = await safe(() => v('is_paused')); rec({ method: 'is_paused', kind: 'view', input: '{}', expected: `boolean equal to stats.paused (${stats0.paused})`, actual: J(r.v ?? r.err), tx: null, status: r.v === stats0.paused ? 'PASS' : 'FAIL' }); }
{ const r = await safe(() => v('get_mandate', { id: 0 })); const m: any = r.v; const problems = stats0.mandates === 0 ? (m === null ? [] : ['expected null while no mandate exists']) : m ? validateMandate(m) : ['expected mandate 0 to exist']; const okId = stats0.mandates === 0 || m?.id === 0;
  rec({ method: 'get_mandate', kind: 'view', input: '{"id":0}', expected: stats0.mandates === 0 ? 'null (no mandate yet)' : 'mandate 0, well-formed', actual: r.err ?? (problems.length || !okId ? `problems: ${problems.join('; ') || 'id mismatch'}` : m ? `status ${m.status}, chunks ${m.chunks}, sold ${m.sold}/${m.max_sell}` : 'null'), tx: null, status: r.err || problems.length || !okId ? 'FAIL' : 'PASS' }); }
{ const r = await safe(() => v('get_mandate', { id: 9007199254740991 })); rec({ method: 'get_mandate (unknown id)', kind: 'view', input: '{"id":2^53-1}', expected: 'null', actual: r.err ?? J(r.v), tx: null, status: !r.err && r.v === null ? 'PASS' : 'FAIL' }); }
{ const r = await safe(() => v('list_mandates', { from: 0, limit: 10 })); const l: any = r.v; const want = Math.min(10, stats0.mandates); const bad = !Array.isArray(l) ? ['not an array'] : [...(l.length !== want ? [`length ${l.length}, expected ${want}`] : []), ...l.flatMap((m: any, i: number) => [...validateMandate(m).map((x) => `#${i}: ${x}`), ...(m.id !== i ? [`#${i}: id ${m.id} out of order`] : [])])];
  rec({ method: 'list_mandates', kind: 'view', input: '{"from":0,"limit":10}', expected: `array of ${want} well-formed mandates in id order`, actual: r.err ?? (bad.length ? bad.join('; ') : `${l.length} mandate(s)`), tx: null, status: r.err || bad.length ? 'FAIL' : 'PASS' }); }
{ const who = pub.treasurer ?? stats0.agent; const r = await safe(() => v('get_trust', { treasurer: who })); const ok = Number.isInteger(r.v) && (r.v as number) >= 0 && (r.v as number) <= stats0.completed; rec({ method: 'get_trust', kind: 'view', input: J({ treasurer: who }), expected: `integer between 0 and completed (${stats0.completed})`, actual: J(r.v ?? r.err), tx: null, status: ok ? 'PASS' : 'FAIL' }); }
{ const r = await safe(() => v('contract_source_metadata')); const m: any = r.v; const ok = !!m && typeof m.version === 'string' && /nep330/i.test(J(m.standards ?? m)) && typeof m.link === 'string'; rec({ method: 'contract_source_metadata', kind: 'view (SDK, NEP-330)', input: '{}', expected: 'version, link and the nep330 standard', actual: r.err ?? (ok ? `version ${m.version}, link ${m.link}` : `unexpected: ${J(m).slice(0, 160)}`), tx: null, status: ok ? 'PASS' : 'FAIL' }); }
const coveredViews = new Set<string>(COVERED_VIEWS);
for (const m of viewMethods) if (!coveredViews.has(m)) rec({ method: m, kind: 'view', input: '', expected: 'covered by a test', actual: 'the contract has a view method this script does not test', tx: null, status: 'FAIL' });

// ---------------- 2. authorisation tests (transactions that must FAIL)
if (!AUTH) {
  for (const c of AUTH_MATRIX) rec({ method: c.method, kind: `${c.guard}-only`, input: J(c.args({ dao: '<dao>', agent: '<agent>' })), expected: `refused: "${c.expectPanic}"`, actual: 'not run (read-only mode; add --auth to run it)', tx: null, status: 'SKIP' });
} else {
  requireMainnetConsent('send 11 unauthorised calls that are expected to fail (gas only)');
  if (!hasConfig()) { console.error(`STOP: the secret config for this network (${TAG}) is not available (is QT_SECRET_DIR set to the folder that holds it?)`); process.exit(1); }
  const cfg = loadConfig();
  const payee = cfg.accounts.contributor;
  if (!payee || cfg.mandate !== contract) { console.error('STOP: the secret config does not describe this contract'); process.exit(1); }
  if (payee.accountId === stats0.dao || payee.accountId === stats0.agent) { console.error('STOP: the test account holds a privileged role; refusing to run an authorisation test with it'); process.exit(1); }
  const signer = accountFor(rpc, payee.accountId, payee.secretKey);
  const balBefore = (await reader.viewAccountFull(payee.accountId))!.amount;
  if (balBefore < 20n * 10n ** 21n) { console.error(`STOP: the test account ${payee.accountId} holds only ${fromYocto(balBefore, 4)} NEAR; it needs at least 0.02 NEAR for the failing calls' gas. Nothing was sent.`); process.exit(1); }
  console.log(`\nauthorisation tests: caller ${payee.accountId} (unprivileged; not the DAO, not the agent)\n`);
  const ctx = { dao: stats0.dao as string, agent: stats0.agent as string };
  for (const c of AUTH_MATRIX) {
    const cur = (await safe(() => v('get_stats'))).v as any;
    const skip = cur ? skipReason(c, cur) : 'could not read the state before the call';
    if (skip) { rec({ method: c.method, kind: `${c.guard}-only`, input: J(c.args(ctx)), expected: `refused: "${c.expectPanic}"`, actual: `skipped: ${skip}`, tx: null, status: 'SKIP' }); continue; }
    let outcome: any = null, thrown: string | null = null;
    try { outcome = await signer.signAndSendTransaction({ receiverId: contract, actions: [actions.functionCall(c.method, c.args(ctx), TGAS(10), 0n)], throwOnFailure: false } as any); }
    catch (e) { thrown = String((e as Error).message ?? e) + ' ' + J((e as any)?.cause ?? ''); }
    const o = thrown ? { ok: false, error: thrown } : outcomeError(outcome);
    const verdict = classifyAuthOutcome(c, o);
    const hash: string | null = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id ?? null;
    rec({ method: c.method, kind: `${c.guard}-only`, input: J(c.args(ctx)), expected: `refused: "${c.expectPanic}"`, actual: verdict.detail + (c.limitation ? `  [limitation: ${c.limitation}]` : ''), tx: hash ? explorerTx(hash) : null, status: verdict.pass ? 'PASS' : 'FAIL', evidence: verdict.evidence });
  }
  const stats1 = (await safe(() => v('get_stats'))).v;
  const same = J(stats1) === J(stats0);
  rec({ method: '(state check)', kind: 'before/after', input: '', expected: 'get_stats identical before and after all unauthorised calls', actual: same ? 'identical: no state changed' : `CHANGED: before ${J(stats0)} after ${J(stats1)}`, tx: null, status: same ? 'PASS' : 'FAIL' });
  const balAfter = (await reader.viewAccountFull(payee.accountId))!.amount;
  authSummary = { caller: payee.accountId, gasCostNear: fromYocto(balBefore - balAfter, 6) };
  console.log(`\ncost of the failed calls (gas): ${fromYocto(balBefore - balAfter, 6)} NEAR`);
}
await finish();

async function finish(): Promise<never> {
  const n = (s: Row['status']) => rows.filter((r) => r.status === s).length;
  const out = `data/${TAG}-test-report.json`;
  writeFileSync(out, JSON.stringify({ network: net, contract, explorer: explorerAddress(net, contract), rpc, ranAt: new Date().toISOString(), mode: AUTH ? 'views+auth' : 'views-only', inventory: inv.counts, auth: authSummary, summary: { pass: n('PASS'), fail: n('FAIL'), skip: n('SKIP') }, rows }, null, 2));
  console.log(`\nRESULT: ${n('FAIL') ? 'FAILED' : 'PASSED'}  (${n('PASS')} pass, ${n('FAIL')} fail, ${n('SKIP')} skipped)   report: ${out}`);
  if (!AUTH) console.log('The authorisation tests were NOT run (read-only mode).');
  await new Promise((r) => setTimeout(r, 400)); // let open sockets settle: process.exit() right after fetch() trips a libuv assertion on Windows and hides the exit code
  process.exit(n('FAIL') ? 1 : 0);
}
