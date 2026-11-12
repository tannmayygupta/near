// Find Ref Finance TESTNET pools pairing wrap.testnet with a USDC/USDT testnet token, with liquidity.
import { view, RPC } from '../../src/near/chain.js';
const dex = 'ref-finance-101.testnet';
const stable = new Set(['usdc.fakes.testnet', 'usdc.testnet', 'usdt.fakes.testnet', 'usdt.testnet', 'dai.fakes.testnet']);
const n: number = await view(RPC.testnet, dex, 'get_number_of_pools');
const hits: any[] = [];
for (let from = 0; from < n; from += 300) {
  const page: any[] = await view(RPC.testnet, dex, 'get_pools', { from_index: from, limit: 300 });
  page.forEach((p, i) => {
    const t: string[] = p.token_account_ids;
    if (t.includes('wrap.testnet') && t.some((x) => stable.has(x))) hits.push({ id: from + i, tokens: t, amounts: p.amounts, fee: p.total_fee, kind: p.pool_kind });
  });
}
console.log('pools total', n, 'wNEAR/stable pools:', hits.length);
for (const h of hits) {
  const w = BigInt(h.amounts[h.tokens.indexOf('wrap.testnet')]);
  const s = BigInt(h.amounts[1 - h.tokens.indexOf('wrap.testnet')]);
  console.log(`pool ${h.id} ${h.tokens.join('/')} wNEAR=${Number(w / 10n ** 21n) / 1000} stable=${Number(s / 10n ** 3n) / 1000} fee=${h.fee} ${h.kind}`);
}
