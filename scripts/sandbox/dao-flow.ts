// Gate G1/G2 on the local sandbox: real Sputnik DAO votes drive the real mandate contract.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { KeyPair } from 'near-api-js';
import { RPC, accountFor, providerFor, TGAS, NEAR } from '../../src/near/chain.js';
import * as sp from '../../src/near/sputnik.js';
import * as mc from '../../src/near/mandate.js';

const cfg = JSON.parse(readFileSync('data/secret/sandbox-accounts.json', 'utf8'));
const A = (n: string) => accountFor(RPC.sandbox, cfg.accounts[n].accountId, cfg.accounts[n].secretKey);
const root = JSON.parse(readFileSync('data/secret/sandbox-root.json', 'utf8').replace(/^﻿/, ''));
const rootAcc = accountFor(RPC.sandbox, root.account_id, root.secret_key);
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, note = '') => { results.push([name, ok, note]); console.log(ok ? 'PASS' : 'FAIL', name, note); };

// deploy mandate contract
const mk = KeyPair.fromRandom('ed25519');
const MID = `mandate.${root.account_id}`;
await rootAcc.createAccount({ newAccountId: MID, publicKey: mk.getPublicKey(), nearToTransfer: NEAR(20) });
const mAcc = accountFor(RPC.sandbox, MID, mk.toString());
await mAcc.deployContract(readFileSync('contracts/mandate/out/mandate.wasm'));
await mAcc.callFunction({ contractId: MID, methodName: 'new', args: { dao: cfg.dao, agent: cfg.accounts.agent.accountId }, gas: TGAS(30) });
check('G0 contract deployed + initialised on chain', true, MID);

const now = Math.floor(Date.now() / 1000);
const terms = { demo: true, sell: 'wNEAR', max: '1000' };
const hash = createHash('sha256').update(JSON.stringify(terms)).digest('hex');
const createArgs: mc.CreateArgs = {
  treasurer: cfg.accounts.treasurer.accountId, terms_hash: hash, terms_json: JSON.stringify(terms),
  sell_token: 'nep141:wrap.near', max_sell: '1000', start_ns: mc.nsFromSeconds(now - 5), end_ns: mc.nsFromSeconds(now + 3600), tier: 'small',
};

// non-DAO caller must be rejected
let rejected = false;
try { await A('council1').callFunction({ contractId: MID, methodName: 'create_mandate', args: createArgs, gas: TGAS(30) }); } catch { rejected = true; }
check('G2 non-DAO create_mandate rejected', rejected);

// DAO proposal -> votes -> execution
const id = await sp.addProposal(RPC.sandbox, A('council1'), cfg.dao, 'Create sell mandate #0', sp.functionCallKind(MID, 'create_mandate', createArgs));
check('G1 proposal created via real Sputnik', id >= 0, `id=${id}`);
await sp.vote(RPC.sandbox, A('council1'), cfg.dao, id, 'VoteApprove');
let p = await sp.getProposal(RPC.sandbox, cfg.dao, id);
check('1 of 3 votes does NOT execute', p.status === 'InProgress' && (await mc.getMandate(RPC.sandbox, MID, 0)) === null, p.status);
await sp.vote(RPC.sandbox, A('council2'), cfg.dao, id, 'VoteApprove');
p = await sp.getProposal(RPC.sandbox, cfg.dao, id);
const m0 = await mc.getMandate(RPC.sandbox, MID, 0);
check('2 of 3 votes approve + execute -> mandate exists', p.status === 'Approved' && m0?.status === 'Approved', `${p.status}/${m0?.status}`);

// agent lifecycle
const agent = A('agent');
await mc.markFunded(agent, MID, 0);
await mc.recordChunk(agent, MID, 0, 0, '400');
await mc.recordChunk(agent, MID, 0, 0, '400'); // replay
let m = await mc.getMandate(RPC.sandbox, MID, 0);
check('record_chunk idempotent', m?.chunks === 1 && m?.sold === '400', `chunks=${m?.chunks} sold=${m?.sold}`);
let over = false; try { await mc.recordChunk(agent, MID, 0, 1, '700'); } catch { over = true; }
check('over-budget chunk rejected', over);

// DAO cancel via vote, agent then blocked
const cid = await sp.addProposal(RPC.sandbox, A('council1'), cfg.dao, 'Cancel mandate #0', sp.functionCallKind(MID, 'cancel_mandate', { id: 0 }));
await sp.vote(RPC.sandbox, A('council1'), cfg.dao, cid, 'VoteApprove'); await sp.vote(RPC.sandbox, A('council3'), cfg.dao, cid, 'VoteApprove');
m = await mc.getMandate(RPC.sandbox, MID, 0);
check('DAO cancel proposal executes', m?.status === 'Cancelled', m?.status);
let blocked = false; try { await mc.recordChunk(agent, MID, 0, 1, '10'); } catch { blocked = true; }
check('agent blocked after cancel', blocked);

const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

