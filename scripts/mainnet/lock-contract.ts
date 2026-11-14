// LOCK THE MANDATE CONTRACT: delete every full-access key of the contract account. IRREVERSIBLE.
// Afterwards nobody (not even the authors) can upgrade the code, change the state outside its own methods, or move the ~4 NEAR of storage balance.
// What it proves: the code that runs is the committed wasm (hash checked before locking) and it can never be swapped. What it costs: the account can never be fixed.
// Run only after scripts/mainnet/e2e-mainnet.ts passed:
//   $env:ALLOW_MAINNET='1'; $env:LOCK_CONFIRM='I-UNDERSTAND-THIS-IS-IRREVERSIBLE'; npx tsx --env-file=.env scripts/mainnet/lock-contract.ts     (rehearsal: $env:QT_NET='testnet')
import './profile.js';
import { baseEncode, KeyPair } from 'near-api-js';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { accountFor, providerFor, view } from '../../src/near/chain.js';
import { loadConfig, explorerAccount, explorerTx, TAG, sleep } from '../testnet/lib.js';
import { P, IS_MAINNET, requireMainnetConsent } from './net.js';

requireMainnetConsent('permanently lock the mandate contract');
if (process.env.LOCK_CONFIRM !== 'I-UNDERSTAND-THIS-IS-IRREVERSIBLE') { console.error('REFUSING: set LOCK_CONFIRM=I-UNDERSTAND-THIS-IS-IRREVERSIBLE (this deletes every key of the contract account for good).'); process.exit(2); }
const c = loadConfig(), prov = providerFor(c.rpc);
const wasm = readFileSync('contracts/mandate/out/mandate.wasm');
const localHash = baseEncode(createHash('sha256').update(wasm).digest());
const info: any = await prov.viewAccount({ accountId: c.mandate });
if ((info.codeHash ?? info.code_hash) !== localHash) { console.error('STOP: the code on chain is not the committed wasm; not locking'); process.exit(1); }
const stats: any = await view(c.rpc, c.mandate, 'get_stats');
if (stats.version !== 2 || stats.dao !== c.dao) { console.error('STOP: contract state is not as expected; not locking'); process.exit(1); }
const list: any = await prov.query({ request_type: 'view_access_key_list', finality: 'final', account_id: c.mandate } as any);
const full = (list.keys as any[]).filter((k) => k.access_key.permission === 'FullAccess');
console.log(`${c.mandate}: ${list.keys.length} key(s), ${full.length} full-access`);
const acc = accountFor(c.rpc, c.mandate, c.accounts.mandate.secretKey);
const txsOut: Array<{ publicKey: string; tx: string }> = [];
// delete every key except the one we sign with, that one last
const mine = KeyPair.fromString(c.accounts.mandate.secretKey as any).getPublicKey().toString();
const order = [...full.filter((k) => k.public_key !== mine), ...full.filter((k) => k.public_key === mine)];
for (const k of order) {
  const r: any = await acc.deleteKey(k.public_key);
  const tx = r.transaction?.hash ?? r.transaction_outcome?.id ?? ''; txsOut.push({ publicKey: k.public_key, tx }); console.log('deleted full-access key', k.public_key, explorerTx(tx)); await sleep(3000);
}
const after: any = await prov.query({ request_type: 'view_access_key_list', finality: 'final', account_id: c.mandate } as any);
const stillFull = (after.keys as any[]).filter((k) => k.access_key.permission === 'FullAccess').length;
const stats2: any = await view(c.rpc, c.mandate, 'get_stats');
const out = { network: P.name, recordedAt: new Date().toISOString(), contract: c.mandate, codeHash: localHash, deletedKeys: txsOut.map((x) => ({ ...x, explorer: explorerTx(x.tx) })), keysAfter: after.keys.length, fullAccessKeysAfter: stillFull, stillWorks: stats2.version === 2, explorer: explorerAccount(c.mandate),
  note: 'All full-access keys of the contract account were deleted: the code can no longer be upgraded. Verify with view_access_key_list (it is empty).' };
const file = IS_MAINNET ? 'data/demo-run/mainnet-lock.json' : `data/secret/${TAG}-lock.json`;
writeFileSync(file, JSON.stringify(out, null, 2)); if (IS_MAINNET) copyFileSync(file, 'app/public/demo-run/mainnet-lock.json');
console.log(stillFull === 0 ? 'LOCKED: no full-access key left; views still work' : 'NOT LOCKED: a full-access key remains');
process.exit(stillFull === 0 && stats2.version === 2 ? 0 : 1);
