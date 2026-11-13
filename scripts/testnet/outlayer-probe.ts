// PROBE 2 (exploratory): Ref swap through the OutLayer custody wallet + does the policy meter token transfers (ft_transfer args)?
// Run: npx tsx scripts/testnet/outlayer-probe.ts [policyMode]   (testnet only)
import { NEAR, TGAS, view } from '../../src/near/chain.js';
import { OutLayerWallet } from '../../src/near/outlayer-policy.js';
import { A, loadConfig, sleep } from './lib.js';

const c = loadConfig();
const owner = { accountId: c.accounts.agent.accountId, secretKey: c.accounts.agent.secretKey };
const w = new OutLayerWallet({ owner, seed: `quiet-treasury-custody-${c.suffix}` });
const addr = await w.address(); const me = addr.address;
const WRAP = 'wrap.testnet', REF = 'ref-finance-101.testnet', USDT = 'usdt.fakes.testnet';
const ALICE = c.accounts.contributor.accountId;
const show = (label: string, p: Promise<any>) => p.then((r) => { console.log('OK  ', label, JSON.stringify(r).slice(0, 300)); return r; }, (e) => { console.log('ERR ', label, (e as Error).message.slice(0, 330)); return null; });
const ft = (t: string, a = me) => view<string>(c.rpc, t, 'ft_balance_of', { account_id: a }).catch(() => '0');

const mode = process.argv[2] ?? 'swap';
if (mode === 'swap') {
  await show('ref storage_deposit', w.call({ receiver_id: REF, method_name: 'storage_deposit', args: { account_id: me, registration_only: false }, gas: TGAS(30).toString(), deposit: NEAR('0.01').toString() }));
  await show('ref register_tokens', w.call({ receiver_id: REF, method_name: 'register_tokens', args: { token_ids: [WRAP, USDT] }, gas: TGAS(30).toString(), deposit: '1' }));
  // find a sane pool: the one the recorded run used
  const run = JSON.parse((await import('node:fs')).readFileSync('data/demo-run/run.json', 'utf8'));
  const pool = run.real.pool.before.poolId; console.log('pool', pool);
  const amountIn = NEAR('0.1').toString();
  const out = await view<string>(c.rpc, REF, 'get_return', { pool_id: pool, token_in: WRAP, amount_in: amountIn, token_out: USDT });
  console.log('quote out', out);
  const msg = JSON.stringify({ force: 0, actions: [{ pool_id: pool, token_in: WRAP, token_out: USDT, amount_in: amountIn, min_amount_out: '0' }] });
  const r = await show('ft_transfer_call wNEAR -> Ref (swap)', w.call({ receiver_id: WRAP, method_name: 'ft_transfer_call', args: { receiver_id: REF, amount: amountIn, msg }, gas: TGAS(180).toString(), deposit: '1' }));
  await sleep(4000);
  console.log('USDT.e bal', await ft(USDT), 'wNEAR bal', await ft(WRAP), 'ref deposit usdt', await view<string>(c.rpc, REF, 'get_deposit', { account_id: me, token_id: USDT }).catch(() => 'n/a'));
  void r;
} else if (mode === 'ft') {
  // does POST /wallet/v1/transfer accept a `token` (FT) and apply the policy (recipient whitelist + per-token cap) to it?
  const tr = (to: string, amount: string, extra: object = { token: USDT }) => (w as any).req('POST', '/wallet/v1/transfer', { chain: 'near', to, amount, ...extra });
  await show('transfer token=USDT.e 100 to alice (whitelisted, below cap) -> expect ok', tr(ALICE, '100'));
  await show('transfer token=USDT.e 5000 to alice (above per-token cap 1000) -> expect denied', tr(ALICE, '5000'));
  await show('transfer token=USDT.e 100 to UNLISTED registered treasurer -> expect denied', tr(c.accounts.treasurer.accountId, '100'));
  console.log('USDT.e bal', await ft(USDT));
} else if (mode === 'policyC') {
  // token budgets: daily + hourly keyed by token contract id; transfers use /transfer with token (the path that enforces the recipient whitelist)
  const key = process.argv[3] ?? USDT;
  const policy = { rules: { transaction_types: ['call', 'transfer'], allowed_tokens: ['*'], addresses: { mode: 'whitelist', list: [WRAP, REF, USDT, ALICE] }, limits: { per_transaction: { native: NEAR('1.5').toString() }, daily: { [key]: '3000' } }, rate_limit: { max_per_hour: 200 } } };
  try { const s = await w.setPolicy(A(c, 'agent'), policy, addr.wallet_id); console.log('policy C stored', s.txHash); } catch (e) { console.log('setPolicy ERR', (e as Error).message); }
  await sleep(6000);
  const tr = (to: string, amount: string) => (w as any).req('POST', '/wallet/v1/transfer', { chain: 'near', to, amount, token: USDT });
  await show('transfer USDT.e 2000 to alice (daily budget 3000) -> ok', tr(ALICE, '2000'));
  await show('transfer USDT.e 2000 to alice (cumulative 4000 > 3000) -> denied if metered', tr(ALICE, '2000'));
} else {
  // policy B: token-aware limits. Does an ft_transfer to an UNLISTED recipient / above a per-token cap get blocked?
  const cap = process.argv[3] ?? '1000';
  const policy = { rules: { transaction_types: ['call', 'transfer'], allowed_tokens: ['*'], addresses: { mode: 'whitelist', list: [WRAP, REF, USDT, ALICE] }, limits: { per_transaction: { native: NEAR('1.5').toString(), [USDT]: cap } }, rate_limit: { max_per_hour: 200 } } };
  try { const s = await w.setPolicy(A(c, 'agent'), policy, addr.wallet_id); console.log('policy B stored', s.txHash); } catch (e) { console.log('setPolicy ERR', (e as Error).message); }
  await sleep(6000);
  console.log('USDT.e bal', await ft(USDT));
  await show(`ft_transfer USDT.e 100 to alice (below cap ${cap}) -> expect ok`, w.call({ receiver_id: USDT, method_name: 'ft_transfer', args: { receiver_id: ALICE, amount: '100' }, gas: TGAS(30).toString(), deposit: '1' }));
  await show(`ft_transfer USDT.e 5000 to alice (above cap ${cap}) -> denied if metered`, w.call({ receiver_id: USDT, method_name: 'ft_transfer', args: { receiver_id: ALICE, amount: '5000' }, gas: TGAS(30).toString(), deposit: '1' }));
  await show('ft_transfer USDT.e 100 to UNLISTED registered account', w.call({ receiver_id: USDT, method_name: 'ft_transfer', args: { receiver_id: c.accounts.treasurer.accountId, amount: '100' }, gas: TGAS(30).toString(), deposit: '1' }));
}
process.exit(0);
