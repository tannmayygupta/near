// Shared helpers for the PUBLIC TESTNET scripts. Secrets live in data/secret (git-ignored); public ids in data/testnet-public.json.
import { KeyPair } from 'near-api-js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { RPC, accountFor, callTx, TGAS } from '../../src/near/chain.js';
import { addProposal, getProposal } from '../../src/near/sputnik.js';

export const HELPER = 'https://helper.nearprotocol.com/account';
export const CONFIG_PATH = 'data/secret/testnet-config.json';
export const PUBLIC_PATH = 'data/testnet-public.json';
export const explorerAccount = (id: string) => `https://explorer.testnet.near.org/accounts/${id}`;
export const explorerTx = (h: string) => `https://explorer.testnet.near.org/transactions/${h}`;

export interface Acct { accountId: string; publicKey: string; secretKey: string }
export interface TestnetConfig {
  rpc: string; factory: string; dao: string; mandate: string; suffix: string;
  accounts: Record<string, Acct>;
}
export const loadConfig = (): TestnetConfig => JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
export const hasConfig = () => existsSync(CONFIG_PATH);
export function saveConfig(c: TestnetConfig) { mkdirSync('data/secret', { recursive: true }); writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }
export const A = (c: TestnetConfig, n: string) => accountFor(c.rpc, c.accounts[n].accountId, c.accounts[n].secretKey);

/** Free public-testnet account (10 NEAR) via NEAR's helper. */
export async function helperCreate(accountId: string, kp: KeyPair): Promise<Acct> {
  const r = await fetch(HELPER, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: kp.getPublicKey().toString() }) });
  if (!r.ok) throw new Error(`helper create ${accountId} failed: ${r.status} ${(await r.text()).slice(0, 160)}`);
  return { accountId, publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Collected on-chain evidence for the recorded run. */
export interface TxRef { label: string; txHash: string; explorer: string }
export const txs: TxRef[] = [];
export const rec = (label: string, txHash: string): string => { if (txHash) txs.push({ label, txHash, explorer: explorerTx(txHash) }); return txHash; };

/** add_proposal + return tx hash and proposal id */
export async function proposeTx(c: TestnetConfig, who: string, description: string, kind: object, label: string): Promise<number> {
  const acc = A(c, who);
  const id = await addProposal(c.rpc, acc, c.dao, description, kind);
  // addProposal does not return the hash; recover the proposal's creation via last id (hash recorded through a tiny re-read is not possible) -> use callTx path instead
  return id;
}

/** Vote with tx hash capture. Sputnik echoes the proposal kind. */
export async function voteTx(c: TestnetConfig, who: string, id: number, action: 'VoteApprove' | 'VoteReject', label: string): Promise<void> {
  const p = await getProposal(c.rpc, c.dao, id);
  const { txHash } = await callTx(A(c, who), c.dao, 'act_proposal', { id, action, proposal: p.kind }, TGAS(150));
  rec(label, txHash);
}

/** add_proposal with tx hash capture (reads the DAO policy for the bond). */
export async function proposeWithHash(c: TestnetConfig, who: string, description: string, kind: object, label: string): Promise<number> {
  const policy: any = await (await import('../../src/near/sputnik.js')).getPolicy(c.rpc, c.dao);
  const { value, txHash } = await callTx(A(c, who), c.dao, 'add_proposal', { proposal: { description, kind } }, TGAS(30), BigInt(policy.proposal_bond ?? '0'));
  rec(label, txHash);
  return Number(value);
}

export const RPC_TESTNET = RPC.testnet;
