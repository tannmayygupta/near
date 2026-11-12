// Real testnet write to FastData KV (social.testnet) from a demo council account; then wait for the indexer.
import { readFileSync } from 'node:fs';
import { RPC, accountFor } from '../../src/near/chain.js';
import { senderFor, writeKv, postArgs, postId, waitIndexed } from '../../src/near/social.js';

const named = JSON.parse(readFileSync('data/secret/testnet-named.json', 'utf8').replace(/^﻿/, ''));
const acc = accountFor(RPC.testnet, named.council1.accountId, named.council1.secretKey);
const id = String(Date.now());
const w = await writeKv('testnet', senderFor(acc), postArgs(id, 'Quiet Treasury probe: hello from a demo council account on NEAR testnet #nearhackathon'));
console.log('tx', w.txHash, w.explorer);
const e = await waitIndexed('testnet', named.council1.accountId, `post/${id}`, { tries: 15, delayMs: 2000 });
console.log('indexed:', e ? JSON.stringify(e).slice(0, 300) : 'NOT FOUND in FastData after 30s');
