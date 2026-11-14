// Wallet parity: the transactions the dashboard asks a wallet to sign (wizard: add_proposal, votes: act_proposal) must be IDENTICAL in method,
// JSON arguments, deposit and gas to the ones the tested scripts send (src/near/sputnik.ts, scripts/testnet/lib.ts which dao-flow.ts and e2e-real.ts use).
// Nobody has driven the wallet path with a human yet, so this is the next best proof: same bytes in, same bytes out. It does NOT prove that a wallet
// (MyNearWallet through the wallet selector) renders, signs or submits them; that still needs a human.
//
// The "script side" is exercised through the REAL code (sp.addProposal, sp.vote, proposeWithHash, voteTx) with only the network layer
// (src/near/chain.ts: view, callTx, accountFor) replaced by recorders.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

type Sent = { via: string; contractId: string; methodName: string; args: any; gas: bigint; deposit: bigint };
const h = vi.hoisted(() => ({
  sent: [] as Array<{ via: string; contractId: string; methodName: string; args: any; gas: bigint; deposit: bigint }>,
  // Live `get_policy` of quietdao-83872.sputnikv2.testnet read on 2026-11-14: proposal_bond = 1 NEAR.
  bond: '1000000000000000000000000',
  kinds: {} as Record<number, unknown>,
}));
vi.mock('../src/near/chain.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/near/chain.js')>();
  const record = (via: string, o: { contractId: string; methodName: string; args: any; gas: bigint; deposit?: bigint }) => {
    h.sent.push({ via, contractId: o.contractId, methodName: o.methodName, args: o.args, gas: o.gas, deposit: o.deposit ?? 0n });
  };
  return {
    ...orig,
    view: vi.fn(async (_rpc: string, _contract: string, method: string, args: any) => {
      if (method === 'get_policy') return { proposal_bond: h.bond, proposal_period: '604800000000000', roles: [] };
      if (method === 'get_proposal') return { id: args.id, kind: h.kinds[args.id] };
      throw new Error(`unexpected view ${method}`);
    }),
    callTx: vi.fn(async (_acc: unknown, contractId: string, methodName: string, args: object, gas: bigint, deposit: bigint = 0n) => {
      record('callTx', { contractId, methodName, args, gas, deposit });
      return { value: 41, txHash: 'RECORDED_TX' };
    }),
    accountFor: vi.fn(() => ({ callFunction: async (o: any) => { record('callFunction', o); return 41; } })),
  };
});

import * as sp from '../src/near/sputnik.js';
import { proposeWithHash, voteTx, type TestnetConfig } from '../scripts/testnet/lib.js';
import { canonicalJson, commit, hashJson } from '../src/engine/hash.js';
import * as ui from '../app/lib/dao-tx';
import { canonical } from '../app/lib/canon';
import { sha256Hex } from '../app/lib/data';

const BOM = new RegExp('^\\uFEFF');
const recorded = JSON.parse(readFileSync('data/demo-run/run.json', 'utf8').replace(BOM, ''));
const pub = JSON.parse(readFileSync('data/testnet-public.json', 'utf8').replace(BOM, ''));
const DAO: string = pub.dao, MANDATE: string = pub.mandateContract, VAULT: string = pub.vault, RPC = 'http://rpc.invalid';
// The REAL terms of the recorded mandate #11 (what e2e-real.ts proposed to the DAO and the chain stores).
const terms = JSON.parse(recorded.mandate.terms_json) as { treasurer: string; sellToken: string; maxSellAmount: string; startTs: number; endTs: number };
const cfg: TestnetConfig = {
  rpc: RPC, factory: pub.factory, dao: DAO, mandate: MANDATE, suffix: 'x',
  accounts: { council1: { accountId: pub.council[0], publicKey: 'ed25519:x', secretKey: 'ed25519:x' } },
};
const fakeAccount = { accountId: pub.council[0], callFunction: async (o: any) => { h.sent.push({ via: 'callFunction', contractId: o.contractId, methodName: o.methodName, args: o.args, gas: o.gas, deposit: o.deposit ?? 0n }); return 41; } } as any;

// scripts/testnet/e2e-real.ts line: `const createArgs = (terms, tier) => ({ ... })` (pinned below so a change to the script fails this test).
const scriptCreateArgs = (t: any, tier: 'small' | 'mid' | 'large') => ({ treasurer: t.treasurer, terms_hash: hashJson(t), terms_json: JSON.stringify(t), sell_token: t.sellToken, max_sell: t.maxSellAmount, start_ns: t.startTs * 1e9, end_ns: t.endTs * 1e9, tier });

/** What a transaction looks like to the chain, whoever built it. */
const onWire = (x: { contractId: string; methodName: string; args: any; gas: bigint | string; deposit: bigint | string }) =>
  ({ contractId: x.contractId, methodName: x.methodName, argsJson: JSON.stringify(x.args), gas: String(x.gas), deposit: String(x.deposit) });
const uiWire = (t: ui.DaoTx) => onWire({ contractId: t.receiverId, methodName: t.methodName, args: t.args, gas: t.gas, deposit: t.deposit });
const lastWire = (n = 1) => h.sent.slice(-n).map((s: Sent) => onWire(s));

beforeEach(() => { h.sent.length = 0; for (const k of Object.keys(h.kinds)) delete h.kinds[Number(k)]; });

describe('wallet parity: proposal payloads (what is inside add_proposal)', () => {
  const description = 'Quiet Treasury mandate: parity check';
  const cases: Array<{ name: string; ui: ui.ProposalBody; script: object }> = [
    {
      name: 'create_mandate FunctionCall proposal (plain terms, tier small)',
      ui: ui.createMandateProposal(MANDATE, description, ui.createMandateArgs(terms, hashJson(terms), JSON.stringify(terms), 'small')),
      script: sp.functionCallKind(MANDATE, 'create_mandate', scriptCreateArgs(terms, 'small')),
    },
    {
      name: 'create_mandate FunctionCall proposal (sealed: terms_json null, commitment only)',
      ui: ui.createMandateProposal(MANDATE, description, ui.createMandateArgs(terms, commit(terms, 'ab'.repeat(16)), null, 'small')),
      script: sp.functionCallKind(MANDATE, 'create_mandate', { ...scriptCreateArgs(terms, 'small'), terms_hash: commit(terms, 'ab'.repeat(16)), terms_json: null }),
    },
    {
      name: 'funding Transfer proposal (native NEAR, DAO treasury -> vault)',
      ui: ui.fundVaultProposal(description, VAULT, terms.maxSellAmount),
      script: sp.transferKind('', VAULT, terms.maxSellAmount),
    },
  ];

  for (const c of cases) {
    it(`${c.name}: kind is byte-identical to the script's`, () => {
      expect(JSON.stringify(c.ui.proposal.kind)).toBe(JSON.stringify(c.script));
      expect(c.ui.proposal.description).toBe(description);
    });

    it(`${c.name}: add_proposal from the wallet == add_proposal from sp.addProposal == from scripts/testnet/lib.ts proposeWithHash`, async () => {
      // the UI reads the live bond the way the scripts do (get_policy.proposal_bond) and attaches it
      const bond = ui.proposalBondOf(await sp.getPolicy(RPC, DAO));
      const wallet = uiWire(ui.addProposalTx(DAO, c.ui, bond));

      await sp.addProposal(RPC, fakeAccount, DAO, description, c.script);
      await proposeWithHash(cfg, 'council1', description, c.script, 'parity');
      const [viaLib, viaScripts] = lastWire(2);

      expect(viaLib).toEqual(wallet);
      expect(viaScripts).toEqual(wallet);
      expect(wallet).toMatchObject({ contractId: DAO, methodName: 'add_proposal', gas: '30000000000000', deposit: h.bond });
      expect(JSON.parse(wallet.argsJson)).toEqual({ proposal: { description, kind: c.script } });
    });
  }

  it('terms_json: the wizard sends canonical JSON, the scripts send zod-order JSON: same terms, same hash, and the worker accepts either', async () => {
    const wizardJson = canonical(terms);
    expect(wizardJson).toBe(canonicalJson(terms)); // the wizard's canonical() IS the engine's canonicalJson() on mandate terms
    expect(JSON.parse(wizardJson)).toEqual(JSON.parse(JSON.stringify(terms)));
    expect(hashJson(JSON.parse(wizardJson))).toBe(hashJson(terms)); // worker/executor.ts re-hashes the parsed terms, so key order is irrelevant
    // and the browser's hash of the terms is exactly the terms_hash the chain stores for the real recorded mandate #11
    expect(await sha256Hex(canonical(terms))).toBe(recorded.mandate.terms_hash);
  });

  it('create_mandate arguments equal e2e-real createArgs field by field (names, order, start_ns/end_ns as numbers)', () => {
    const wizard = ui.createMandateArgs(terms, hashJson(terms), JSON.stringify(terms), 'small');
    expect(JSON.stringify(wizard)).toBe(JSON.stringify(scriptCreateArgs(terms, 'small')));
    expect(wizard.start_ns).toBe(recorded.mandate.start_ns);
    expect(wizard.end_ns).toBe(recorded.mandate.end_ns);
  });

  it('base64 of the browser equals base64 of Node for ASCII and non-ASCII text', () => {
    for (const s of ['{"a":1}', 'Quiet Treasury · terms_hash x', 'émoji 🙂 日本語']) expect(ui.b64(s)).toBe(Buffer.from(s).toString('base64'));
  });
});

describe('wallet parity: the proposal bond (a real mismatch found and fixed 2026-11-14)', () => {
  it('the wizard used to attach a hard-coded 0.1 NEAR; the DAO requires its policy bond (1 NEAR) and would have refused it', () => {
    const OLD_HARDCODED = 10n ** 23n; // 0.1 NEAR, the value wizard/page.tsx used to send
    expect(BigInt(h.bond)).toBeGreaterThan(OLD_HARDCODED);
  });
  it('the deposit is always the DAO policy bond, whatever it is', async () => {
    for (const bond of ['1000000000000000000000000', '100000000000000000000000', '0', '5000000000000000000000000']) {
      h.bond = bond;
      const tx = ui.addProposalTx(DAO, ui.fundVaultProposal('x', VAULT, '1'), ui.proposalBondOf(await sp.getPolicy(RPC, DAO)));
      await proposeWithHash(cfg, 'council1', 'x', sp.transferKind('', VAULT, '1'), 'bond');
      expect(tx.deposit).toBe(bond);
      expect(lastWire()[0].deposit).toBe(bond);
    }
    h.bond = '1000000000000000000000000';
  });
  it('a policy without a usable proposal_bond is refused, never turned into a guessed deposit', () => {
    expect(() => ui.proposalBondOf({ proposal_bond: 'abc' })).toThrow(/proposal_bond/);
    expect(() => ui.proposalBondOf({ proposal_bond: '-1' })).toThrow(/proposal_bond/);
    expect(() => ui.proposalBondOf({ proposal_bond: 5 })).toThrow(/proposal_bond/);
    expect(ui.proposalBondOf({})).toBe('0'); // same as the scripts: BigInt(policy.proposal_bond ?? '0')
  });
});

describe('wallet parity: act_proposal (vote / finalize)', () => {
  const kind = sp.functionCallKind(MANDATE, 'create_mandate', scriptCreateArgs(terms, 'small'));
  const PID = 12;
  for (const action of ['VoteApprove', 'VoteReject'] as const) {
    it(`${action}: wallet == sp.vote == scripts/testnet/lib.ts voteTx (args { id, action, proposal: kind }, 150 TGas, deposit 0)`, async () => {
      h.kinds[PID] = kind;
      const wallet = uiWire(ui.actProposalTx(DAO, PID, action, kind));
      await sp.vote(RPC, fakeAccount, DAO, PID, action);
      await voteTx(cfg, 'council1', PID, action, 'parity');
      const [viaLib, viaScripts] = lastWire(2);
      expect(viaLib).toEqual(wallet);
      expect(viaScripts).toEqual(wallet);
      expect(wallet).toMatchObject({ contractId: DAO, methodName: 'act_proposal', gas: '150000000000000', deposit: '0' });
      expect(JSON.parse(wallet.argsJson)).toEqual({ id: PID, action, proposal: kind });
    });
  }
  for (const action of ['VoteRemove', 'Finalize'] as const) {
    it(`${action}: wallet == sp.vote (the votes page offers only Approve/Reject today; this pins the payload for when it does)`, async () => {
      h.kinds[PID] = kind;
      const wallet = uiWire(ui.actProposalTx(DAO, PID, action, kind));
      await sp.vote(RPC, fakeAccount, DAO, PID, action);
      expect(lastWire()[0]).toEqual(wallet);
    });
  }
  it('the kind echoed back is the one Sputnik returned for that proposal id (Transfer too), unchanged', async () => {
    const transfer = sp.transferKind('', VAULT, terms.maxSellAmount);
    h.kinds[13] = transfer;
    const p = await sp.getProposal(RPC, DAO, 13);
    expect(uiWire(ui.actProposalTx(DAO, 13, 'VoteApprove', p.kind)).argsJson).toBe(JSON.stringify({ id: 13, action: 'VoteApprove', proposal: transfer }));
  });
});

describe('wallet parity: the scripts still send what this test assumes (pinned to their source)', () => {
  const src = (f: string) => readFileSync(f, 'utf8');
  it('e2e-real.ts builds createArgs and both proposals exactly as modelled here and goes through lib.ts', () => {
    const s = src('scripts/testnet/e2e-real.ts');
    expect(s).toContain("const createArgs = (terms: MandateTerms, tier: 'small' | 'mid' | 'large'): mc.CreateArgs => ({ treasurer: terms.treasurer, terms_hash: hashJson(terms), terms_json: JSON.stringify(terms), sell_token: terms.sellToken, max_sell: terms.maxSellAmount, start_ns: terms.startTs * 1e9, end_ns: terms.endTs * 1e9, tier });");
    expect(s).toContain("sp.functionCallKind(c.mandate, 'create_mandate', createArgs(t, 'small'))");
    expect(s).toContain("sp.transferKind('', VAULT, t.maxSellAmount)");
    expect(s).toMatch(/proposeWithHash, voteTx/); // imported from ./lib.js
  });
  it('dao-flow.ts proposes with lib.ts proposeWithHash / voteTx', () => {
    const s = src('scripts/testnet/dao-flow.ts');
    expect(s).toContain("sp.functionCallKind(c.mandate, 'create_mandate', args)");
    expect(s).toMatch(/proposeWithHash, voteTx/);
  });
  it('e2e-sealed.ts creates the sealed mandate with terms_json null through the same builders', () => {
    const s = src('scripts/testnet/e2e-sealed.ts');
    expect(s).toContain('terms_json: null as any');
    expect(s).toContain("sp.functionCallKind(c.mandate, 'create_mandate', sealedCreateArgs)");
  });
  it('lib.ts: add_proposal = 30 TGas + the policy bond; act_proposal = 150 TGas, kind echoed (the numbers exercised above)', () => {
    const s = src('scripts/testnet/lib.ts');
    expect(s).toContain("'add_proposal', { proposal: { description, kind } }, TGAS(30), BigInt(policy.proposal_bond ?? '0')");
    expect(s).toContain("'act_proposal', { id, action, proposal: p.kind }, TGAS(150)");
  });
  it('the dashboard pages build their transactions with lib/dao-tx.ts and nothing inline', () => {
    const wiz = src('app/app/wizard/page.tsx'), votes = src('app/app/votes/page.tsx');
    expect(wiz).toContain('addProposalTx(');
    expect(wiz).toContain('createMandateProposal(');
    expect(wiz).not.toMatch(/methodName:\s*'add_proposal'/);
    expect(wiz).not.toContain('100000000000000000000000'); // the old hard-coded 0.1 NEAR deposit
    expect(votes).toContain('actProposalTx(');
    expect(votes).not.toMatch(/methodName:\s*'act_proposal'/);
  });
});
