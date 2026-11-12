// Feasibility probe: is there real DEX liquidity on NEAR TESTNET (Ref Finance) for a REAL swap?
import { view, RPC } from '../../src/near/chain.js';
const rpc = RPC.testnet;
const tryView = async (id: string, m: string, a: object = {}) => { try { return await view<any>(rpc, id, m, a); } catch (e: any) { return `ERR ${String(e.message).slice(0, 90)}`; } };

for (const dex of ['ref-finance-101.testnet', 'v2.ref-labs.testnet', 'v2.ref-finance.testnet']) {
  const n = await tryView(dex, 'get_number_of_pools');
  console.log(dex, 'pools:', n);
  if (typeof n === 'number' && n > 0) {
    const pools = await tryView(dex, 'get_pools', { from_index: Math.max(0, n - 300), limit: 300 });
    if (Array.isArray(pools)) {
      const rel = pools.map((p: any, i: number) => ({ i: Math.max(0, n - 300) + i, t: p.token_account_ids, a: p.amounts, k: p.pool_kind })).filter((p: any) => p.t.includes('wrap.testnet'));
      console.log(' wNEAR pools:', rel.length);
      for (const p of rel.slice(0, 10)) console.log('  ', p.i, p.t.join('/'), p.a.join(','), p.k);
    } else console.log(' get_pools:', pools);
  }
}
for (const t of ['wrap.testnet', 'usdc.fakes.testnet', 'usdc.testnet', 'usdt.fakes.testnet']) {
  const m = await tryView(t, 'ft_metadata');
  console.log(t, typeof m === 'string' ? m : `${m.symbol} decimals ${m.decimals}`);
}
