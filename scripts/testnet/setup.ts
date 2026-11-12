// Creates (idempotently) on PUBLIC NEAR TESTNET: a real Sputnik DAO v2 (council = 3 accounts) + the mandate contract.
// Secrets -> data/secret/testnet-config.json (git-ignored). Public ids -> data/testnet-public.json (committed).
// Run: npx tsx scripts/testnet/setup.ts
import { KeyPair } from 'near-api-js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { RPC, accountFor, providerFor, view, b64, TGAS, NEAR } from '../../src/near/chain.js';
import { Acct, TestnetConfig, hasConfig, loadConfig, saveConfig, helperCreate, explorerAccount, PUBLIC_PATH, sleep } from './lib.js';

const FACTORY = 'sputnikv2.testnet';
const rpc = RPC.testnet;

async function exists(id: string): Promise<boolean> {
  try { await providerFor(rpc).viewAccount({ accountId: id }); return true; } catch { return false; }
}

let cfg: TestnetConfig;
if (hasConfig()) cfg = loadConfig();
else {
  const suffix = String(Math.floor(Math.random() * 90000 + 10000));
  const named = JSON.parse(readFileSync('data/secret/testnet-named.json', 'utf8').replace(/^﻿/, ''));
  const accounts: Record<string, Acct> = {
    council1: named.council1, council2: named.council2, council3: named.council3, agent: named.agentowner, contributor: named.contributor,
  };
  for (const k of Object.keys(accounts)) accounts[k] = { accountId: accounts[k].accountId, publicKey: accounts[k].publicKey, secretKey: accounts[k].secretKey };
  cfg = { rpc, factory: FACTORY, dao: `quietdao-${suffix}.${FACTORY}`, mandate: `qtmandate-${suffix}.testnet`, suffix, accounts };
  saveConfig(cfg);
}
const have = async (k: string, id: string) => {
  if (cfg.accounts[k]) return;
  cfg.accounts[k] = await helperCreate(id, KeyPair.fromRandom('ed25519'));
  saveConfig(cfg); console.log('created', id);
};
await have('funder', `qtfund-${cfg.suffix}.testnet`);
await have('treasurer', `qttreasurer-${cfg.suffix}.testnet`);
if (!cfg.accounts.mandate) {
  cfg.accounts.mandate = await helperCreate(cfg.mandate, KeyPair.fromRandom('ed25519'));
  saveConfig(cfg); console.log('created', cfg.mandate);
}

// --- DAO via the real testnet factory
console.log('factory default code hash:', await view<string>(rpc, FACTORY, 'get_default_code_hash'));
if (!(await exists(cfg.dao))) {
  const council = ['council1', 'council2', 'council3'].map((n) => cfg.accounts[n].accountId);
  const args = { config: { name: cfg.dao.split('.')[0], purpose: 'Quiet Treasury demo DAO (testnet)', metadata: '' }, policy: council };
  const funder = accountFor(rpc, cfg.accounts.funder.accountId, cfg.accounts.funder.secretKey);
  let deposit = 6;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await funder.callFunction({ contractId: FACTORY, methodName: 'create', args: { name: args.config.name, args: b64(args) }, gas: TGAS(150), deposit: NEAR(deposit) });
      break;
    } catch (e: any) {
      const m = String(e.message ?? e); const need = m.match(/(\d+(?:\.\d+)?)\s*NEAR/i);
      console.log('create DAO failed:', m.slice(0, 200));
      if (need && Number(need[1]) > deposit && Number(need[1]) < 9) deposit = Math.ceil(Number(need[1]) + 0.1); else throw e;
    }
  }
  await sleep(2000);
}
console.log('DAO', cfg.dao, 'exists:', await exists(cfg.dao));
const policy: any = await view(rpc, cfg.dao, 'get_policy');
console.log('policy roles:', (policy.roles ?? []).map((r: any) => r.name).join(','), 'bond:', policy.proposal_bond);

// --- mandate contract
const mAcc = accountFor(rpc, cfg.accounts.mandate.accountId, cfg.accounts.mandate.secretKey);
let initialised = false;
try { await view(rpc, cfg.mandate, 'get_config'); initialised = true; } catch { /* not deployed or not initialised */ }
if (!initialised) {
  await mAcc.deployContract(readFileSync('contracts/mandate/out/mandate.wasm'));
  await mAcc.callFunction({ contractId: cfg.mandate, methodName: 'new', args: { dao: cfg.dao, agent: cfg.accounts.agent.accountId }, gas: TGAS(30) });
}
const [dao, agent, next] = await view<[string, string, number]>(rpc, cfg.mandate, 'get_config');
console.log('mandate contract', cfg.mandate, 'dao', dao, 'agent', agent, 'next id', next);

const pub = {
  network: 'testnet', rpc, factory: FACTORY, dao: cfg.dao, mandateContract: cfg.mandate,
  council: ['council1', 'council2', 'council3'].map((n) => cfg.accounts[n].accountId),
  agent: cfg.accounts.agent.accountId, treasurer: cfg.accounts.treasurer.accountId, contributor: cfg.accounts.contributor.accountId,
  explorer: { dao: explorerAccount(cfg.dao), mandate: explorerAccount(cfg.mandate), agent: explorerAccount(cfg.accounts.agent.accountId) },
  note: 'Public testnet ids only. Demo council members are accounts controlled by the authors (not real people).',
};
writeFileSync(PUBLIC_PATH, JSON.stringify(pub, null, 2));
console.log('wrote', PUBLIC_PATH, '|', existsSync('data/secret/testnet-config.json') ? 'secret config saved' : '');
