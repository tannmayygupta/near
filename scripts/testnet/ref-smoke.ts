// Live smoke test of the REAL Ref adapter on public testnet: quote -> real swap (0.02 NEAR) -> real USDT.e payout -> real native return.
import './profile.js';
import { RefTestnetAdapter, WRAP, isTxHash } from '../../worker/adapters/ref-testnet.js';
import { ensureVault, mainnetRefPrice, VAULT_RESERVE } from './vault.js';
import { explorerTx, A } from './lib.js';
import { NEAR } from '../../src/near/chain.js';

const { c, vault, accountId } = await ensureVault();
const refPrice = await mainnetRefPrice();
console.log('vault', accountId, '| mainnet reference price (1Click, read-only):', refPrice);
const ad = new RefTestnetAdapter({ vault, rpc: c.rpc, reserveYocto: VAULT_RESERVE, ledgerPath: 'data/secret/ref-ledger-smoke.json', refPrice: mainnetRefPrice, log: (k, f) => console.log('  ', k, JSON.stringify(f)) });
const SELL = 'nep141:wrap.testnet', BUY = 'nep141:usdt.fakes.testnet';

console.log('budget balance before:', await ad.confidentialBalance(SELL));
const q = await ad.confidentialSwapQuote({ token_in: SELL, token_out: BUY, amount_in: NEAR('0.02').toString() });
console.log('quote 0.02 NEAR ->', q);
const snap = await ad.poolSnapshot(SELL, BUY, NEAR('0.02'));
console.log('pool snapshot', snap);
const r = await ad.confidentialSwap({ token_in: SELL, token_out: BUY, amount_in: NEAR('0.02').toString(), min_amount_out: '1' }, `smoke:${Date.now()}`);
const rec = await ad.waitForRequest(r.request_id);
console.log('swap request', r.request_id, 'is tx hash:', isTxHash(r.request_id), explorerTx(r.request_id));
console.log('record', JSON.stringify(rec).slice(0, 400));
const out = BigInt((rec.result as any).amount_out);
const to = c.accounts.contributor.accountId;
const w = await ad.confidentialWithdraw({ chain: 'near', to, amount: (out / 2n).toString(), token: BUY }, `smoke-pay:${Date.now()}`);
console.log('payout tx', explorerTx(w.request_id));
const nat = await ad.confidentialWithdraw({ chain: 'near', to: A(c, 'council1').accountId, amount: NEAR('0.01').toString(), token: WRAP }, `smoke-ret:${Date.now()}`);
console.log('native return tx', explorerTx(nat.request_id));
console.log('budget balance after:', await ad.confidentialBalance(SELL), '| usdt in vault:', await ad.confidentialBalance(BUY));
