// Minimal mirror of src/engine/schema.ts (keep in sync). Amounts are integer strings in smallest units.
import { z } from 'zod';

export const CHAINS = ['near', 'solana', 'base', 'arbitrum', 'ethereum'] as const;
export const TIERS = ['small', 'mid', 'large'] as const;
export const STATUSES = ['Approved', 'Funded', 'Executing', 'Settling', 'Completed', 'Cancelled', 'Expired'] as const;
export type Status = (typeof STATUSES)[number];

export const BOUNDS = {
  maxDurationS: 14 * 24 * 3600,
  minDurationS: 60,
  maxChunks: 500,
  maxFeeBps: 500,
  maxPayouts: 25,
  allowedTokens: {
    'nep141:wrap.near': { symbol: 'wNEAR', decimals: 24 },
    'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': { symbol: 'USDC', decimals: 6 },
  } as Record<string, { symbol: string; decimals: number }>,
};

const uint = z.string().regex(/^\d+$/);
const decimal = z.string().regex(/^\d+(\.\d+)?$/);
const acct = z.string().min(2).max(64);

export const Payout = z
  .object({
    label: z.string().min(1).max(60),
    chain: z.enum(CHAINS),
    address: z.string().min(2).max(100),
    token: z.string(),
    amount: uint.optional(),
    percent: z.number().min(0).max(100).optional(),
  })
  .refine((p) => (p.amount !== undefined) !== (p.percent !== undefined), 'exactly one of amount | percent');
export type Payout = z.infer<typeof Payout>;

export const MandateTerms = z.object({
  dao: acct,
  treasurer: acct,
  sellToken: z.string(),
  buyToken: z.string(),
  maxSellAmount: uint,
  minPrice: decimal,
  startTs: z.number().int().positive(),
  endTs: z.number().int().positive(),
  chunkMin: uint,
  chunkMax: uint,
  intervalMinS: z.number().int().min(5),
  intervalMaxS: z.number().int().min(5),
  payouts: z.array(Payout).max(BOUNDS.maxPayouts),
  feeBps: z.number().int().min(0).max(BOUNDS.maxFeeBps).default(0),
  feeRecipient: acct.optional(),
  returnTo: acct,
  sealed: z.boolean().default(false),
  notes: z.string().max(500).optional(),
});
export type MandateTerms = z.infer<typeof MandateTerms>;

/** Local bound checks that mirror the schema's superRefine so the UI can explain violations before signing. */
export function boundIssues(m: MandateTerms): string[] {
  const out: string[] = [];
  const tok = BOUNDS.allowedTokens;
  if (!tok[m.sellToken]) out.push('sellToken is not in the allowed token list');
  if (!tok[m.buyToken]) out.push('buyToken is not in the allowed token list');
  if (m.sellToken === m.buyToken) out.push('sell and buy token must differ');
  const dur = m.endTs - m.startTs;
  if (dur < BOUNDS.minDurationS || dur > BOUNDS.maxDurationS) out.push(`duration must be ${BOUNDS.minDurationS}s to ${BOUNDS.maxDurationS}s`);
  if (BigInt(m.chunkMin) > BigInt(m.chunkMax)) out.push('chunkMin is larger than chunkMax');
  if (BigInt(m.chunkMax) > BigInt(m.maxSellAmount)) out.push('chunkMax is larger than the budget');
  if (m.intervalMinS > m.intervalMaxS) out.push('intervalMin is larger than intervalMax');
  if (BigInt(m.chunkMin) > 0n && BigInt(m.maxSellAmount) / BigInt(m.chunkMin) > BigInt(BOUNDS.maxChunks)) out.push(`would need more than ${BOUNDS.maxChunks} chunks`);
  if (m.payouts.reduce((s, p) => s + (p.percent ?? 0), 0) > 100) out.push('payout percents exceed 100');
  for (const p of m.payouts) if (!tok[p.token]) out.push(`payout token not allowed (${p.label})`);
  return out;
}

// ---- data shapes returned by the worker read-only API / contract views ----
export type Source = 'chain' | 'api' | 'recorded';
export type Result<T> = { ok: true; data: T; source: Source } | { ok: false; error: string };

export type OnchainMandate = {
  id: number;
  treasurer: string;
  terms_hash: string;
  terms_json: string | null;
  sell_token: string;
  max_sell: string;
  start_ns: number;
  end_ns: number;
  tier: string;
  status: Status;
  sold: string;
  chunks: number;
  created_ns: number;
  report_hash: string | null;
  revealed_terms: string | null;
};

export type DaoProposal = {
  id: number;
  proposer: string;
  description: string;
  kind: Record<string, unknown>;
  status: string;
  vote_counts: Record<string, [string, string, string]>;
  votes: Record<string, string>;
  submission_time: string;
};

export type Chunk = {
  index: number;
  ts: string; // ISO
  sellAmount: string;
  buyAmount: string | null;
  price: string | null;
  benchmarkPrice: string | null;
  status: 'pending' | 'success' | 'failed' | 'refunded' | 'skipped';
  requestId: string | null;
  intentHash: string | null;
  note?: string;
};

export type LedgerRow = {
  ts: string;
  kind: 'sale' | 'cost' | 'payout' | 'fee' | 'return';
  label: string;
  token: string;
  amount: string;
  chain: string;
  ref: string | null; // tx hash / request id
  status: string;
};

export type Report = {
  mandateId: number;
  generatedAt: string;
  totalSold: string;
  totalBought: string;
  avgPrice: string | null;
  benchmarkPrice: string | null;
  benchmarkSource: string;
  slippageBps: number | null;
  feesPaid: string;
  returned: string;
  violations: number;
  summary: string | null; // AI summary text (TEE-signed)
  summarySignature: { text: string; signature: string; signingAddress: string; signingAlgo: string } | null;
  reportHash: string | null;
};

export type VerifyCheck = { name: string; ok: boolean; detail: string };
export type RedteamResult = { attack: string; blocked: boolean; layer: string; status: number | null; error: string; requestId: string | null };
export type Balances = { token: string; symbol: string; amount: string; where: 'wallet' | 'intents' | 'confidential' | 'dao' }[];
export type ParseResult = { terms: MandateTerms; summary: string; attestation?: { signer: string; nonceEchoed: boolean } };
