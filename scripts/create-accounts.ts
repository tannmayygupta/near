// Generates demo accounts (ed25519 implicit accounts) for TESTNET rehearsal and tries to fund them from the public faucet.
// Keys are written to data/secret/testnet-accounts.json (git-ignored). Never commit or paste them.
import { KeyPair } from 'near-api-js';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

const OUT = 'data/secret/testnet-accounts.json';
const NAMES = ['council1', 'council2', 'council3', 'agentowner', 'contributor'];

type Rec = { accountId: string; publicKey: string; secretKey: string };
mkdirSync('data/secret', { recursive: true });
const book: Record<string, Rec> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};

for (const n of NAMES) {
  if (book[n]) continue;
  const kp = KeyPair.fromRandom('ed25519');
  const pk = kp.getPublicKey();
  const raw = Buffer.from(pk.data);
  book[n] = { accountId: raw.toString('hex'), publicKey: pk.toString(), secretKey: kp.toString() };
}
writeFileSync(OUT, JSON.stringify(book, null, 2));
for (const [n, r] of Object.entries(book)) console.log(n, r.accountId);

async function rpcBalance(id: string): Promise<string> {
  const r = await fetch('https://rpc.testnet.near.org', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: id } }),
  });
  const j: any = await r.json();
  return j.result?.amount ? (BigInt(j.result.amount) / 10n ** 21n).toString() + ' milliNEAR' : 'not created';
}

const target = book['council1'].accountId;
const attempts: Array<[string, any]> = [
  ['https://near-faucet.io/api/faucet/tokens', { account: target, amount: '10', token: 'NEAR' }],
  ['https://near-faucet.io/api/faucet', { account: target, amount: '10', token: 'NEAR' }],
  ['https://near-faucet.io/api/request', { account: target, amount: '10' }],
];
for (const [url, body] of attempts) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    console.log('faucet try', url, r.status, (await r.text()).slice(0, 160).replace(/\s+/g, ' '));
  } catch (e: any) {
    console.log('faucet try', url, 'ERR', e.message);
  }
}
console.log('balance council1:', await rpcBalance(target));
