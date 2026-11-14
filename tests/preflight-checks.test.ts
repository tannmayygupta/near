import { KeyPair } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { runPreflight, secretLike, type PreflightDeps } from '../src/near/preflight-checks';
import { codeHashOf, estimateSetup, fromYocto, remainingSetupNeed, toYocto, SETUP_PLAN } from '../src/near/setup-plan';

const WASM = new Uint8Array(369245).fill(7);
const kp = KeyPair.fromRandom('ed25519'); const SECRET = kp.toString(); const PUB = kp.getPublicKey().toString();
const HASH = codeHashOf(WASM);
const sdOk = { dir: 'D:\\qt', resolved: 'D:\\qt', synced: false, why: 'not inside a known synchronised folder', overridden: true, insideRepo: false };

function deps(over: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    env: { QT_FUNDER_ACCOUNT: 'owner.near', QT_FUNDER_KEY: SECRET, NEAR_AI_API_KEY: 'sk-test-not-real', QT_NET: 'mainnet' }, net: 'mainnet',
    chainId: async () => 'mainnet',
    viewAccount: async (id) => (id === 'owner.near' ? { amount: toYocto(20), codeHash: EMPTY } : null),
    accessKey: async (_id, pk) => (pk === PUB ? { permission: 'FullAccess' } : null),
    readWasm: () => WASM, recordedReleaseHash: () => HASH, codeHashOf,
    secretDir: sdOk, secretDirWritable: true,
    git: { envIgnored: true, trackedSecretLike: [], secretDirIgnored: null }, envFileText: 'NEAR_AI_API_KEY=x\n', envFileSynced: false, setupMinimum: toYocto(16), ...over,
  };
}
const EMPTY = '11111111111111111111111111111111';
const ser = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)); // results carry BigInt amounts
const blocking = (r: Awaited<ReturnType<typeof runPreflight>>) => r.checks.filter((c) => !c.ok && c.level === 'fail').map((c) => c.name);

describe('mainnet preflight (every check is a read)', () => {
  it('a fully prepared environment has no blocking finding', async () => { const r = await runPreflight(deps()); expect(blocking(r)).toEqual([]); expect(r.wasm?.codeHash).toBe(HASH); });
  it('missing credentials block, and name exactly what is missing', async () => {
    const r = await runPreflight(deps({ env: { QT_NET: 'mainnet' } }));
    expect(blocking(r)).toEqual(expect.arrayContaining(['QT_FUNDER_ACCOUNT is set', 'QT_FUNDER_KEY is set']));
  });
  it('a key that is not an access key of the owner blocks', async () => {
    const r = await runPreflight(deps({ accessKey: async () => null }));
    expect(blocking(r)).toContain('the key belongs to the owner account and has FULL ACCESS');
  });
  it('a function-call-only key is not enough', async () => {
    const r = await runPreflight(deps({ accessKey: async () => ({ permission: { FunctionCall: { receiver_id: 'x.near', method_names: [] } } }) }));
    expect(blocking(r)).toContain('the key belongs to the owner account and has FULL ACCESS');
  });
  it('a malformed key blocks without leaking it', async () => {
    const r = await runPreflight(deps({ env: { QT_FUNDER_ACCOUNT: 'owner.near', QT_FUNDER_KEY: 'not-a-key' } }));
    expect(blocking(r)).toContain('QT_FUNDER_KEY is a well-formed ed25519 secret key'); expect(ser(r)).not.toContain('not-a-key');
  });
  it('an implicit (64-hex) owner blocks', async () => { const r = await runPreflight(deps({ env: { QT_FUNDER_ACCOUNT: 'a'.repeat(64), QT_FUNDER_KEY: SECRET } })); expect(blocking(r)).toContain('owner is a NAMED account (sub-accounts cannot be created under a 64-hex implicit account)'); });
  it('too little balance blocks and shows the shortfall in NEAR', async () => {
    const r = await runPreflight(deps({ viewAccount: async (id) => (id === 'owner.near' ? { amount: toYocto(10), codeHash: EMPTY } : null) }));
    expect(blocking(r)).toContain('owner balance covers the setup'); expect(r.checks.find((c) => c.name === 'owner balance covers the setup')!.detail).toMatch(/has 10\.0000 NEAR .* needs 16\.0000/);
  });
  it('the contract account holding DIFFERENT code blocks (setup would refuse to overwrite it)', async () => {
    const r = await runPreflight(deps({ viewAccount: async (id) => (id === 'owner.near' ? { amount: toYocto(20), codeHash: EMPTY } : id === 'qt-mandate.owner.near' ? { amount: 1n, codeHash: 'SOMEOTHERHASH' } : null) }));
    expect(blocking(r)).toContain('contract account is free, or already holds exactly the committed wasm');
  });
  it('the contract account already holding exactly the committed wasm is fine (setup resumes)', async () => {
    const r = await runPreflight(deps({ viewAccount: async (id) => (id === 'owner.near' ? { amount: toYocto(20), codeHash: EMPTY } : id === 'qt-mandate.owner.near' ? { amount: 1n, codeHash: HASH } : null) }));
    expect(blocking(r)).toEqual([]);
  });
  it('a wasm that differs from the recorded release blocks', async () => { const r = await runPreflight(deps({ recordedReleaseHash: () => 'SOMETHINGELSE' })); expect(blocking(r)).toContain('WASM equals the recorded release (the one verified on testnet)'); });
  it('a missing wasm blocks', async () => { const r = await runPreflight(deps({ readWasm: () => null })); expect(blocking(r)).toContain('WASM artifact exists'); });
  it('the wrong network blocks and nothing on-chain is read afterwards', async () => {
    let reads = 0; const r = await runPreflight(deps({ chainId: async () => 'testnet', viewAccount: async () => { reads++; return null; } }));
    expect(blocking(r)).toContain('RPC reachable and on the intended network'); expect(reads).toBe(0);
  });
  it('an unreachable RPC blocks with the reason', async () => { const r = await runPreflight(deps({ chainId: async () => { throw new Error('ECONNREFUSED'); } })); expect(r.checks[0].detail).toMatch(/ECONNREFUSED/); expect(blocking(r)).toContain('RPC reachable and on the intended network'); });
  it('a secret directory inside OneDrive blocks', async () => { const r = await runPreflight(deps({ secretDir: { ...sdOk, resolved: 'C:\\Users\\me\\OneDrive\\x\\data\\secret', synced: true, why: 'inside the OneDrive folder C:\\Users\\me\\OneDrive', overridden: false, insideRepo: true }, git: { envIgnored: true, trackedSecretLike: [], secretDirIgnored: true } })); expect(blocking(r)).toContain('secret directory is not inside a cloud-synchronised folder'); });
  it('a secret directory inside the repo must be git-ignored', async () => { const r = await runPreflight(deps({ secretDir: { ...sdOk, insideRepo: true }, git: { envIgnored: true, trackedSecretLike: [], secretDirIgnored: false } })); expect(blocking(r)).toContain('secret directory is git-ignored'); });
  it('.env not ignored, tracked secret files, or ALLOW_MAINNET in .env all block', async () => {
    const r = await runPreflight(deps({ git: { envIgnored: false, trackedSecretLike: ['data/secret/mainnet-config.json'], secretDirIgnored: null }, envFileText: 'ALLOW_MAINNET=1' }));
    expect(blocking(r)).toEqual(expect.arrayContaining(['.env is git-ignored', 'no secret-looking file is tracked by git', 'ALLOW_MAINNET is not stored in .env']));
  });
  it('NEVER puts the key, the key text or the API key in a result', async () => { const s = ser(await runPreflight(deps())); expect(s).not.toContain(SECRET.slice(8, 30)); expect(s).not.toContain('sk-test-not-real'); expect(s).toContain(PUB); /* the PUBLIC key may be shown */ });
  it('is read-only by construction: the only dependencies it receives are readers', () => {
    const d = deps(); for (const k of Object.keys(d)) expect(k).not.toMatch(/send|sign|transfer|deploy|write|create/i);
  });
});

describe('funding estimate (recomputed from the setup plan itself)', () => {
  it('sums the owner outflow from the plan, separate from storage and gas', () => {
    const e = estimateSetup(369245);
    expect(fromYocto(e.subAccounts)).toBe('9.1500'); expect(fromYocto(e.daoDeposit)).toBe('6.0000'); expect(fromYocto(e.outflow)).toBe('15.1500');
    expect(fromYocto(e.contractStorage)).toBe('3.6924'); expect(e.contractFundedEnough).toBe(true);
    expect(e.required).toBe(e.outflow + toYocto(SETUP_PLAN.gasEstimateNear) + toYocto(SETUP_PLAN.ownerReserveNear));
  });
  it('a bigger wasm that no longer fits the contract account is flagged', () => { expect(estimateSetup(500_000).contractFundedEnough).toBe(false); });
  it('secret-looking tracked files are recognised, examples are not', () => {
    expect(secretLike(['.env', 'app/.env.local', 'data/secret/a.json', 'x/near-credentials/y.json', 'k.pem'])).toHaveLength(5);
    expect(secretLike(['.env.example', 'app/.env.testnet.example', 'src/index.ts'])).toHaveLength(0);
  });
});

describe('balance gate before any transaction (no partial setup)', () => {
  const ALL = SETUP_PLAN.subAccounts.map((s) => s.sub);
  it('a fresh run needs every sub-account + the DAO deposit + a 0.3 gas margin = 15.45 NEAR', () => { expect(fromYocto(remainingSetupNeed({ subs: [], dao: false }))).toBe('15.4500'); });
  it('a resumed run only needs what is still missing (here: only the DAO)', () => { expect(fromYocto(remainingSetupNeed({ subs: ALL, dao: false }))).toBe('6.3000'); });
  it('a fully set-up owner needs just the gas margin', () => { expect(fromYocto(remainingSetupNeed({ subs: ALL, dao: true }))).toBe('0.3000'); });
  it('partial progress is subtracted account by account (council1 and the contract account already exist)', () => { expect(fromYocto(remainingSetupNeed({ subs: ['qt-c1', 'qt-mandate'], dao: false }))).toBe('9.1500'); });
  it('the owner outflow can never exceed the planned deposit: the plan has no escalation knob', () => { expect(Object.keys(SETUP_PLAN).sort()).toEqual(['daoDepositNear', 'gasEstimateNear', 'ownerReserveNear', 'subAccounts', 'vaultNear']); });
});
describe('the owner key must not sit in a .env that a cloud drive uploads', () => {
  it('blocks when QT_FUNDER_KEY is written in a synchronised .env', async () => {
    const r = await runPreflight(deps({ envFileText: 'QT_FUNDER_KEY=ed25519:abc\n', envFileSynced: true }));
    expect(blocking(r)).toContain('the owner key is not stored in a .env that a cloud drive synchronises');
  });
  it('passes when the key is only in the shell, or .env is not synchronised', async () => {
    expect(blocking(await runPreflight(deps({ envFileText: 'NEAR_AI_API_KEY=x\n', envFileSynced: true })))).toEqual([]);
    expect(blocking(await runPreflight(deps({ envFileText: 'QT_FUNDER_KEY=ed25519:abc\n', envFileSynced: false })))).toEqual([]);
  });
  it('never echoes the key from .env into the result', async () => {
    const s = ser(await runPreflight(deps({ envFileText: 'QT_FUNDER_KEY=ed25519:SUPERSECRETVALUE123\n', envFileSynced: true })));
    expect(s).not.toContain('SUPERSECRETVALUE123');
  });
});