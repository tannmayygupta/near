// Ref Finance TESTNET pools are open to anyone and drift (a thin pool's price can be pushed 8x away from the real market).
// The adapter's sanity band rightly rejects such a pool, so before a recorded run we can restore it by selling wNEAR into it from the key-held vault.
// Usage: npx tsx scripts/dev/ref-rebalance.ts [poolId=57] [targetUsdtPerNear=4.5]      (testnet play money only)
import { NEAR, TGAS, view } from '../../src/near/chain.js';
import { ensureVault } from '../testnet/vault.js';

const pool = Number(process.argv[2] ?? 57), target = Number(process.argv[3] ?? 4.5);
const WRAP = 'wrap.testnet', USDT = 'usdt.fakes.testnet', REF = 'ref-finance-101.testnet';
const { c, vault, accountId } = await ensureVault();
const p: any = await view(c.rpc, REF, 'get_pool', { pool_id: pool });
const iw = p.token_account_ids.indexOf(WRAP);
const w = Number(BigInt(p.amounts[iw]) / 10n ** 18n) / 1e6, u = Number(BigInt(p.amounts[1 - iw]) / 10n ** 3n) / 1e3;
console.log(`pool ${pool}: wNEAR=${w} USDT.e=${u} price=${(u / w).toFixed(3)} USDT.e/NEAR`);
if (u / w <= target * 1.2 && u / w >= target / 1.25) { console.log('already near target; nothing to do'); process.exit(0); }
const k = w * u, xTarget = Math.sqrt(k / target), sell = xTarget - w;
if (sell <= 0) { // price is BELOW target: sell USDT.e into the pool (buy wNEAR) from the vault's USDT.e until the price is back
  const yTarget = Math.sqrt(k * target), sellU = yTarget - u;
  const have = BigInt(await view<string>(c.rpc, USDT, 'ft_balance_of', { account_id: accountId }));
  const amtU = BigInt(Math.floor(sellU * 1e6));
  console.log(`price below target: selling ${sellU.toFixed(3)} USDT.e into the pool (vault has ${Number(have) / 1e6})`);
  if (have < amtU) { console.log('vault has too little USDT.e'); process.exit(1); }
  const m2 = JSON.stringify({ force: 0, actions: [{ pool_id: pool, token_in: USDT, token_out: WRAP, amount_in: amtU.toString(), min_amount_out: '0' }] });
  await vault.callFunctionRaw({ contractId: USDT, methodName: 'ft_transfer_call', args: { receiver_id: REF, amount: amtU.toString(), msg: m2 }, gas: TGAS(180), deposit: 1n });
  const q2: any = await view(c.rpc, REF, 'get_pool', { pool_id: pool });
  const w3 = Number(BigInt(q2.amounts[iw]) / 10n ** 18n) / 1e6, u3 = Number(BigInt(q2.amounts[1 - iw]) / 10n ** 3n) / 1e3;
  console.log(`pool ${pool} now: wNEAR=${w3} USDT.e=${u3} price=${(u3 / w3).toFixed(3)}`);
  const { resetVaultFloat } = await import('../testnet/vault.js'); await resetVaultFloat(vault, c.rpc); // unwrap the wNEAR it bought so the vault float stays clean
  process.exit(0);
}
const amountIn = NEAR(sell.toFixed(4));
console.log(`selling ${sell.toFixed(4)} wNEAR into the pool from ${accountId}`);
const nat = BigInt((await (await import('../../src/near/chain.js')).providerFor(c.rpc).viewAccount({ accountId: vault.accountId })).amount);
if (nat < amountIn + NEAR('0.3')) { console.log('vault has too little NEAR', nat.toString()); process.exit(1); }
await vault.callFunctionRaw({ contractId: WRAP, methodName: 'near_deposit', args: {}, gas: TGAS(30), deposit: amountIn });
const msg = JSON.stringify({ force: 0, actions: [{ pool_id: pool, token_in: WRAP, token_out: USDT, amount_in: amountIn.toString(), min_amount_out: '0' }] });
await vault.callFunctionRaw({ contractId: WRAP, methodName: 'ft_transfer_call', args: { receiver_id: REF, amount: amountIn.toString(), msg }, gas: TGAS(180), deposit: 1n });
const q: any = await view(c.rpc, REF, 'get_pool', { pool_id: pool });
const w2 = Number(BigInt(q.amounts[iw]) / 10n ** 18n) / 1e6, u2 = Number(BigInt(q.amounts[1 - iw]) / 10n ** 3n) / 1e3;
console.log(`pool ${pool} now: wNEAR=${w2} USDT.e=${u2} price=${(u2 / w2).toFixed(3)}`);
process.exit(0);
