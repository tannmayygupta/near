// PROTOCOL-LEVEL KEY SCOPING (Layer 0): the key the worker uses to drive the mandate contract is a NEAR function-call access key limited to
//   receiver = the mandate contract, methods = mark_funded, record_chunk, begin_settlement, complete, expire, allowance 2 NEAR, no deposit.
// The NEAR protocol itself then refuses everything else BEFORE any contract code runs. This script adds the key (once) and proves the refusals live.
// Run: npx tsx scripts/testnet/scoped-key.ts    -> data/testnet-scoped-key.json (public) + data/secret/agent-scoped-key.json (secret)
import { KeyPair } from 'near-api-js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { accountFor, NEAR, TGAS } from '../../src/near/chain.js';
import { A, loadConfig, explorerTx, sleep } from './lib.js';

export const SCOPED_PATH = 'data/secret/agent-scoped-key.json';
export const SCOPED_METHODS = ['mark_funded', 'record_chunk', 'begin_settlement', 'complete', 'expire'];
export const scopedAgent = (c: ReturnType<typeof loadConfig>) => {
  const k = JSON.parse(readFileSync(SCOPED_PATH, 'utf8'));
  return accountFor(c.rpc, c.accounts.agent.accountId, k.secretKey);
};

if (process.argv[1]?.replaceAll('\\', '/').endsWith('scripts/testnet/scoped-key.ts')) {
  const c = loadConfig();
  const owner = A(c, 'agent');
  let addTx = '';
  let secret: string, pubkey: string;
  if (existsSync(SCOPED_PATH)) { const k = JSON.parse(readFileSync(SCOPED_PATH, 'utf8')); secret = k.secretKey; pubkey = k.publicKey; addTx = k.addTx ?? ''; console.log('reusing scoped key', pubkey); }
  else {
    const kp = KeyPair.fromRandom('ed25519'); secret = kp.toString(); pubkey = kp.getPublicKey().toString();
    const r: any = await owner.addFunctionCallAccessKey({ publicKey: pubkey, contractId: c.mandate, methodNames: SCOPED_METHODS, allowance: NEAR(2) });
    addTx = r.transaction?.hash ?? r.transaction_outcome?.id ?? '';
    mkdirSync('data/secret', { recursive: true }); writeFileSync(SCOPED_PATH, JSON.stringify({ publicKey: pubkey, secretKey: secret, addTx }, null, 2));
    console.log('added function-call key', pubkey, explorerTx(addTx)); await sleep(4000);
  }
  const scoped = accountFor(c.rpc, c.accounts.agent.accountId, secret);
  const PROTOCOL = /MethodNameMismatch|ReceiverMismatch|RequiresFullAccess|DepositWithFunctionCall|does not allow|does not match transaction receiver|requires full access|Deposit is not allowed|AccessKeyNotFound|InvalidAccessKey/i;
  type Probe = { name: string; expect: 'protocol-refusal' | 'reaches-contract'; layer: string; result: string; ok: boolean; detail: string };
  const probes: Probe[] = [];
  const run = async (name: string, expect: Probe['expect'], fn: () => Promise<unknown>) => {
    let msg = '', ok = false, result = '';
    try { await fn(); result = 'allowed'; msg = 'call succeeded'; ok = false; }
    catch (e: any) {
      msg = String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 300) + (e?.type ? ` [${e.type}]` : '');
      const protocol = PROTOCOL.test(msg) || PROTOCOL.test(JSON.stringify(e?.kind ?? e?.cause ?? '').slice(0, 400));
      result = protocol ? 'refused by the NEAR protocol' : 'reached the contract, contract rejected';
      ok = expect === 'protocol-refusal' ? protocol : !protocol;
    }
    probes.push({ name, expect, layer: expect === 'protocol-refusal' ? '0 (NEAR protocol)' : 'B (contract)', result, ok, detail: msg });
    console.log(ok ? 'PASS' : 'FAIL', name, '->', result, '|', msg.slice(0, 140));
  };
  const call = (receiver: string, method: string, args: object = {}, deposit = 0n) => scoped.callFunction({ contractId: receiver, methodName: method, args, gas: TGAS(30), deposit });
  await run('allowed method on the mandate contract (record_chunk on an unknown mandate): the protocol lets it through, the contract rejects the bad id', 'reaches-contract', () => call(c.mandate, 'record_chunk', { id: 999999, index: 0, sold_amount: '1' }));
  await run('DAO-only method create_mandate with the agent key', 'protocol-refusal', () => call(c.mandate, 'create_mandate', { treasurer: c.accounts.agent.accountId, terms_hash: 'b'.repeat(64), terms_json: null, sell_token: 'nep141:wrap.testnet', max_sell: '1', start_ns: 1, end_ns: 2, tier: 'small' }));
  await run('DAO-only method set_agent (hand the agent role to someone else) with the agent key', 'protocol-refusal', () => call(c.mandate, 'set_agent', { agent: c.accounts.bob.accountId }));
  await run('call a DIFFERENT contract (wrap.testnet near_deposit)', 'protocol-refusal', () => call('wrap.testnet', 'near_deposit', {}));
  await run('native NEAR transfer to another account', 'protocol-refusal', () => scoped.transfer({ receiverId: c.accounts.bob.accountId, amount: NEAR('0.01') }));
  await run('allowed method with an attached deposit', 'protocol-refusal', () => call(c.mandate, 'record_chunk', { id: 999999, index: 0, sold_amount: '1' }, 1n));
  const allOk = probes.every((p) => p.ok);
  const out = {
    network: 'testnet', recordedAt: new Date().toISOString(), account: c.accounts.agent.accountId, mandateContract: c.mandate,
    key: { publicKey: pubkey, kind: 'function-call access key', receiver: c.mandate, methods: SCOPED_METHODS, allowanceNear: '2', addTx, explorer: addTx ? explorerTx(addTx) : null },
    note: 'The worker signs its mandate-contract calls with this key. The NEAR protocol refuses everything outside receiver/methods/no-deposit before contract code runs. The key CANNOT write OutLayer wallet policies (that needs a deposit): the policy owner is a separate full-access credential.',
    probes, allPassed: allOk,
  };
  writeFileSync('data/testnet-scoped-key.json', JSON.stringify(out, null, 2));
  console.log(allOk ? 'SCOPED KEY: all probes behaved as expected' : 'SCOPED KEY: UNEXPECTED RESULTS (see output)');
  process.exit(allOk ? 0 : 1);
}
