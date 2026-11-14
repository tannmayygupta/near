// INDEPENDENT, READ-ONLY verification of the deployed mandate contract (mainnet by default; QT_NET=testnet QT_TAG=rehearsal for the rehearsal).
// It needs no key and no ALLOW_MAINNET. It only reads public RPC and compares with the committed wasm and the public ids in data/<tag>-public.json.
// Run:  npm run mainnet:verify          Exit 0 only if every check holds on-chain.
import './profile.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { verifyContract } from '../../src/near/contract-verify.js';
import { codeHashOf } from '../../src/near/setup-plan.js';
import { PUBLIC_PATH, TAG } from '../testnet/lib.js';
import { chainReader } from './readers.js';
import { IS_MAINNET, P } from './net.js';

if (!existsSync(PUBLIC_PATH)) { console.error(`NOT VERIFIED: ${PUBLIC_PATH} does not exist, so no ${P.name} contract has been set up by this repository yet. Nothing to verify.`); process.exit(2); }
const pub = JSON.parse(readFileSync(PUBLIC_PATH, 'utf8').replace(/^﻿/, ''));
if (pub.network && pub.network !== (IS_MAINNET ? 'mainnet' : 'testnet')) { console.error(`NOT VERIFIED: ${PUBLIC_PATH} describes the ${pub.network} network but this command targets ${P.name}. Check QT_NET.`); process.exit(2); }
const wasm = readFileSync('contracts/mandate/out/mandate.wasm');
const localHash = codeHashOf(wasm);
const net = IS_MAINNET ? 'mainnet' : 'testnet';
const r = await verifyContract(chainReader(P.rpc), { network: net, contract: pub.mandateContract, dao: pub.dao, agent: pub.agent, localHash, scopedKey: pub.scopedKey ? { publicKey: pub.scopedKey.publicKey, methods: pub.scopedKey.methods } : undefined });

console.log(`VERIFY ${net.toUpperCase()}  contract ${pub.mandateContract}\n`);
for (const c of r.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.detail}`);
const ok = r.checks.length > 0 && r.checks.every((c) => c.ok);
console.log(`\nExplorer: ${r.explorer}\nDeploy+init transaction (from the public file): ${pub.setupTxs?.deploy ?? '(not recorded)'}`);
console.log(`RESULT: ${ok ? 'VERIFIED' : 'NOT VERIFIED'}  (${r.checks.filter((c) => c.ok).length}/${r.checks.length} checks, read from ${P.rpc})`);
const out = `data/${TAG}-verify.json`;
writeFileSync(out, JSON.stringify({ network: net, verifiedAt: new Date().toISOString(), rpc: P.rpc, contract: pub.mandateContract, explorer: r.explorer, onChainCodeHash: r.onChainHash, committedWasmCodeHash: localHash, wasmBytes: wasm.length, deployTx: pub.setupTxs?.deploy ?? null, result: ok ? 'VERIFIED' : 'NOT VERIFIED', checks: r.checks }, null, 2));
console.log(`wrote ${out}`);
process.exitCode = ok ? 0 : 1; // let the event loop drain (process.exit() right after fetch() trips a libuv assertion on Windows)
