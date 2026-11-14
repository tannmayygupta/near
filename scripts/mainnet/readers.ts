// Read-only chain access for preflight / verify / test-contract. No signer is ever created here.
import { providerFor } from '../../src/near/chain.js';
import type { ChainReader } from '../../src/near/contract-verify.js';

const notFound = (e: unknown) => /does not exist|UNKNOWN_ACCOUNT|UnknownAccount|UNKNOWN_ACCESS_KEY|does not exist while viewing/i.test(String((e as Error)?.message ?? e) + JSON.stringify((e as any)?.type ?? '') + JSON.stringify((e as any)?.cause ?? ''));

export function chainReader(rpc: string) {
  const prov = providerFor(rpc);
  const reader: ChainReader & {
    viewAccountFull(id: string): Promise<{ amount: bigint; codeHash: string } | null>;
    accessKey(id: string, publicKey: string): Promise<{ permission: unknown } | null>;
  } = {
    async chainId() { return String(await prov.getNetworkId()); }, // "mainnet" / "testnet", read from the RPC node itself
    async viewAccount(id) { return reader.viewAccountFull(id); },
    async viewAccountFull(id) {
      try { const a: any = await prov.viewAccount({ accountId: id }); return { amount: BigInt(a.amount), codeHash: a.codeHash ?? a.code_hash ?? '' }; }
      catch (e) { if (notFound(e)) return null; throw e; }
    },
    async view(contract, method, args = {}) { return prov.callFunction({ contractId: contract, method, args: args as Record<string, unknown> }); },
    async accessKeys(id) {
      const l: any = await prov.viewAccessKeyList({ accountId: id });
      return (l.keys ?? []).map((k: any) => ({ publicKey: k.publicKey ?? k.public_key, permission: (k.accessKey ?? k.access_key)?.permission }));
    },
    async accessKey(id, publicKey) {
      try { const k: any = await prov.viewAccessKey({ accountId: id, publicKey }); return { permission: k.permission }; }
      catch (e) { if (notFound(e)) return null; throw e; }
    },
  };
  return reader;
}
