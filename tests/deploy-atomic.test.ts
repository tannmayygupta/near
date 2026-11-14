import { describe, expect, it } from 'vitest';
import { EMPTY_CODE_HASH, SetupAbort, buildDeployInitActions, planContractSetup, setupContract, type CodeState, type SetupDeps } from '../src/near/deploy-atomic';

const WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 42, 42]);
const W = { dao: 'dao.sputnik-dao.near', agent: 'qt-agent.owner.near', localHash: 'LOCALHASH' };
const EMPTY: CodeState = { codeHash: EMPTY_CODE_HASH, version: null };
const GOOD: CodeState = { codeHash: W.localHash, version: 2, dao: W.dao, agent: W.agent };

/** A fake account: state changes only through send(), exactly like the chain (atomic: both actions or neither). */
function fake(start: CodeState, opts: { sendThrows?: string; sendLandsThenThrows?: boolean; landsWrongState?: CodeState } = {}) {
  let state = start; const sends: ReturnType<typeof buildDeployInitActions>[] = []; let reads = 0;
  const deps: SetupDeps = {
    async send(acts) {
      sends.push(acts);
      if (opts.sendLandsThenThrows) { state = GOOD; throw new Error('timeout while waiting for the outcome'); }
      if (opts.sendThrows) throw new Error(opts.sendThrows);
      state = opts.landsWrongState ?? GOOD; return { txHash: 'TX1' };
    },
    async readState() { reads++; return state; },
    async sleep() {},
  };
  return { deps, sends, reads: () => reads, state: () => state };
}

describe('deployment plan (decided from the account state, never overwrites)', () => {
  it('empty account -> deploy and init', () => { expect(planContractSetup(EMPTY, W).action).toBe('deploy-and-init'); expect(planContractSetup({ codeHash: null, version: null }, W).action).toBe('deploy-and-init'); });
  it('same code, initialised for us -> done', () => expect(planContractSetup(GOOD, W).action).toBe('done'));
  it('different code -> abort, never overwrite', () => { const p = planContractSetup({ codeHash: 'OTHER', version: 2, dao: W.dao, agent: W.agent }, W); expect(p.action).toBe('abort'); expect((p as any).reason).toMatch(/refusing to overwrite/); });
  it('same code initialised for someone else (a front-run) -> abort, the account is poisoned', () => { const p = planContractSetup({ ...GOOD, dao: 'attacker.near' }, W); expect(p.action).toBe('abort'); expect((p as any).reason).toMatch(/cannot be trusted/); });
  it('same code, uninitialised (left by an old two-step run) -> init-only recovery', () => expect(planContractSetup({ codeHash: W.localHash, version: null }, W).action).toBe('init-only'));
  it('wrong state version -> abort', () => expect(planContractSetup({ ...GOOD, version: 1 }, W).action).toBe('abort'));
});

describe('the transaction is atomic: deploy and init are two ordered actions of ONE transaction', () => {
  it('builds exactly [DeployContract(wasm), FunctionCall new(dao, agent)] in that order', () => {
    const a: any[] = buildDeployInitActions(WASM, { dao: W.dao, agent: W.agent }, 30n * 10n ** 12n);
    expect(a).toHaveLength(2);
    expect(a[0].enum).toBe('deployContract'); expect(Array.from(a[0].deployContract.code)).toEqual(Array.from(WASM));
    expect(a[1].enum).toBe('functionCall'); expect(a[1].functionCall.methodName).toBe('new');
    expect(JSON.parse(Buffer.from(a[1].functionCall.args).toString())).toEqual({ dao: W.dao, agent: W.agent });
    expect(a[1].functionCall.deposit).toBe(0n); expect(a[1].functionCall.gas).toBe(30n * 10n ** 12n);
  });
  it('happy path: ONE send carrying both actions, then a read-back that matches', async () => {
    const f = fake(EMPTY);
    const r = await setupContract(f.deps, WASM, W, 1n);
    expect(f.sends).toHaveLength(1); expect(f.sends[0]).toHaveLength(2);
    expect(r.outcome).toBe('deployed-and-initialised'); expect(r.txHash).toBe('TX1'); expect(r.state).toEqual(GOOD);
  });
  it('already deployed and initialised: nothing is sent at all', async () => {
    const f = fake(GOOD); const r = await setupContract(f.deps, WASM, W, 1n);
    expect(f.sends).toHaveLength(0); expect(r.outcome).toBe('already-done');
  });
  it('different code on the account: aborts before sending anything', async () => {
    const f = fake({ codeHash: 'SOMEONE_ELSES', version: 2, dao: 'x', agent: 'y' });
    await expect(setupContract(f.deps, WASM, W, 1n)).rejects.toBeInstanceOf(SetupAbort);
    expect(f.sends).toHaveLength(0);
  });
  it('account already initialised by someone else: aborts before sending anything', async () => {
    const f = fake({ codeHash: W.localHash, version: 2, dao: 'attacker.near', agent: 'attacker2.near' });
    await expect(setupContract(f.deps, WASM, W, 1n)).rejects.toThrow(/cannot be trusted/);
    expect(f.sends).toHaveLength(0);
  });
  it('recovery path sends ONLY `new` (the code is already there)', async () => {
    const f = fake({ codeHash: W.localHash, version: null });
    const r = await setupContract(f.deps, WASM, W, 1n);
    expect(f.sends).toHaveLength(1); expect(f.sends[0]).toHaveLength(1); expect((f.sends[0][0] as any).functionCall.methodName).toBe('new');
    expect(r.outcome).toBe('initialised');
  });
});

describe('failure handling: exactly one attempt, never a blind retry', () => {
  it('a failed transaction leaves nothing deployed: stops with a clear message, sent once', async () => {
    const f = fake(EMPTY, { sendThrows: 'Smart contract panicked: init failed' });
    await expect(setupContract(f.deps, WASM, W, 1n)).rejects.toThrow(/nothing was deployed \(it is atomic\)/);
    expect(f.sends).toHaveLength(1); expect(f.state()).toEqual(EMPTY);
  });
  it('an uncertain result (timeout) is resolved by READING the account, not by sending again', async () => {
    const f = fake(EMPTY, { sendLandsThenThrows: true });
    const r = await setupContract(f.deps, WASM, W, 1n);
    expect(f.sends).toHaveLength(1); expect(r.outcome).toBe('confirmed-after-uncertain-result');
  });
  it('success reported but the contract does not read back as intended: refuses to continue', async () => {
    const f = fake(EMPTY, { landsWrongState: { codeHash: W.localHash, version: 2, dao: 'other.near', agent: W.agent } });
    await expect(setupContract(f.deps, WASM, W, 1n)).rejects.toThrow(/does not read back as expected/);
    expect(f.sends).toHaveLength(1);
  });
  it('an error plus an unexpected account state stops and says to inspect first', async () => {
    const f = fake({ codeHash: EMPTY_CODE_HASH, version: null });
    let first = true; const deps: SetupDeps = { ...f.deps, async send(a) { f.sends.push(a); throw new Error('rpc dropped'); }, async readState() { if (first) { first = false; return EMPTY; } return { codeHash: 'WEIRD', version: 1 }; } };
    await expect(setupContract(deps, WASM, W, 1n)).rejects.toThrow(/unexpected state/);
    expect(f.sends).toHaveLength(1);
  });
  it('the key facts of the race: with one transaction there is no moment where code exists without state', async () => {
    // every state the fake ever exposes is either EMPTY or GOOD; there is no (code, uninitialised) state for an attacker to call new() in
    const seen: CodeState[] = []; const f = fake(EMPTY); const rs = f.deps.readState;
    f.deps.readState = async () => { const s = await rs(); seen.push(s); return s; };
    await setupContract(f.deps, WASM, W, 1n);
    expect(seen.every((s) => s.version === null ? s.codeHash === EMPTY_CODE_HASH : s.version === 2)).toBe(true);
  });
});
