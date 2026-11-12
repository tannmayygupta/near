// Probe Ref Finance testnet API shapes before wiring the adapter.
import { view, RPC } from '../../src/near/chain.js';
const rpc = RPC.testnet, dex = 'ref-finance-101.testnet';
const t = async (id: string, m: string, a: object = {}) => { try { return await view<any>(rpc, id, m, a); } catch (e: any) { return `ERR ${String(e.message).slice(0, 120)}`; } };
console.log('bounds', await t(dex, 'storage_balance_bounds'));
console.log('pool57', await t(dex, 'get_pool', { pool_id: 57 }));
console.log('return 0.05 NEAR', await t(dex, 'get_return', { pool_id: 57, token_in: 'wrap.testnet', amount_in: '50000000000000000000000', token_out: 'usdt.fakes.testnet' }));
console.log('return 0.5 NEAR', await t(dex, 'get_return', { pool_id: 57, token_in: 'wrap.testnet', amount_in: '500000000000000000000000', token_out: 'usdt.fakes.testnet' }));
console.log('wrap bounds', await t('wrap.testnet', 'storage_balance_bounds'));
console.log('usdt bounds', await t('usdt.fakes.testnet', 'storage_balance_bounds'));
console.log('version', await t(dex, 'version'));
console.log('metadata', await t(dex, 'metadata'));
