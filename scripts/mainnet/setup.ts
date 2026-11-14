// SETUP OF THE MAINNET SLICE (or, with QT_NET=testnet, a free rehearsal of exactly the same script on public testnet).
// Creates, idempotently and in this order: sub-accounts of the OWNER account (3 council members, the agent, 3 payee accounts, the mandate contract account),
// a real Sputnik DAO v2 (council = the 3 accounts, 2 of 3 to pass), deploys + initialises the committed mandate contract wasm, creates the vault
// (a key-held account that holds the DAO-funded budget and signs swaps) and adds the agent's FUNCTION-CALL key (Layer 0: 5 methods, no deposit).
//
// MONEY: about 15 NEAR leaves the owner account. Most of it is not "spent": ~6 NEAR becomes the DAO treasury, ~4 NEAR is storage of the contract account,
// the rest is gas floats and tiny balances of accounts the owner controls. See docs/MAINNET.md.
//
// Run (mainnet):   $env:ALLOW_MAINNET='1'; npx tsx --env-file=.env scripts/mainnet/setup.ts      (needs QT_FUNDER_ACCOUNT and QT_FUNDER_KEY in .env: the OWNER's named account + its full-access key)
// Run (rehearsal): $env:QT_NET='testnet'; npx tsx --env-file=.env scripts/mainnet/setup.ts       (creates its own free testnet owner; touches nothing else)
import './profile.js';
import { KeyPair, baseEncode } from 'near-api-js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { accountFor, providerFor, view, b64, TGAS, NEAR } from '../../src/near/chain.js';
import { Acct, TestnetConfig, PUBLIC_PATH, TAG, hasConfig, loadConfig, saveConfig, explorerAccount, explorerTx, helperCreate, sleep } from '../testnet/lib.js';
import { P, IS_MAINNET, LIMITS, requireMainnetConsent } from './net.js';

requireMainnetConsent('create accounts, a DAO and a contract');
const rpc = P.rpc, prov = providerFor(rpc);
const exists = async (id: string) => { try { await prov.viewAccount({ accountId: id }); return true; } catch { return false; } };
const bal = async (id: string) => BigInt((await prov.viewAccount({ accountId: id })).amount);
const nearOf = (y: bigint) => (Number(y / 10n ** 20n) / 1e4).toFixed(3);
const die = (m: string): never => { console.error('STOP:', m); process.exit(1); };

// ---------------- the owner (the only account whose key you hand to this script, via the environment, never a file we write)
let ownerId = process.env.QT_FUNDER_ACCOUNT ?? '', ownerKey = process.env.QT_FUNDER_KEY ?? '';
const OWNER_FILE = `data/secret/${TAG}-owner.json`;
if (!ownerId || !ownerKey) {
  if (IS_MAINNET) die('set QT_FUNDER_ACCOUNT (your named mainnet account) and QT_FUNDER_KEY (its ed25519 secret key) in .env');
  if (existsSync(OWNER_FILE)) ({ accountId: ownerId, secretKey: ownerKey } = JSON.parse(readFileSync(OWNER_FILE, 'utf8')));
  else { // rehearsal only: two free faucet accounts (10 NEAR each) merged into one owner
    const suffix = Math.floor(Math.random() * 90000 + 10000);
    const kpA = KeyPair.fromRandom('ed25519'), kpB = KeyPair.fromRandom('ed25519');
    const a = await helperCreate(`qtr-a-${suffix}.testnet`, kpA), b = await helperCreate(`qtr-b-${suffix}.testnet`, kpB);
    await sleep(4000);
    await accountFor(rpc, b.accountId, b.secretKey).transfer({ receiverId: a.accountId, amount: (await bal(b.accountId)) - NEAR('0.3') });
    mkdirSync('data/secret', { recursive: true }); writeFileSync(OWNER_FILE, JSON.stringify(a, null, 2));
    ownerId = a.accountId; ownerKey = a.secretKey; await sleep(3000);
  }
}
if (/^[0-9a-f]{64}$/.test(ownerId)) die('the owner must be a NAMED account (sub-accounts cannot be created under an implicit 64-hex account)');
if (!ownerKey.startsWith('ed25519:')) die('QT_FUNDER_KEY must look like ed25519:...');
if (!(await exists(ownerId))) die(`owner account ${ownerId} does not exist on ${P.name}`);
const owner = accountFor(rpc, ownerId, ownerKey);
const have = await bal(ownerId), need = NEAR(LIMITS.setupNear);
console.log(`network ${P.name} | owner ${ownerId} holds ${nearOf(have)} NEAR | this setup needs about ${LIMITS.setupNear}`);
if (have < need && !hasConfig()) die(`the owner needs at least ${LIMITS.setupNear} NEAR to run this setup (has ${nearOf(have)})`);

// ---------------- config (secrets only in data/secret/<tag>-config.json, git-ignored)
let cfg: TestnetConfig;
if (hasConfig()) cfg = loadConfig();
else {
  const suffix = String(Math.floor(Math.random() * 90000 + 10000));
  cfg = { rpc, factory: P.factory, dao: `quietdao-${suffix}.${P.factory}`, mandate: `qt-mandate.${ownerId}`, suffix, accounts: {} };
  saveConfig(cfg);
}
const acct = (id: string, kp: KeyPair): Acct => ({ accountId: id, publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() });

/** Create `<sub>.<owner>` with `nearAmt` NEAR. The key is saved BEFORE the transaction is sent, so a crash can never orphan an account. */
async function ensureSub(role: string, sub: string, nearAmt: string) {
  const id = `${sub}.${ownerId}`;
  if (!cfg.accounts[role]) { cfg.accounts[role] = acct(id, KeyPair.fromRandom('ed25519')); saveConfig(cfg); }
  if (await exists(id)) { console.log('exists ', id); return; }
  await owner.createAccount({ newAccountId: id, publicKey: KeyPair.fromString(cfg.accounts[role].secretKey as any).getPublicKey(), nearToTransfer: NEAR(nearAmt) });
  console.log('created', id.padEnd(40), nearAmt, 'NEAR'); await sleep(2500);
}
await ensureSub('council1', 'qt-c1', '2'); // the DAO policy's proposal bond is 1 NEAR (refunded when the proposal executes): council1 proposes, so it needs the bond plus gas
await ensureSub('council2', 'qt-c2', '0.4');
await ensureSub('council3', 'qt-c3', '0.4');
await ensureSub('agent', 'qt-agent', '1.9'); // 1.5 NEAR of it becomes the vault
await ensureSub('contributor', 'qt-alice', '0.05');
await ensureSub('treasurer', 'qt-bob', '0.05');
await ensureSub('funder', 'qt-fee', '0.05'); // role name kept from the testnet config: this account receives the service fee
await ensureSub('mandate', 'qt-mandate', '4.3'); // 369 KB of wasm = about 3.7 NEAR of storage staking

// ---------------- the DAO (real Sputnik v2 factory)
if (!(await exists(cfg.dao))) {
  const council = ['council1', 'council2', 'council3'].map((n) => cfg.accounts[n].accountId);
  const args = { config: { name: cfg.dao.split('.')[0], purpose: `Quiet Treasury (${P.name} slice)`, metadata: '' }, policy: council };
  let deposit = 6;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await owner.callFunction({ contractId: P.factory, methodName: 'create', args: { name: args.config.name, args: b64(args) }, gas: TGAS(150), deposit: NEAR(deposit) });
      break;
    } catch (e: any) {
      const m = String(e.message ?? e); const needM = m.match(/(\d+(?:\.\d+)?)\s*NEAR/i);
      console.log('create DAO failed:', m.slice(0, 200));
      if (needM && Number(needM[1]) > deposit && Number(needM[1]) < 9) deposit = Math.ceil(Number(needM[1]) + 0.1); else throw e;
    }
  }
  await sleep(3000);
}
if (!(await exists(cfg.dao))) die('the DAO account does not exist after creation');
const policy: any = await view(rpc, cfg.dao, 'get_policy');
console.log('DAO', cfg.dao, '| roles:', (policy.roles ?? []).map((r: any) => r.name).join(','), '| bond:', policy.proposal_bond, '| treasury', nearOf(await bal(cfg.dao)), 'NEAR');

// ---------------- the mandate contract (the committed wasm, nothing else)
const wasm = readFileSync('contracts/mandate/out/mandate.wasm');
const localHash = baseEncode(createHash('sha256').update(wasm).digest());
const mAcc = accountFor(rpc, cfg.accounts.mandate.accountId, cfg.accounts.mandate.secretKey);
let deployTx = '', initTx = '';
const cur: any = await prov.viewAccount({ accountId: cfg.mandate });
if (!cur.codeHash || cur.codeHash === '11111111111111111111111111111111') {
  const r: any = await mAcc.deployContract(wasm); deployTx = r.transaction?.hash ?? r.transaction_outcome?.id ?? ''; console.log('deployed', deployTx); await sleep(4000);
}
let version = 0; try { version = await view<number>(rpc, cfg.mandate, 'get_version'); } catch { /* not initialised */ }
if (version !== 2) {
  const r: any = await mAcc.callFunctionRaw({ contractId: cfg.mandate, methodName: 'new', args: { dao: cfg.dao, agent: cfg.accounts.agent.accountId }, gas: TGAS(30) });
  initTx = r.transaction?.hash ?? r.transaction_outcome?.id ?? ''; console.log('initialised', initTx); await sleep(4000);
}
const after: any = await prov.viewAccount({ accountId: cfg.mandate });
const onChain = after.codeHash ?? after.code_hash;
const stats: any = await view(rpc, cfg.mandate, 'get_stats');
if (onChain !== localHash) die(`code hash on chain (${onChain}) is not the committed wasm (${localHash})`);
if (stats.version !== 2 || stats.dao !== cfg.dao || stats.agent !== cfg.accounts.agent.accountId) die('contract is not initialised for this DAO and agent');
console.log('contract', cfg.mandate, '| code hash == committed wasm:', onChain, '| dao + agent as expected');

// ---------------- the vault (key-held): holds the DAO-funded budget, signs swaps and payouts
const agentFull = accountFor(rpc, cfg.accounts.agent.accountId, cfg.accounts.agent.secretKey);
await (async () => {
  const id = `vault.${cfg.accounts.agent.accountId}`;
  if (!cfg.accounts.vault) { cfg.accounts.vault = acct(id, KeyPair.fromRandom('ed25519')); saveConfig(cfg); }
  if (await exists(id)) { console.log('exists ', id); return; }
  await agentFull.createAccount({ newAccountId: id, publicKey: KeyPair.fromString(cfg.accounts.vault.secretKey as any).getPublicKey(), nearToTransfer: NEAR('1.5') });
  console.log('created', id.padEnd(40), '1.5 NEAR'); await sleep(2500);
})();

// ---------------- Layer 0: the agent's function-call key (only these 5 methods on the mandate contract, no deposit)
const SCOPED_FILE = `data/secret/${TAG}-scoped-key.json`;
const METHODS = ['mark_funded', 'record_chunk', 'begin_settlement', 'complete', 'expire'];
let scoped = existsSync(SCOPED_FILE) ? JSON.parse(readFileSync(SCOPED_FILE, 'utf8')) : null;
if (!scoped || scoped.receiver !== cfg.mandate) {
  const kp = KeyPair.fromRandom('ed25519');
  scoped = { publicKey: kp.getPublicKey().toString(), secretKey: kp.toString(), receiver: cfg.mandate, addTx: '' };
  writeFileSync(SCOPED_FILE, JSON.stringify(scoped, null, 2));
  const r: any = await agentFull.addFunctionCallAccessKey({ publicKey: scoped.publicKey, contractId: cfg.mandate, methodNames: METHODS, allowance: NEAR(1) });
  scoped.addTx = r.transaction?.hash ?? r.transaction_outcome?.id ?? ''; writeFileSync(SCOPED_FILE, JSON.stringify(scoped, null, 2));
  console.log('added function-call key', scoped.publicKey, scoped.addTx); await sleep(4000);
}

// ---------------- public ids (safe to commit: no secrets)
const pub = {
  network: IS_MAINNET ? 'mainnet' : 'testnet', rpc, factory: P.factory, owner: ownerId, dao: cfg.dao, mandateContract: cfg.mandate,
  council: ['council1', 'council2', 'council3'].map((n) => cfg.accounts[n].accountId),
  agent: cfg.accounts.agent.accountId, treasurer: cfg.accounts.treasurer.accountId, contributor: cfg.accounts.contributor.accountId, feeRecipient: cfg.accounts.funder.accountId,
  vault: cfg.accounts.vault.accountId, dex: P.dex, poolIds: P.poolIds ?? null, wasmSha256Base58: localHash, codeHashOnChain: onChain,
  scopedKey: { publicKey: scoped.publicKey, methods: METHODS, addTx: scoped.addTx, explorer: scoped.addTx ? explorerTx(scoped.addTx) : null },
  setupTxs: { deploy: deployTx || null, init: initTx || null },
  explorer: { dao: explorerAccount(cfg.dao), mandate: explorerAccount(cfg.mandate), agent: explorerAccount(cfg.accounts.agent.accountId), vault: explorerAccount(cfg.accounts.vault.accountId) },
  note: 'Public ids only. The council members, payees and fee account are sub-accounts of the owner account: they are controlled by the authors, not by independent people.',
};
writeFileSync(PUBLIC_PATH, JSON.stringify(pub, null, 2));
console.log('\nwrote', PUBLIC_PATH);
console.log(`owner balance now ${nearOf(await bal(ownerId))} NEAR (was ${nearOf(have)})`);
console.log('NEXT: npx tsx --env-file=.env scripts/mainnet/e2e-mainnet.ts   (same ALLOW_MAINNET / QT_NET settings as this command)');
process.exit(0);
