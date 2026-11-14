// Deploys the v2 mandate contract (events, versioned state, pause, two-step DAO handover, typed views, NEP-330 metadata) to a FRESH testnet account,
// initialises it for the existing DAO and agent, and switches the repo's config to it. The v1 contract stays on chain untouched (its recorded runs are
// tagged `v1-recorded-runs` in git). Run: npx tsx scripts/testnet/deploy-v2.ts
import { KeyPair, baseEncode } from 'near-api-js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { accountFor, callTx, providerFor, TGAS, view } from '../../src/near/chain.js';
import { CONFIG_PATH, PUBLIC_PATH, explorerTx, explorerAccount, helperCreate, loadConfig, sleep } from './lib.js';

const c = loadConfig();
const wasm = readFileSync('contracts/mandate/out/mandate.wasm');
const localHash = baseEncode(createHash('sha256').update(wasm).digest());
const id = `qtmandate2-${c.suffix}.testnet`;
const KEYFILE = 'data/secret/testnet-mandate-v2.json';
const out: Record<string, unknown> = { network: 'testnet', recordedAt: new Date().toISOString(), contract: id, dao: c.dao, agent: c.accounts.agent.accountId, wasmBytes: wasm.length, localCodeHash: localHash };

let secret: string;
if (existsSync(KEYFILE)) { secret = JSON.parse(readFileSync(KEYFILE, 'utf8')).secretKey; console.log('reusing key for', id); }
else {
  const kp = KeyPair.fromRandom('ed25519'); await helperCreate(id, kp); secret = kp.toString();
  writeFileSync(KEYFILE, JSON.stringify({ accountId: id, publicKey: kp.getPublicKey().toString(), secretKey: secret }, null, 2));
  console.log('created', id); await sleep(4000);
}
const acc = accountFor(c.rpc, id, secret);
const prov = providerFor(c.rpc);
const have: any = await prov.viewAccount({ accountId: id });
if (have.codeHash && have.codeHash !== '11111111111111111111111111111111') console.log('already has code', have.codeHash);
else {
  const r: any = await acc.deployContract(wasm); out.deployTx = r.transaction?.hash ?? r.transaction_outcome?.id; console.log('deployed', explorerTx(String(out.deployTx))); await sleep(4000);
}
let version = 0; try { version = await view<number>(c.rpc, id, 'get_version'); } catch { /* not initialised yet */ }
if (version !== 2) {
  const { txHash } = await callTx(acc, id, 'new', { dao: c.dao, agent: c.accounts.agent.accountId }, TGAS(30)); out.initTx = txHash; console.log('initialised', explorerTx(txHash)); await sleep(4000);
}
const after: any = await prov.viewAccount({ accountId: id });
const stats: any = await view(c.rpc, id, 'get_stats');
const meta: any = await view(c.rpc, id, 'contract_source_metadata').catch(() => null);
out.onChainCodeHash = after.codeHash ?? after.code_hash; out.matchesLocalWasm = out.onChainCodeHash === localHash; out.stats = stats; out.sourceMetadata = meta; out.explorer = explorerAccount(id);
console.log(JSON.stringify({ codeHash: out.onChainCodeHash, match: out.matchesLocalWasm, version: stats.version, dao: stats.dao, agent: stats.agent, meta }, null, 2));
if (!out.matchesLocalWasm || stats.version !== 2 || stats.dao !== c.dao || stats.agent !== c.accounts.agent.accountId) { console.error('v2 deployment is NOT as expected'); process.exit(1); }

// switch the config over (keep the v1 ids for the record)
const cfgRaw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
if (cfgRaw.mandate !== id) { cfgRaw.mandateV1 = cfgRaw.mandate; cfgRaw.mandate = id; cfgRaw.accounts.mandatev2 = { accountId: id, publicKey: JSON.parse(readFileSync(KEYFILE, 'utf8')).publicKey, secretKey: secret }; writeFileSync(CONFIG_PATH, JSON.stringify(cfgRaw, null, 2)); }
const pub = JSON.parse(readFileSync(PUBLIC_PATH, 'utf8').replace(/^﻿/, ''));
if (pub.mandateContract !== id) { pub.mandateContractV1 = pub.mandateContract; pub.mandateContract = id; if (pub.explorer) pub.explorer.mandate = `https://explorer.testnet.near.org/accounts/${id}`; writeFileSync(PUBLIC_PATH, JSON.stringify(pub, null, 2)); }
writeFileSync('data/testnet-deploy-v2.json', JSON.stringify(out, null, 2));
console.log('config switched to', id, '(v1:', cfgRaw.mandateV1 ?? pub.mandateContractV1, ')');
process.exit(0);
