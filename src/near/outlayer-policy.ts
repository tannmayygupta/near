// OutLayer wallet POLICY management (gate G13): the owner (a NEAR account we hold a key for) sets a wallet policy PROGRAMMATICALLY:
//   1. auth with a NEAR-signature bearer token (raw ed25519 over "auth:<seed>:<ts>")   2. POST /wallet/v1/encrypt-policy
//   3. POST /wallet/v1/sign-policy   4. owner signs `store_wallet_policy` on the OutLayer contract (outlayer.testnet / outlayer.near).
// Flow taken from OutLayer's own e2e script (github.com/out-layer/outlayer tests/wallet_policy_mode_e2e.sh) and docs (skills.outlayer.ai/agent-custody).
import { KeyPair, baseEncode } from 'near-api-js';
import type { Account } from 'near-api-js';
import { callTx, TGAS, view } from './chain.js';

export const OUTLAYER_TESTNET = { api: 'https://testnet-api.outlayer.ai', contract: 'outlayer.testnet' } as const;

export interface Owner { accountId: string; secretKey: string }
export class PolicyApiError extends Error {
  constructor(public status: number, public body: unknown, msg: string) { super(msg); this.name = 'PolicyApiError'; }
}

/** Bearer token for NEAR-signature auth. The signed window is ~30 s, so mint a fresh one per request. */
export function nearAuthToken(owner: Owner, seed: string, nowS = Math.floor(Date.now() / 1000)): string {
  const kp = KeyPair.fromString(owner.secretKey as any);
  const message = `auth:${seed}:${nowS}`;
  const sig = kp.sign(new TextEncoder().encode(message)).signature;
  const payload = { account_id: owner.accountId, seed, pubkey: kp.getPublicKey().toString(), timestamp: nowS, signature: baseEncode(sig) };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export class OutLayerWallet {
  constructor(private o: { api?: string; contract?: string; owner: Owner; seed: string }) {}
  get api() { return this.o.api ?? OUTLAYER_TESTNET.api; }
  get contract() { return this.o.contract ?? OUTLAYER_TESTNET.contract; }

  private async req(method: 'GET' | 'POST', path: string, body?: unknown, idem?: string): Promise<any> {
    const r = await fetch(`${this.api}${path}`, {
      method,
      headers: { authorization: `Bearer near:${nearAuthToken(this.o.owner, this.o.seed)}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(idem ? { 'x-idempotency-key': idem } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text(); let j: any; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 300) }; }
    if (!r.ok) throw new PolicyApiError(r.status, j, `${method} ${path} -> ${r.status} ${JSON.stringify(j).slice(0, 220)}`);
    return j;
  }

  /** Deterministic wallet for (owner account, seed); created on first use. */
  address(chain = 'near'): Promise<{ wallet_id: string; address: string; public_key: string }> { return this.req('GET', `/wallet/v1/address?chain=${chain}`); }
  balance(chain = 'near'): Promise<{ balance: string }> { return this.req('GET', `/wallet/v1/balance?chain=${chain}`); }
  /** NATIVE NEAR only. (A `token` field is silently ignored by OutLayer and the amount is sent as yoctoNEAR: verified on testnet 2026-11-13. Send tokens with `call` + ft_transfer.) */
  transfer(b: { chain?: string; to: string; amount: string }, idem?: string): Promise<any> { return this.req('POST', '/wallet/v1/transfer', { chain: 'near', ...b }, idem); }
  /** Generic contract call signed by the OutLayer TEE wallet (POST /wallet/v1/call). Gas is yoctoGas as a string, deposit yoctoNEAR as a string. */
  call(b: { receiver_id: string; method_name: string; args?: object; gas?: string; deposit?: string }, idem?: string): Promise<{ request_id: string; status: string; tx_hash?: string; result?: unknown; [k: string]: unknown }> {
    return this.req('POST', '/wallet/v1/call', { args: {}, gas: '30000000000000', deposit: '0', ...b }, idem);
  }
  /** NEP-145 storage registration paid by the wallet (POST /wallet/v1/storage-deposit); idempotent. */
  storageDeposit(b: { token: string; account_id?: string }): Promise<any> { return this.req('POST', '/wallet/v1/storage-deposit', b); }
  /** status of a wallet request (used to wait for a pending call) */
  request(id: string): Promise<any> { return this.req('GET', `/wallet/v1/requests/${encodeURIComponent(id)}`); }

  /** Encrypt + sign + store a policy on-chain. `rules` follows https://app.outlayer.ai/docs/agent-custody (Example Policy). */
  async setPolicy(owner: Account, policy: { rules: object; capabilities?: object; approval?: object }, walletId: string): Promise<{ txHash: string; version: number }> {
    const enc = await this.req('POST', '/wallet/v1/encrypt-policy', { ...policy, wallet_id: walletId });
    if (!enc.encrypted_base64) throw new PolicyApiError(500, enc, 'encrypt-policy returned no encrypted_base64');
    const sg = await this.req('POST', '/wallet/v1/sign-policy', { encrypted_data: enc.encrypted_base64, caller: this.o.owner.accountId });
    if (!sg.signature_hex) throw new PolicyApiError(500, sg, 'sign-policy returned no signature');
    const args = { wallet_pubkey: `ed25519:${sg.public_key_hex}`, encrypted_data: enc.encrypted_base64, wallet_signature: sg.signature_hex, version: Number(sg.version ?? 0), locked: Boolean(sg.locked ?? false), valid_until: Number(sg.valid_until ?? 0) };
    const { txHash } = await callTx(owner, this.contract, 'store_wallet_policy', args, TGAS(100), 10n ** 23n); // 0.1 NEAR storage deposit
    return { txHash, version: args.version };
  }

  /** Public view: is a policy stored on-chain for this wallet key? (policy content is encrypted) */
  static async hasPolicy(rpc: string, contract: string, walletPubkey: string): Promise<boolean> { return view<boolean>(rpc, contract, 'has_wallet_policy', { wallet_pubkey: walletPubkey }); }
}

/** Interpret a wallet call result as a Layer-A (wallet policy) decision. */
export function layerAVerdict(e: unknown): { blocked: boolean; status: number | null; error: string } {
  if (e instanceof PolicyApiError) {
    const code = (e.body as any)?.error ?? '';
    return { blocked: e.status === 403 && /policy_denied|wallet_frozen/.test(String(code)), status: e.status, error: e.message };
  }
  return { blocked: false, status: null, error: (e as Error).message };
}
