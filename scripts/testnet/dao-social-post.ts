// REAL governance-driven near.social post on PUBLIC testnet:
// a Sputnik FunctionCall proposal makes the DAO ACCOUNT ITSELF call `social.testnet.__fastdata_kv`; 2 of 3 council votes execute it.
// Note (expected, per the near.social standard): `social.testnet` has no contract, so the DAO's promise fails with CodeDoesNotExist and the
// proposal may end as "Failed" in Sputnik - the data still lands in FastData KV (the indexer ignores receipt status). We verify via FastData.
// Output: data/testnet-social.json (public, non-secret). Run: npx tsx --env-file=.env scripts/testnet/dao-social-post.ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { RPC, accountFor, callTx, TGAS } from '../../src/near/chain.js';
import * as sp from '../../src/near/sputnik.js';
import { SOCIAL, postArgs, postId, waitIndexed, readKv, nearSocialPostUrl } from '../../src/near/social.js';

const pub = JSON.parse(readFileSync('data/testnet-public.json', 'utf8'));
const named = JSON.parse(readFileSync('data/secret/testnet-named.json', 'utf8').replace(/^﻿/, ''));
const rpc = RPC.testnet;
const A = (k: string) => accountFor(rpc, named[k].accountId, named[k].secretKey);
const gasArg = process.env.SOCIAL_ACTION_GAS ?? '1';

const mandateNo = Number(process.env.MANDATE_ID ?? 5);
const id = String(1_700_000_000_000_000 + 7000 + mandateNo); // deterministic: the DAO announces mandate #n once
const text = [
  `#QuietTreasury - DAO ${pub.dao} announces (by council vote) that mandate #${mandateNo} was settled and its report hash is anchored on-chain.`,
  `Verify: contract ${pub.mandateContract} get_mandate ${mandateNo}. The agent can only act inside DAO-approved mandates. #NEARHackathon`,
].join('\n');
const args = postArgs(id, text);

const kind = sp.functionCallKind(SOCIAL.testnet.receiver, '__fastdata_kv', args, '0', gasArg);
const prior = await readKv('testnet', pub.dao, `post/${id}`).catch(() => []);
if (prior.length) { console.log('already posted by the DAO:', JSON.stringify(prior[0]).slice(0, 200)); process.exit(0); }

const policy = await sp.getPolicy(rpc, pub.dao);
const bond = BigInt(policy.proposal_bond ?? '0');
const c1 = A('council1');
const created = await callTx(c1, pub.dao, 'add_proposal', { proposal: { description: `Announce settled mandate #${mandateNo} on near.social (DAO-signed post)`, kind } }, TGAS(30), bond);
const pid = Number(created.value);
console.log('proposal', pid, 'created tx', created.txHash);

const votes: Array<{ by: string; tx: string }> = [];
for (const k of ['council1', 'council2']) {
  const p = await sp.getProposal(rpc, pub.dao, pid);
  if (p.status !== 'InProgress') break;
  const r = await callTx(A(k), pub.dao, 'act_proposal', { id: pid, action: 'VoteApprove', proposal: p.kind }, TGAS(150));
  votes.push({ by: named[k].accountId, tx: r.txHash });
  console.log('vote', named[k].accountId, r.txHash);
}
const fin = await sp.getProposal(rpc, pub.dao, pid);
console.log('proposal status:', fin.status, '(Failed is expected: social.testnet has no contract)');

const landed = await waitIndexed('testnet', pub.dao, `post/${id}`, { tries: 20, delayMs: 2000 });
console.log('DAO post indexed in FastData KV:', landed ? 'YES' : 'NO');
if (!landed) { console.error('post did not land; try SOCIAL_ACTION_GAS=5000000000000'); process.exit(1); }

const ex = (h: string) => `https://explorer.testnet.near.org/transactions/${h}`;
const out = {
  network: 'testnet', recordedAt: new Date().toISOString(), dao: pub.dao, socialReceiver: SOCIAL.testnet.receiver,
  proposal: { id: pid, status: fin.status, createdTx: created.txHash, createdExplorer: ex(created.txHash), votes: votes.map((v) => ({ ...v, explorer: ex(v.tx) })) },
  post: { key: `post/${id}`, predecessor: pub.dao, text, fastdata: landed, readUrl: `${SOCIAL.testnet.kv}/v0/latest/${SOCIAL.testnet.receiver}/${pub.dao}`, nearSocialUrl: nearSocialPostUrl(pub.dao, id) },
  note: 'Governance-driven near.social write: DAO account is the predecessor. Proposal status Failed is expected (receipt CodeDoesNotExist); evidence is the FastData entry.',
};
const file = 'data/testnet-social.json';
const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { posts: [] };
writeFileSync(file, JSON.stringify({ ...prev, daoPost: out, posts: prev.posts ?? [] }, null, 2));
console.log('saved', file);
