// One-shot / repeatable near.social publish for ALL existing mandates (same SocialPublisher the worker uses; idempotent via data/social.sqlite).
// Run: npx tsx --env-file=.env scripts/testnet/social-publish.ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { RPC, accountFor, providerFor } from '../../src/near/chain.js';
import * as mc from '../../src/near/mandate.js';
import { senderFor, readKv, SOCIAL, REPUTATION_NS } from '../../src/near/social.js';
import { SocialPublisher, nearblocksAnchorFinder } from '../../worker/social-publisher.js';

const pub = JSON.parse(readFileSync('data/testnet-public.json', 'utf8'));
const named = JSON.parse(readFileSync('data/secret/testnet-named.json', 'utf8').replace(/^﻿/, ''));
const rpc = RPC.testnet;
const agent = accountFor(rpc, named.agentowner.accountId, named.agentowner.secretKey);
const prov = providerFor(rpc);
const db = new DatabaseSync('data/social.sqlite');

const p = new SocialPublisher({
  net: 'testnet', account: agent.accountId, dao: pub.dao, contract: pub.mandateContract,
  chain: { listMandates: () => mc.listMandates(rpc, pub.mandateContract, 0, 200), getTrust: (t) => mc.getTrust(rpc, pub.mandateContract, t) },
  send: senderFor(agent), db, log: (k, f) => console.log(k, JSON.stringify(f)),
  explorerAccount: (a) => `https://explorer.testnet.near.org/accounts/${a}`,
  findAnchorTx: nearblocksAnchorFinder({
    api: 'https://api-testnet.nearblocks.io', rpc, contract: pub.mandateContract,
    decode: async (h, signer) => { const o: any = await prov.viewTransactionStatus({ txHash: h, accountId: signer, waitUntil: 'EXECUTED' } as any); const fc = o.transaction?.actions?.[0]?.FunctionCall; return fc ? { args: JSON.parse(Buffer.from(fc.args, 'base64').toString()) } : null; },
  }),
});

const n = await p.tick();
console.log('published', n, 'new item(s)');

const rows = p.records();
const file = 'data/testnet-social.json';
const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const ex = (h: string) => `https://explorer.testnet.near.org/transactions/${h}`;
const entries = await readKv('testnet', agent.accountId, '').catch(() => []);
writeFileSync(file, JSON.stringify({
  ...prev, network: 'testnet', publisher: agent.accountId, socialReceiver: SOCIAL.testnet.receiver, reputationNamespace: REPUTATION_NS,
  readUrl: `${SOCIAL.testnet.kv}/v0/latest/${SOCIAL.testnet.receiver}/${agent.accountId}`,
  posts: rows.map((r) => ({ key: r.key, kvTx: r.kv_tx, explorer: ex(r.kv_tx), ts: r.ts, detail: JSON.parse(r.detail) })),
  fastdataKeys: entries.map((e) => e.key),
}, null, 2));
console.log('FastData keys for', agent.accountId + ':', entries.map((e) => e.key).join(', '));
console.log('saved', file);
