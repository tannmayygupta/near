// Sets up a LOCAL sandbox chain with a real Sputnik DAO v2 (code copied from mainnet factory) + council + agent accounts.
// Output: data/secret/sandbox-accounts.json (git-ignored). Idempotent enough for a fresh sandbox (restart container to reset).
import { KeyPair, actions } from 'near-api-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { RPC, accountFor, providerFor, b64, TGAS, NEAR } from '../../src/near/chain.js';

const root = JSON.parse(readFileSync('data/secret/sandbox-root.json', 'utf8').replace(/^﻿/, ''));
const rootAcc = accountFor(RPC.sandbox, root.account_id, root.secret_key);

mkdirSync('data/secret', { recursive: true });
mkdirSync('data/sandbox', { recursive: true });

// 1. real Sputnik factory code from mainnet (embeds the DAO contract as default code)
const code = await providerFor(RPC.mainnet).viewContractCode({ contractId: 'sputnik-dao.near' });
const wasm = Buffer.from(code.code_base64, 'base64');
writeFileSync('data/sandbox/sputnik-factory.wasm', wasm);
console.log('factory wasm bytes', wasm.length);

const accounts: Record<string, { accountId: string; secretKey: string; publicKey: string }> = {};
async function mk(prefix: string, near: number) {
  const kp = KeyPair.fromRandom('ed25519');
  const id = `${prefix}.${root.account_id}`;
  await rootAcc.createAccount({ newAccountId: id, publicKey: kp.getPublicKey(), nearToTransfer: NEAR(near) });
  accounts[prefix] = { accountId: id, secretKey: kp.toString(), publicKey: kp.getPublicKey().toString() };
  return accountFor(RPC.sandbox, id, kp.toString());
}

const factory = await mk('sputnik', 200);
await factory.deployContract(wasm);
await factory.callFunction({ contractId: factory.accountId, methodName: 'new', args: {}, gas: TGAS(100) });
console.log('factory ready', factory.accountId);

// the factory stores DAO code blobs by hash: copy the current default DAO code from the mainnet factory
const mainnet = providerFor(RPC.mainnet);
const defaultHash = (await mainnet.callFunction({ contractId: 'sputnik-dao.near', method: 'get_default_code_hash', args: {} })) as string;
const rawCode = await mainnet.callFunctionRaw({ contractId: 'sputnik-dao.near', method: 'get_code', args: { code_hash: defaultHash } });
let daoWasm = Buffer.from(rawCode.result as number[]);
if (daoWasm[0] === 0x22) daoWasm = Buffer.from(JSON.parse(daoWasm.toString('utf8')), 'base64'); // JSON base64 string
console.log('dao code hash', defaultHash, 'bytes', daoWasm.length, 'magic', daoWasm.subarray(1, 4).toString());
await factory.signAndSendTransaction({
  receiverId: factory.accountId,
  actions: [actions.functionCall('store', daoWasm, TGAS(100), NEAR(55))],
});
await factory.callFunction({ contractId: factory.accountId, methodName: 'set_default_code_hash', args: { code_hash: defaultHash }, gas: TGAS(30) });
console.log('default code hash set');

for (const n of ['council1', 'council2', 'council3', 'agent', 'treasurer', 'contributor']) await mk(n, 20);

const council = ['council1', 'council2', 'council3'].map((n) => accounts[n].accountId);
const args = { config: { name: 'quietdao', purpose: 'Quiet Treasury demo DAO', metadata: '' }, policy: council };
await rootAcc.callFunction({
  contractId: factory.accountId,
  methodName: 'create',
  args: { name: 'quietdao', args: b64(args) },
  gas: TGAS(150),
  deposit: NEAR(10),
});
const daoId = `quietdao.${factory.accountId}`;
console.log('DAO created', daoId);
const policy = await providerFor(RPC.sandbox).callFunction({ contractId: daoId, method: 'get_policy', args: {} });
console.log('policy roles:', JSON.stringify((policy as any).roles?.map((r: any) => r.name)));

writeFileSync('data/secret/sandbox-accounts.json', JSON.stringify({ rpc: RPC.sandbox, dao: daoId, factory: factory.accountId, accounts }, null, 2));
console.log('saved data/secret/sandbox-accounts.json');


