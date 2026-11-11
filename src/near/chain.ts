// Thin NEAR chain helpers shared by scripts, worker and tests. Network = RPC url; no network-specific code elsewhere.
import { Account, JsonRpcProvider, KeyPairSigner } from 'near-api-js';

export const RPC = {
  sandbox: process.env.SANDBOX_RPC ?? 'http://localhost:3030',
  mainnet: process.env.NEAR_MAINNET_RPC ?? 'https://rpc.mainnet.fastnear.com',
  testnet: process.env.NEAR_TESTNET_RPC ?? 'https://rpc.testnet.near.org',
} as const;
export type Net = keyof typeof RPC;

export const providerFor = (url: string) => new JsonRpcProvider({ url });

export function accountFor(rpcUrl: string, accountId: string, secretKey: string): Account {
  return new Account(accountId, providerFor(rpcUrl), KeyPairSigner.fromSecretKey(secretKey));
}

/** Read-only contract view (no signer needed). */
export async function view<T = unknown>(rpcUrl: string, contractId: string, method: string, args: object = {}): Promise<T> {
  return (await providerFor(rpcUrl).callFunction({ contractId, method, args })) as T;
}

export const b64 = (o: unknown) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64');
export const TGAS = (n: number) => BigInt(n) * 10n ** 12n;
export const NEAR = (n: number | string) => {
  const [i, f = ''] = String(n).split('.');
  return BigInt(i) * 10n ** 24n + BigInt((f + '0'.repeat(24)).slice(0, 24));
};
