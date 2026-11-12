// The REAL-execution vault: a named testnet sub-account of the agent that holds the DAO-funded budget and signs Ref swaps/payouts.
// Keys live in data/secret/testnet-vault.json (git-ignored). Public id is added to data/testnet-public.json by e2e-real.
import { KeyPair } from 'near-api-js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { accountFor, NEAR } from '../../src/near/chain.js';
import { loadConfig, A } from './lib.js';
import { dryQuote } from '../../src/near/intents.js';
import { MAINNET_TOKENS } from '../../src/engine/schema.js';

export const VAULT_PATH = 'data/secret/testnet-vault.json';
export const VAULT_RESERVE = NEAR('2'); // the vault's initial gas/storage float; the adapter adds back what it spends, so only DAO-funded NEAR counts as budget
const VAULT_FUNDING = NEAR('2');

export async function ensureVault() {
  const c = loadConfig();
  if (existsSync(VAULT_PATH)) {
    const v = JSON.parse(readFileSync(VAULT_PATH, 'utf8'));
    return { c, vault: accountFor(c.rpc, v.accountId, v.secretKey), accountId: v.accountId as string, secretKey: v.secretKey as string };
  }
  const kp = KeyPair.fromRandom('ed25519');
  const agent = A(c, 'agent');
  const accountId = `vault.${agent.accountId}`;
  await agent.createAccount({ newAccountId: accountId, publicKey: kp.getPublicKey(), nearToTransfer: VAULT_FUNDING });
  mkdirSync('data/secret', { recursive: true });
  writeFileSync(VAULT_PATH, JSON.stringify({ accountId, publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() }, null, 2));
  return { c, vault: accountFor(c.rpc, accountId, kp.toString()), accountId, secretKey: kp.toString() };
}

/** Price of 1 wNEAR in USDC from a MAINNET read-only 1Click dry quote (only used to reject absurd test pools). */
export async function mainnetRefPrice(): Promise<number | null> {
  try {
    const recipient = JSON.parse(readFileSync('data/testnet-layer-a.json', 'utf8').replace(/^﻿/, '')).wallet.address as string;
    const [w, u] = Object.keys(MAINNET_TOKENS);
    const q = await dryQuote({ originAsset: w, destinationAsset: u, amount: (10n ** 23n).toString(), recipient, refundTo: recipient });
    return (Number(BigInt(q.amountOut)) / 1e6) / 0.1;
  } catch { return null; }
}
