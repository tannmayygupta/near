// Print the actions of testnet transactions: npx tsx scripts/dev/tx-inspect.ts <signerAccountId> <txHash> [<txHash>...]
import { providerFor, RPC } from '../../src/near/chain.js';
const [signer, ...hashes] = process.argv.slice(2);
for (const h of hashes) {
  try {
    const o: any = await providerFor(RPC.testnet).viewTransactionStatus({ txHash: h, accountId: signer, waitUntil: 'FINAL' } as any);
    const t = o.transaction;
    console.log(h, '->', t.receiver_id, JSON.stringify(t.actions).slice(0, 230));
  } catch (e) { console.log(h, 'ERR', (e as Error).message.slice(0, 100)); }
}
process.exit(0);
