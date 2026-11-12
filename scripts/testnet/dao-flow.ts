// Gates G1/G2 on PUBLIC TESTNET: real Sputnik DAO votes drive the real mandate contract. Prints real tx hashes.
// Run: npx tsx scripts/testnet/dao-flow.ts
import { createHash } from 'node:crypto';
import { callTx, TGAS, view } from '../../src/near/chain.js';
import * as sp from '../../src/near/sputnik.js';
import * as mc from '../../src/near/mandate.js';
import { A, loadConfig, proposeWithHash, voteTx, rec, txs, explorerTx } from './lib.js';

const c = loadConfig();
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, note = '') => { results.push([name, ok, note]); console.log(ok ? 'PASS' : 'FAIL', name, note); };
const failsWith = async (fn: () => Promise<unknown>) => { try { await fn(); return null; } catch (e: any) { return String(e.message ?? e).replace(/\s+/g, ' ').slice(0, 140); } };

const [, , nextId] = await view<[string, string, number]>(c.rpc, c.mandate, 'get_config');
const now = Math.floor(Date.now() / 1000);
const terms = { demo: 'testnet-dao-flow', run: Date.now() };
const hash = createHash('sha256').update(JSON.stringify(terms)).digest('hex');
const args: mc.CreateArgs = { treasurer: c.accounts.treasurer.accountId, terms_hash: hash, terms_json: JSON.stringify(terms), sell_token: 'nep141:wrap.near', max_sell: '1000', start_ns: mc.nsFromSeconds(now - 5), end_ns: mc.nsFromSeconds(now + 3600), tier: 'small' };

const direct = await failsWith(() => A(c, 'council1').callFunction({ contractId: c.mandate, methodName: 'create_mandate', args, gas: TGAS(30) }));
check('G2 non-DAO create_mandate rejected on testnet', !!direct, direct ?? '');

const pid = await proposeWithHash(c, 'council1', `Create sell mandate #${nextId} (testnet flow)`, sp.functionCallKind(c.mandate, 'create_mandate', args), 'DAO proposal: create_mandate');
check('G1 proposal created on the real testnet DAO', pid >= 0, `proposal ${pid}`);
await voteTx(c, 'council1', pid, 'VoteApprove', 'vote 1/3 approve (council1)');
let p = await sp.getProposal(c.rpc, c.dao, pid);
check('1 of 3 votes does NOT execute', p.status === 'InProgress' && (await mc.getMandate(c.rpc, c.mandate, nextId)) === null, p.status);
await voteTx(c, 'council2', pid, 'VoteApprove', 'vote 2/3 approve (council2) -> executes');
p = await sp.getProposal(c.rpc, c.dao, pid);
let m = await mc.getMandate(c.rpc, c.mandate, nextId);
check('2 of 3 votes approve and execute -> mandate exists', p.status === 'Approved' && m?.status === 'Approved', `${p.status}/${m?.status}`);

const agent = A(c, 'agent');
rec('agent: mark_funded', (await callTx(agent, c.mandate, 'mark_funded', { id: nextId }, TGAS(30))).txHash);
rec('agent: record_chunk #0', (await callTx(agent, c.mandate, 'record_chunk', { id: nextId, index: 0, sold_amount: '400' }, TGAS(30))).txHash);
await callTx(agent, c.mandate, 'record_chunk', { id: nextId, index: 0, sold_amount: '400' }, TGAS(30)); // replay
m = await mc.getMandate(c.rpc, c.mandate, nextId);
check('record_chunk is idempotent on chain', m?.chunks === 1 && m?.sold === '400', `chunks=${m?.chunks} sold=${m?.sold}`);
const over = await failsWith(() => mc.recordChunk(agent, c.mandate, nextId, 1, '700'));
check('over-budget chunk rejected by the contract', !!over, over ?? '');

const cid = await proposeWithHash(c, 'council1', `Cancel mandate #${nextId} (testnet flow)`, sp.functionCallKind(c.mandate, 'cancel_mandate', { id: nextId }), 'DAO proposal: cancel_mandate');
await voteTx(c, 'council1', cid, 'VoteApprove', 'cancel vote 1/3'); await voteTx(c, 'council3', cid, 'VoteApprove', 'cancel vote 2/3 -> executes');
m = await mc.getMandate(c.rpc, c.mandate, nextId);
check('DAO cancel proposal executes', m?.status === 'Cancelled', m?.status);
const blocked = await failsWith(() => mc.recordChunk(agent, c.mandate, nextId, 1, '10'));
check('agent blocked after cancel', !!blocked, blocked ?? '');

console.log('\nOn-chain evidence (public testnet):');
for (const t of txs) console.log(' ', t.label.padEnd(44), explorerTx(t.txHash));
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
