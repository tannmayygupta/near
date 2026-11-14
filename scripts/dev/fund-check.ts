// Shows the NEAR balance of every testnet account the end-to-end runs depend on and (with --top-up) tops the low ones up from idle accounts.
// Usage: npx tsx scripts/dev/fund-check.ts [--top-up]
import { providerFor, NEAR } from '../../src/near/chain.js';
import { A, loadConfig, sleep } from '../testnet/lib.js';
const c = loadConfig(); const topUp = process.argv.includes('--top-up');
const bal = async (id: string) => BigInt((await providerFor(c.rpc).viewAccount({ accountId: id })).amount);
const fmt = (y: bigint) => (Number(y / 10n ** 20n) / 1e4).toFixed(3);
const need: Record<string, bigint> = { council1: NEAR(4), council2: NEAR(3), council3: NEAR(3), agent: NEAR(2), contributor: NEAR(2), funder: NEAR(0.5) as bigint };
const donors = ['treasurer', 'bob', 'mandate', 'council3', 'council2'];
for (const [k, min] of Object.entries(need)) {
  const id = c.accounts[k].accountId; let b = await bal(id);
  console.log(k.padEnd(12), id.padEnd(30), fmt(b), 'NEAR', b < min ? `(LOW, want >= ${fmt(min)})` : 'ok');
  if (topUp && b < min) {
    for (const d of donors) { if (d === k) continue; const db = await bal(c.accounts[d].accountId); const give = min - b + NEAR(1); if (db > give + NEAR(3)) { await A(c, d).transfer({ receiverId: id, amount: give }); await sleep(2500); console.log('   topped up from', d, fmt(give)); b = await bal(id); break; } }
  }
}
process.exit(0);
