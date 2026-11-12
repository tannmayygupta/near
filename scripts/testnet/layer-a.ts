// Gate G13 on OutLayer TESTNET: set a REAL wallet policy programmatically, then show REAL policy_denied (403) from OutLayer.
// Native NEAR transfers are used for the probes (confidential/swap endpoints are mainnet-only) but they go through the SAME policy engine.
// Run: npx tsx scripts/testnet/layer-a.ts      -> writes data/testnet-layer-a.json (public evidence, no secrets)
import { writeFileSync } from 'node:fs';
import { NEAR, TGAS } from '../../src/near/chain.js';
import { OutLayerWallet, layerAVerdict, PolicyApiError } from '../../src/near/outlayer-policy.js';
import { A, loadConfig, explorerTx, explorerAccount, sleep } from './lib.js';

const c = loadConfig();
const owner = { accountId: c.accounts.agent.accountId, secretKey: c.accounts.agent.secretKey };
const ownerAcc = A(c, 'agent');
const wallet = new OutLayerWallet({ owner, seed: `quiet-treasury-${c.suffix}` });
const ALLOWED = c.accounts.contributor.accountId; // the only address the policy lists
const evidence: Record<string, unknown> = { network: 'testnet', outlayerApi: wallet.api, contract: wallet.contract, owner: owner.accountId, allowedDestination: ALLOWED };

const addr = await wallet.address();
console.log('wallet', addr.wallet_id, 'address', addr.address);
evidence.wallet = { id: addr.wallet_id, address: addr.address, explorer: explorerAccount(addr.address) };

// fund the wallet's implicit account with testnet NEAR so it has something to protect
const bal0 = await wallet.balance().catch(() => ({ balance: '0' }));
if (BigInt(bal0.balance) < NEAR(1)) { await ownerAcc.transfer({ receiverId: addr.address, amount: NEAR(2) }); await sleep(2500); }
console.log('wallet balance (yocto):', (await wallet.balance()).balance);

// the policy: only transfers, only to ALLOWED, <= 0.1 NEAR per transaction, 20 operations per hour
const policy = {
  rules: {
    transaction_types: ['transfer'],
    allowed_tokens: ['*'],
    addresses: { mode: 'whitelist', list: [ALLOWED] },
    limits: { per_transaction: { native: NEAR('0.1').toString() } },
    rate_limit: { max_per_hour: 20 },
  },
};
const stored = await wallet.setPolicy(ownerAcc, policy, addr.wallet_id);
console.log('policy stored on-chain, tx', explorerTx(stored.txHash));
evidence.policy = { rules: policy.rules, storeTx: stored.txHash, explorer: explorerTx(stored.txHash), note: 'rules shown here are the plaintext we submitted; on-chain they are stored ENCRYPTED' };
await sleep(5000);

type Probe = { name: string; to: string; amount: string; expect: 'allow' | 'deny' };
const probes: Probe[] = [
  { name: 'small transfer to the listed address (must be allowed)', to: ALLOWED, amount: NEAR('0.01').toString(), expect: 'allow' },
  { name: 'transfer to an UNLISTED address (must be denied)', to: 'attacker-unlisted.testnet', amount: NEAR('0.01').toString(), expect: 'deny' },
  { name: 'transfer above the 0.1 NEAR cap to the listed address (must be denied)', to: ALLOWED, amount: NEAR('0.5').toString(), expect: 'deny' },
];
const out: any[] = []; let ok = true;
for (const p of probes) {
  try {
    const r = await wallet.transfer({ to: p.to, amount: p.amount });
    const pass = p.expect === 'allow';
    ok &&= pass; out.push({ ...p, result: 'allowed', status: r.status ?? 'ok', response: JSON.stringify(r).slice(0, 200) });
    console.log(pass ? 'PASS' : 'FAIL', p.name, '->', 'allowed', JSON.stringify(r).slice(0, 120));
  } catch (e) {
    const v = layerAVerdict(e); const pass = p.expect === 'deny' && v.blocked;
    ok &&= pass; out.push({ ...p, result: 'denied', ...v });
    console.log(pass ? 'PASS' : 'FAIL', p.name, '->', v.status, v.error.slice(0, 160));
  }
}
evidence.probes = out; evidence.allPassed = ok; evidence.at = new Date().toISOString();
writeFileSync('data/testnet-layer-a.json', JSON.stringify(evidence, null, 2));
console.log(ok ? 'G13 PASS: OutLayer wallet policy set programmatically and enforced (real 403 policy_denied).' : 'G13 FAILED (see output)');
process.exit(ok ? 0 : 1);
void TGAS; void PolicyApiError;
