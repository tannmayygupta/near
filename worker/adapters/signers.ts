// Who signs the on-chain calls of the testnet execution adapter (worker/adapters/ref-testnet.ts).
//   KeySigner            : a NEAR account whose secret key the WORKER holds (the original testnet path).
//   OutLayerCustodySigner: an OutLayer agent wallet (testnet-api.outlayer.ai). The signing key lives in OutLayer's TEE; the worker holds only an
//                          owner credential that can ask for calls, and every call is checked by the wallet policy (Layer A) BEFORE it is signed.
// Both return the same shape so the adapter does not care. A policy refusal surfaces as OutLayerError('policy_denied').
import { createHash } from 'node:crypto';
import { getTransactionLastResult, actions as nearActions } from 'near-api-js';
import type { Account } from 'near-api-js';
import { providerFor } from '../../src/near/chain';
import { OutLayerError, classify } from '../../src/near/outlayer';
import { OutLayerWallet, PolicyApiError } from '../../src/near/outlayer-policy';

export interface SignedCall { hash: string; logs: string[]; value: unknown; burnt: bigint }
export interface ChainSigner {
  /** account id the funds live on (named account for KeySigner, 64-hex implicit account for an OutLayer wallet) */
  readonly id: string;
  readonly kind: 'key' | 'outlayer-custody';
  call(contract: string, method: string, args: object, gas: bigint, deposit: bigint, idem?: string): Promise<SignedCall>;
  sendNative(to: string, amount: bigint, idem?: string): Promise<{ hash: string; burnt: bigint }>;
  /** NEP-141 transfer of `amount` of `token` to `to` (recipient must already be storage-registered on the token). */
  sendToken(token: string, to: string, amount: bigint, memo: string, idem?: string): Promise<{ hash: string; burnt: bigint }>;
}

/** tx hash of an OutLayer wallet response. A REPLAYED idempotency key answers with the original request, whose hash sits at result.tx_hash (observed 2026-11-13). */
export const txOfResponse = (r: any): string | undefined => (typeof r?.tx_hash === 'string' && r.tx_hash) || (typeof r?.result?.tx_hash === 'string' && r.result.tx_hash) || undefined;

export function burntOf(o: any): bigint {
  let t = BigInt(o?.transaction_outcome?.outcome?.tokens_burnt ?? '0');
  for (const r of o?.receipts_outcome ?? []) t += BigInt(r.outcome?.tokens_burnt ?? '0');
  return t;
}
/** OutLayer idempotency keys are UUID-shaped in its docs; derive a stable one from our (mandate:chunk:attempt:step) key. */
export const idemUuid = (s: string): string => { const h = createHash('sha256').update(s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const logsOf =(o: any): string[] => (o?.receipts_outcome ?? []).flatMap((r: any) => r.outcome?.logs ?? []);
const hashOf = (o: any): string => o?.transaction?.hash ?? o?.transaction_outcome?.id ?? '';
const valueOf = (o: any): unknown => { try { return getTransactionLastResult(o); } catch { return undefined; } };

export class KeySigner implements ChainSigner {
  readonly kind = 'key' as const;
  constructor(private acc: Account) {}
  get id() { return this.acc.accountId; }
  async call(contract: string, method: string, args: object, gas: bigint, deposit: bigint): Promise<SignedCall> {
    const o: any = await this.acc.callFunctionRaw({ contractId: contract, methodName: method, args, gas, deposit });
    return { hash: hashOf(o), logs: logsOf(o), value: valueOf(o), burnt: burntOf(o) };
  }
  async sendNative(to: string, amount: bigint) {
    const o: any = await this.acc.signAndSendTransaction({ receiverId: to, actions: [nearActions.transfer(amount)] });
    return { hash: hashOf(o), burnt: burntOf(o) };
  }
  async sendToken(token: string, to: string, amount: bigint, memo: string) {
    const r = await this.call(token, 'ft_transfer', { receiver_id: to, amount: amount.toString(), memo }, 30n * 10n ** 12n, 1n);
    return { hash: r.hash, burnt: r.burnt };
  }
}

/** Calls go through POST /wallet/v1/call and /transfer of an OutLayer wallet; logs, burnt gas and the return value are then read from the chain by tx hash. */
export class OutLayerCustodySigner implements ChainSigner {
  readonly kind = 'outlayer-custody' as const;
  constructor(private wallet: OutLayerWallet, readonly id: string, private rpc: string, private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}

  private mapErr(e: unknown): never {
    if (e instanceof PolicyApiError) throw classify(e.status, e.body); // 403 -> policy_denied, 422 onchain_tx_failed -> unknown (message kept)
    throw e;
  }
  private async outcome(hash: string): Promise<any> {
    let last: unknown;
    for (let i = 0; i < 25; i++) {
      try { return await providerFor(this.rpc).viewTransactionStatus({ txHash: hash, accountId: this.id, waitUntil: 'FINAL' } as any); }
      catch (e) { last = e; await this.sleep(1500); }
    }
    throw new OutLayerError('upstream', 502, { message: `tx ${hash} signed by the OutLayer wallet is not visible on chain: ${(last as Error)?.message?.slice(0, 100)}` });
  }
  async call(contract: string, method: string, args: object, gas: bigint, deposit: bigint, idem?: string): Promise<SignedCall> {
    let r;
    try { r = await this.wallet.call({ receiver_id: contract, method_name: method, args, gas: gas.toString(), deposit: deposit.toString() }, idem ? idemUuid(idem) : undefined); } catch (e) { this.mapErr(e); }
    const hash = txOfResponse(r);
    if (r!.status !== 'success' || !hash) throw new OutLayerError('unknown', 502, { message: `OutLayer call ${method} ended with status ${r!.status}`, body: r });
    const o = await this.outcome(hash);
    return { hash, logs: logsOf(o), value: valueOf(o), burnt: burntOf(o) };
  }
  async sendNative(to: string, amount: bigint, idem?: string) {
    let r;
    try { r = await this.wallet.transfer({ to, amount: amount.toString() }, idem ? idemUuid(idem) : undefined); } catch (e) { this.mapErr(e); }
    const hash = txOfResponse(r);
    if (r.status !== 'success' || !hash) throw new OutLayerError('unknown', 502, { message: `OutLayer transfer ended with status ${r.status}`, body: r });
    const o = await this.outcome(hash);
    return { hash, burnt: burntOf(o) };
  }
  /**
   * NEP-141 payout = an `ft_transfer` contract call through POST /wallet/v1/call (OutLayer's documented way to send FT tokens).
   * LESSON (2026-11-13): POST /wallet/v1/transfer with a `token` field does NOT send the token: it ignores the field and sends `amount` yoctoNEAR
   * (it answers success with a tx hash and the token balance does not move). Never use it for tokens.
   * Layer A sees only the OUTER contract of a /call, so the payout RECIPIENT is enforced by Layer B (executor guards), see mandate-policy.ts.
   */
  async sendToken(token: string, to: string, amount: bigint, memo: string, idem?: string) {
    const r = await this.call(token, 'ft_transfer', { receiver_id: to, amount: amount.toString(), memo }, 30n * 10n ** 12n, 1n, idem);
    return { hash: r.hash, burnt: r.burnt };
  }
}
