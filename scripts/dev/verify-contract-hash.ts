// Is the contract deployed on testnet EXACTLY the wasm committed in this repo? (the NEAR analogue of "verified contract")
// Run: npm run verify:contract      (needs network)
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { baseEncode } from 'near-api-js';
import { providerFor, RPC } from '../../src/near/chain.js';

const pub = JSON.parse(readFileSync('data/testnet-public.json', 'utf8').replace(/^﻿/, ''));
const wasm = readFileSync('contracts/mandate/out/mandate.wasm');
const local = baseEncode(createHash('sha256').update(wasm).digest());
const acc: any = await providerFor(pub.rpc ?? RPC.testnet).viewAccount({ accountId: pub.mandateContract });
const same = acc.codeHash === local || acc.code_hash === local;
console.log(JSON.stringify({ contract: pub.mandateContract, onChainCodeHash: acc.codeHash ?? acc.code_hash, committedWasmSha256Base58: local, wasmBytes: wasm.length, match: same }, null, 2));
process.exit(same ? 0 : 1);
