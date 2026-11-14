// MAINNET PRE-FLIGHT. Completely read-only: it reads the chain, your environment's NAMES and shapes, files and git state. It never sends a transaction and never prints a key.
// Run:  npm run mainnet:preflight         (no ALLOW_MAINNET needed; nothing can move)
//       QT_NET=testnet npm run mainnet:preflight   (rehearsal network)
import './profile.js';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runPreflight, secretLike } from '../../src/near/preflight-checks.js';
import { codeHashOf, fromYocto, toYocto } from '../../src/near/setup-plan.js';
import { inspectSecretDir, isSyncedPath } from '../../src/near/secret-dir.js';
import { chainReader } from './readers.js';
import { IS_MAINNET, LIMITS, P } from './net.js';

const reader = chainReader(P.rpc);
const git = (args: string[]) => spawnSync('git', args, { encoding: 'utf8' });
const ignored = (p: string): boolean | null => { const r = git(['check-ignore', '-q', p]); return r.status === 0 ? true : r.status === 1 ? false : null; };
const sd = inspectSecretDir();
let writable: boolean | null = null;
{ let probe = resolve(sd.resolved); while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe); try { accessSync(probe, constants.W_OK); writable = true; } catch { writable = false; } }
const tracked = git(['ls-files']).stdout.split(/\r?\n/).filter(Boolean);
const wasmPath = 'contracts/mandate/out/mandate.wasm';
let envText = ''; try { envText = readFileSync('.env', 'utf8'); } catch { /* no .env */ }
let recorded: string | null = null; try { recorded = JSON.parse(readFileSync('data/testnet-deploy-v2.json', 'utf8').replace(/^﻿/, '')).localCodeHash ?? null; } catch { /* absent */ }

const { checks, estimate, wasm } = await runPreflight({
  env: process.env, net: IS_MAINNET ? 'mainnet' : 'testnet',
  chainId: () => reader.chainId(), viewAccount: (id) => reader.viewAccountFull(id), accessKey: (id, k) => reader.accessKey(id, k),
  readWasm: () => (existsSync(wasmPath) ? readFileSync(wasmPath) : null), recordedReleaseHash: () => recorded, codeHashOf,
  secretDir: sd, secretDirWritable: writable,
  git: { envIgnored: ignored('.env'), trackedSecretLike: secretLike(tracked), secretDirIgnored: sd.insideRepo ? ignored(`${sd.dir}/probe.json`) : null },
  envFileText: envText, envFileSynced: isSyncedPath(resolve('.env')).synced, setupMinimum: toYocto(LIMITS.setupNear),
});

console.log(`MAINNET PRE-FLIGHT  (network profile: ${P.name}, RPC ${P.rpc})\n`);
for (const c of checks) console.log(`${c.ok ? 'PASS' : c.level === 'fail' ? 'FAIL' : 'WARN'}  ${c.name}\n      ${c.detail}`);
if (estimate && wasm) {
  console.log(`\nESTIMATED FUNDING (recomputed from scripts/mainnet/setup.ts's own money plan, not from the docs)
  leaves the owner account : ${fromYocto(estimate.outflow)} NEAR  (sub-accounts ${fromYocto(estimate.subAccounts)} + DAO factory deposit ${fromYocto(estimate.daoDeposit)})
  of which locked as contract storage : ${fromYocto(estimate.contractStorage)} NEAR (${wasm.bytes} bytes x 1e19 yocto/byte), inside the 4.3 NEAR given to the contract account
  gas (upper estimate)     : ${fromYocto(estimate.gas)} NEAR  (the real burn is reported after the run)
  owner keeps              : ${fromYocto(toYocto(0.1))} NEAR for its own storage
  setup's own minimum      : ${LIMITS.setupNear} NEAR
  => owner needs           : ${fromYocto(estimate.required > toYocto(LIMITS.setupNear) ? estimate.required : toYocto(LIMITS.setupNear))} NEAR   (the vault's ${1.5} NEAR is paid by the agent account, not by the owner)`);
}
const hard = checks.filter((c) => !c.ok && c.level === 'fail'), soft = checks.filter((c) => !c.ok && c.level === 'warn');
console.log(`\nRESULT: ${hard.length ? 'NOT READY' : 'READY'}  (${checks.filter((c) => c.ok).length} passed, ${hard.length} blocking, ${soft.length} warnings)`);
if (hard.length) for (const c of hard) console.log(`  blocking: ${c.name}`);
else console.log(`\nThe deployment command (run it yourself, only after you approve the plan):\n  $env:ALLOW_MAINNET='1'; npm run mainnet:setup`);
process.exitCode = hard.length ? 1 : 0; // let the event loop drain: process.exit() right after fetch() triggers a libuv assertion on Windows and hides the real exit code
