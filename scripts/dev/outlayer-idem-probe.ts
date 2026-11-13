// OutLayer testnet probes (harmless calls). Usage: npx tsx scripts/dev/outlayer-idem-probe.ts [idem|denied]
//   idem   : what does OutLayer answer when the SAME X-Idempotency-Key is replayed on /wallet/v1/call?
//   denied : do a harmless call now and print the full policy_denied message, if any (e.g. rate limit)
import { randomUUID } from 'node:crypto';
import { OutLayerWallet } from '../../src/near/outlayer-policy.js';
import { loadConfig } from '../testnet/lib.js';
const c = loadConfig();
const w = new OutLayerWallet({ owner: { accountId: c.accounts.agent.accountId, secretKey: c.accounts.agent.secretKey }, seed: `quiet-treasury-custody-${c.suffix}` });
const me = (await w.address()).address;
const body = { receiver_id: 'wrap.testnet', method_name: 'ft_balance_of', args: { account_id: me }, gas: '10000000000000', deposit: '0' };
if ((process.argv[2] ?? 'idem') === 'denied') {
  console.log(JSON.stringify(await w.call(body).catch((e) => ({ err: String(e.message).slice(0, 400) }))));
} else {
  const key = randomUUID();
  const a = await w.call(body, key).catch((e) => ({ err: String(e.message).slice(0, 300) }));
  console.log('first :', JSON.stringify(a));
  console.log('replay:', JSON.stringify(await w.call(body, key).catch((e) => ({ err: String(e.message).slice(0, 300) }))));
}
process.exit(0);
