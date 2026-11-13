// OutLayer CUSTODY for the testnet execution path: the vault that holds the DAO-funded budget is an OutLayer agent wallet (key in OutLayer's TEE,
// every call policy-checked). The worker holds only the OWNER credential (the agent NEAR account) that may ask the wallet to act and may write its policy.
import { providerFor } from '../../src/near/chain.js';
import { OutLayerWallet } from '../../src/near/outlayer-policy.js';
import { OutLayerCustodySigner } from '../../worker/adapters/signers.js';
import { MandatePolicy } from '../../worker/adapters/mandate-policy.js';
import { REF_DEX } from '../../worker/adapters/ref-testnet.js';
import { A, loadConfig } from './lib.js';

export async function ensureCustody(opts: { policyPath?: string; log?: (k: string, f: Record<string, unknown>) => void } = {}) {
  const c = loadConfig();
  const owner = { accountId: c.accounts.agent.accountId, secretKey: c.accounts.agent.secretKey };
  const wallet = new OutLayerWallet({ owner, seed: `quiet-treasury-custody-${c.suffix}` });
  const addr = await wallet.address();
  const signer = new OutLayerCustodySigner(wallet, addr.address, c.rpc);
  const policy = new MandatePolicy({ wallet, owner: A(c, 'agent'), walletId: addr.wallet_id, dex: REF_DEX, path: opts.policyPath ?? 'data/secret/custody-policies.json', log: opts.log });
  const native = async () => BigInt((await providerFor(c.rpc).viewAccount({ accountId: addr.address })).amount);
  return { c, wallet, walletId: addr.wallet_id, address: addr.address, signer, policy, native };
}
