// Layer A, written PER MANDATE: before a mandate may trade, the worker writes an OutLayer wallet policy derived from the DAO-approved terms:
//   - only `call` and `transfer` transactions; only to the contracts this mandate needs (sell token, buy token, the DEX) and the DAO it returns to;
//   - native NEAR per transaction capped at the mandate's own budget (a stolen credential cannot move more than the DAO approved);
//   - a rate limit.
// The policy is encrypted by OutLayer's TEE and stored on the OutLayer contract by the owner (a 0.1 NEAR storage deposit each time).
// PROBED 2026-11-13 on OutLayer testnet (data/testnet-outlayer-findings.json):
//   - a contract call through POST /wallet/v1/call is checked against the whitelist by its OUTER destination only; the `receiver_id` inside an
//     ft_transfer's args is NOT inspected. Token payouts have to go through /call, so Layer A bounds WHICH CONTRACTS the wallet may touch and how much
//     NATIVE NEAR may move, but NOT who receives a token payout. Payout recipients are enforced by Layer B (executor guards + the mandate terms).
//   - POST /wallet/v1/transfer is native NEAR only (a `token` field is silently ignored), so native returns to the DAO are the transfers Layer A checks.
//   - per-token amount caps (limits.per_transaction[<token>]) were NOT enforced for a token sent through /call.
import type { Account } from 'near-api-js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashJson } from '../../src/engine/hash';
import type { MandateTerms } from '../../src/engine/schema';
import type { OutLayerWallet } from '../../src/near/outlayer-policy';

const bare = (t: string) => t.replace(/^nep141:/, '');
const MIN_NATIVE_CAP = 50_000_000_000_000_000_000_000n; // 0.05 NEAR: enough for storage registrations (Ref 0.01, tokens 0.00125)

export interface PolicyRules { transaction_types: string[]; allowed_tokens: string[]; addresses: { mode: 'whitelist'; list: string[] }; limits: { per_transaction: { native: string } }; rate_limit: { max_per_hour: number } }

export function policyRulesFor(terms: Pick<MandateTerms, 'sellToken' | 'buyToken' | 'maxSellAmount' | 'returnTo' | 'chunkMin'>, dex: string): { rules: PolicyRules } {
  const cap = BigInt(terms.maxSellAmount) > MIN_NATIVE_CAP ? BigInt(terms.maxSellAmount) : MIN_NATIVE_CAP;
  const maxChunks = Number(BigInt(terms.maxSellAmount) / (BigInt(terms.chunkMin) > 0n ? BigInt(terms.chunkMin) : 1n)) + 1;
  // ONLY the contracts the trade needs + the DAO it returns native NEAR to. Payees are deliberately NOT listed: token payouts are /call ft_transfers
  // (outer destination = the token contract), so listing payees here would look like a protection that Layer A does not actually provide.
  const list = [...new Set([bare(terms.sellToken), bare(terms.buyToken), dex, terms.returnTo])];
  return { rules: { transaction_types: ['call', 'transfer'], allowed_tokens: ['*'], addresses: { mode: 'whitelist', list }, limits: { per_transaction: { native: cap.toString() } }, rate_limit: { max_per_hour: Math.min(10_000, Math.max(300, maxChunks * 40)) } } }; // generous on purpose: every refused or replayed call counts, and one wallet serves back-to-back mandates
}

export interface AppliedPolicy { mandateId: number; rulesHash: string; txHash: string; at: number; rules: PolicyRules }

export class MandatePolicy {
  private applied: Record<string, AppliedPolicy> = {};
  constructor(private o: { wallet: OutLayerWallet; owner: Account; walletId: string; dex: string; path?: string; log?: (k: string, f: Record<string, unknown>) => void }) {
    if (o.path && existsSync(o.path)) { try { this.applied = JSON.parse(readFileSync(o.path, 'utf8')); } catch { this.applied = {}; } }
  }
  private save() { if (!this.o.path) return; mkdirSync(dirname(this.o.path), { recursive: true }); writeFileSync(this.o.path, JSON.stringify(this.applied, null, 2)); }
  get(mandateId: number): AppliedPolicy | undefined { return this.applied[String(mandateId)]; }
  /** Idempotent: a mandate whose current policy is already stored is not rewritten (one 0.1 NEAR deposit per mandate, not per tick). */
  async ensure(mandateId: number, terms: Parameters<typeof policyRulesFor>[0]): Promise<AppliedPolicy & { reused: boolean }> {
    const p = policyRulesFor(terms, this.o.dex);
    const rulesHash = hashJson(p.rules);
    const prev = this.get(mandateId);
    if (prev && prev.rulesHash === rulesHash) return { ...prev, reused: true };
    const stored = await this.o.wallet.setPolicy(this.o.owner, p, this.o.walletId);
    const rec: AppliedPolicy = { mandateId, rulesHash, txHash: stored.txHash, at: Math.floor(Date.now() / 1000), rules: p.rules };
    this.applied[String(mandateId)] = rec; this.save();
    this.o.log?.('policy_applied', { mandate: mandateId, tx: stored.txHash, contracts: p.rules.addresses.list.length, nativeCap: p.rules.limits.per_transaction.native });
    return { ...rec, reused: false };
  }
}
