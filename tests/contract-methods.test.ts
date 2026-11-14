import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inventory, sourceMethods, wasmFunctionExports } from '../src/near/contract-methods';
import { AUTH_MATRIX, COVERED_VIEWS, classifyAuthOutcome, isContractRefusal, outcomeError, skipReason } from '../src/near/contract-auth-matrix';

const SRC = readFileSync('contracts/mandate/src/lib.rs', 'utf8');
const WASM = readFileSync('contracts/mandate/out/mandate.wasm');
const inv = inventory(SRC, WASM);

describe('authoritative method inventory (source cross-checked against the compiled wasm)', () => {
  it('the numbers: 19 public methods in lib.rs, 20 in the production wasm (+ SDK metadata), 21 with the feature-gated migrate', () => {
    expect(inv.counts).toEqual({ total: 21, production: 20, init: 1, dao: 5, agent: 5, proposedDao: 1, view: 7, metadata: 1, featureGated: 1 });
    expect(sourceMethods(SRC).filter((m) => m.kind !== 'feature-gated')).toHaveLength(19);
  });
  it('the compiled wasm exports exactly the production methods: nothing missing, nothing extra', () => {
    expect(inv.missingInWasm).toEqual([]); expect(inv.unexpectedInWasm).toEqual([]);
    expect(wasmFunctionExports(WASM).filter((n) => !/^(_|memory)/.test(n))).toHaveLength(20);
    expect(inv.wasmExports).not.toContain('migrate'); // feature-gated: not in the production build
  });
  it('11 methods are access-restricted: 5 DAO-only, 5 agent-only, accept_dao', () => {
    expect(inv.restricted.sort()).toEqual(['accept_dao', 'begin_settlement', 'cancel_mandate', 'complete', 'create_mandate', 'expire', 'mark_funded', 'propose_dao', 'record_chunk', 'set_agent', 'set_paused'].sort());
  });
  it('the 7 views do not change state; everything else except the SDK metadata does', () => {
    for (const m of inv.methods) { if (m.kind === 'view' || m.kind === 'metadata') expect(m.mutates, m.name).toBe(false); else expect(m.mutates, m.name).toBe(true); }
  });
  it('every Rust method is referenced by the contract unit tests (a method without a test is flagged here)', () => {
    const tests = SRC.slice(SRC.indexOf('#[cfg(test)]'));
    const untested = inv.methods.filter((m) => m.kind !== 'metadata' && !new RegExp(`\\.${m.name}\\(|Contract::${m.name}\\(`).test(tests)).map((m) => m.name);
    // KNOWN GAP (reported, not hidden): the Rust unit tests never call list_mandates. The live integration test (scripts/mainnet/test-contract.ts) does exercise it on-chain.
    // When a Rust test for it is added, delete it from this list: this assertion then fails to tell you.
    expect(untested).toEqual(['list_mandates']);
  });
  it('a state-changing method without a recognised guard is an error, never silently classified', () => {
    expect(() => sourceMethods('impl Contract {\n    pub fn evil(&mut self) {\n        self.x = 1;\n    }\n}')).toThrow(/no recognised guard/);
  });
});

describe('authorisation test matrix', () => {
  it('covers exactly the restricted methods, with the guard the inventory derived', () => {
    expect(AUTH_MATRIX.map((c) => c.method).sort()).toEqual([...inv.restricted].sort());
    for (const c of AUTH_MATRIX) expect(inv.methods.find((m) => m.name === c.method)!.kind, c.method).toBe(c.guard);
  });
  it('covers every view the contract has', () => { expect([...COVERED_VIEWS].sort()).toEqual(inv.methods.filter((m) => m.kind === 'view').map((m) => m.name).sort()); });
  it('SAFETY: no case can change state if its guard were missing, except set_paused(false) which is a no-op while unpaused', () => {
    const ctx = { dao: 'dao.near', agent: 'agent.near' };
    for (const c of AUTH_MATRIX) {
      const a: any = c.args(ctx);
      if (c.method === 'set_paused') { expect(a).toEqual({ paused: false }); expect(c.needs).toBe('unpaused'); continue; }
      if (c.method === 'accept_dao') { expect(a).toEqual({}); expect(c.needs).toBe('no-pending-handover'); continue; }
      if ('id' in a) expect(a.id).toBe(9007199254740991);                       // no real mandate has this id
      if (c.method === 'set_agent') expect(a.agent).toBe(ctx.dao);               // rejected by "agent must not be the DAO"
      if (c.method === 'propose_dao') expect(a.new_dao).toBe(ctx.agent);         // rejected by "new DAO must not be the agent"
      if (c.method === 'create_mandate') { expect(a.terms_hash).toHaveLength(1); expect(a.terms_hash.length).not.toBe(64); }
      if (c.method === 'complete') expect(a.report_hash).toHaveLength(1);
    }
  });
  it('only set_paused is decisive evidence', () => { expect(AUTH_MATRIX.filter((c) => c.evidence === 'decisive').map((c) => c.method)).toEqual(['set_paused']); });
  it('mandate ids in the arguments survive JSON exactly (no precision loss)', () => { expect(JSON.parse(JSON.stringify({ id: 9007199254740991 })).id).toBe(9007199254740991); });
  it('skips (never sends) a case whose precondition does not hold', () => {
    const sp = AUTH_MATRIX.find((c) => c.method === 'set_paused')!, ad = AUTH_MATRIX.find((c) => c.method === 'accept_dao')!;
    expect(skipReason(sp, { paused: true, pending_dao: null })).toMatch(/paused/); expect(skipReason(sp, { paused: false, pending_dao: null })).toBeNull();
    expect(skipReason(ad, { paused: false, pending_dao: 'x.near' })).toMatch(/handover is pending/); expect(skipReason(ad, { paused: false, pending_dao: null })).toBeNull();
  });
});

describe('verdicts: what counts as proof', () => {
  const dao = AUTH_MATRIX.find((c) => c.method === 'cancel_mandate')!, paused = AUTH_MATRIX.find((c) => c.method === 'set_paused')!;
  const TRAP = JSON.stringify({ ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'WebAssembly trap: An `unreachable` opcode was executed.' } } } });
  it('a call that SUCCEEDS for an unprivileged account is a failure', () => { const v = classifyAuthOutcome(paused, { ok: true, error: null }); expect(v.pass).toBe(false); expect(v.detail).toMatch(/SUCCEEDED/); });
  it('a contract trap on a decisive case is decisive proof', () => { const v = classifyAuthOutcome(paused, { ok: false, error: TRAP }); expect(v).toMatchObject({ pass: true, evidence: 'decisive' }); });
  it('a contract trap on an indirect case passes but is labelled indirect', () => { const v = classifyAuthOutcome(dao, { ok: false, error: TRAP }); expect(v).toMatchObject({ pass: true, evidence: 'indirect' }); expect(v.detail).toMatch(/Indirect/); });
  it('if a build DOES keep the panic text, a match is decisive for any case', () => { expect(classifyAuthOutcome(dao, { ok: false, error: '"Smart contract panicked: only the DAO may call this"' })).toMatchObject({ pass: true, evidence: 'decisive' }); });
  it('running out of gas money or a dead RPC is INCONCLUSIVE, never a pass (this happened in the first rehearsal run)', () => {
    for (const e of ['Not enough balance for qt-alice.near (balance: 1, cost: 2)', 'fetch failed', 'Invalid signature', 'Exceeded the prepaid gas']) { const v = classifyAuthOutcome(dao, { ok: false, error: e }); expect(v.pass, e).toBe(false); expect(v.detail).toMatch(/INCONCLUSIVE/); }
    expect(isContractRefusal(TRAP)).toBe(true); expect(isContractRefusal('Not enough balance')).toBe(false);
  });
  it('outcomeError reads a failed outcome, a failed receipt, a success and garbage', () => {
    expect(outcomeError({ status: { Failure: { x: 1 } } }).ok).toBe(false);
    expect(outcomeError({ status: { SuccessValue: '' }, receipts_outcome: [{ outcome: { status: { Failure: { y: 2 } } } }] }).ok).toBe(false);
    expect(outcomeError({ status: { SuccessValue: '' }, receipts_outcome: [] })).toEqual({ ok: true, error: null });
    expect(outcomeError(null).ok).toBe(false);
  });
});
