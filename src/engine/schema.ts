// Single source of truth for the MANDATE object (PLAN.md section 5). Shared by parser, worker, contract client, dashboard, verifier.
import { z } from 'zod';

export const CHAINS = ['near', 'solana', 'base', 'arbitrum', 'ethereum'] as const;
export const TIERS = ['small', 'mid', 'large'] as const;
export const STATUSES = ['Approved', 'Funded', 'Executing', 'Settling', 'Completed', 'Cancelled', 'Expired'] as const;

type TokenMap = Record<string, { symbol: string; decimals: number }>;
/** MAINNET: defuse asset ids traded through NEAR Intents (OutLayer wallet). */
export const MAINNET_TOKENS: TokenMap = {
  'nep141:wrap.near': { symbol: 'wNEAR', decimals: 24 },
  'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': { symbol: 'USDC', decimals: 6 },
};
/** TESTNET: real NEP-141 tokens traded on the Ref Finance testnet DEX (worker/adapters/ref-testnet.ts). USDT.e is a testnet "fakes" token. */
export const TESTNET_TOKENS: TokenMap = {
  'nep141:wrap.testnet': { symbol: 'wNEAR', decimals: 24 },
  'nep141:usdt.fakes.testnet': { symbol: 'USDT.e', decimals: 6 },
};
/** Token profile: TOKEN_PROFILE=testnet|mainnet, else follows NEAR_NETWORK (testnet -> testnet), default mainnet. Read lazily so tests/scripts can switch. */
export const tokenProfile = (): 'testnet' | 'mainnet' =>
  (process.env.TOKEN_PROFILE ?? (process.env.NEAR_NETWORK === 'testnet' ? 'testnet' : 'mainnet')) === 'testnet' ? 'testnet' : 'mainnet';

/** Hard bounds. The AI parser can only PROPOSE values inside these; the contract and worker re-check. */
export const BOUNDS = {
  maxDurationS: 14 * 24 * 3600,
  minDurationS: 60,
  maxChunks: 500,
  maxFeeBps: 500,
  maxPayouts: 25,
  // asset ids the demo is allowed to sell / buy (extend deliberately); depends on the token profile
  get allowedTokens(): TokenMap { return tokenProfile() === 'testnet' ? TESTNET_TOKENS : MAINNET_TOKENS; },
};

const uint = z.string().regex(/^\d+$/, 'integer string in smallest units');
const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'decimal string');
const nearAccount = z.string().min(2).max(64);

export const Payout = z
  .object({
    label: z.string().min(1).max(60),
    chain: z.enum(CHAINS),
    address: z.string().min(2).max(100),
    token: z.string(), // defuse asset id of the token paid (must be in allowedTokens)
    amount: uint.optional(), // fixed amount of `token`, smallest units
    percent: z.number().min(0).max(100).optional(), // or share of net proceeds
  })
  .refine((p) => (p.amount !== undefined) !== (p.percent !== undefined), 'exactly one of amount | percent');
export type Payout = z.infer<typeof Payout>;

export const MandateTerms = z
  .object({
    dao: nearAccount,
    treasurer: nearAccount, // who authored/proposed it (drives trust tiers)
    sellToken: z.string(),
    buyToken: z.string(),
    maxSellAmount: uint,
    minPrice: decimal, // floor: buy-token units (human) per 1 sell-token (human)
    startTs: z.number().int().positive(), // unix seconds
    endTs: z.number().int().positive(),
    chunkMin: uint,
    chunkMax: uint,
    intervalMinS: z.number().int().min(5),
    intervalMaxS: z.number().int().min(5),
    payouts: z.array(Payout).max(BOUNDS.maxPayouts),
    feeBps: z.number().int().min(0).max(BOUNDS.maxFeeBps).default(0),
    feeRecipient: nearAccount.optional(),
    returnTo: nearAccount, // leftovers go here (default: dao)
    sealed: z.boolean().default(false),
    notes: z.string().max(500).optional(),
  })
  .superRefine((m, ctx) => {
    const tok = BOUNDS.allowedTokens;
    if (!tok[m.sellToken]) ctx.addIssue({ code: 'custom', message: 'sellToken not allowed', path: ['sellToken'] });
    if (!tok[m.buyToken]) ctx.addIssue({ code: 'custom', message: 'buyToken not allowed', path: ['buyToken'] });
    if (m.sellToken === m.buyToken) ctx.addIssue({ code: 'custom', message: 'sell and buy token must differ' });
    const dur = m.endTs - m.startTs;
    if (dur < BOUNDS.minDurationS || dur > BOUNDS.maxDurationS)
      ctx.addIssue({ code: 'custom', message: `duration must be ${BOUNDS.minDurationS}s..${BOUNDS.maxDurationS}s`, path: ['endTs'] });
    if (BigInt(m.chunkMin) > BigInt(m.chunkMax)) ctx.addIssue({ code: 'custom', message: 'chunkMin > chunkMax', path: ['chunkMin'] });
    if (BigInt(m.chunkMax) > BigInt(m.maxSellAmount)) ctx.addIssue({ code: 'custom', message: 'chunkMax > maxSellAmount', path: ['chunkMax'] });
    if (m.intervalMinS > m.intervalMaxS) ctx.addIssue({ code: 'custom', message: 'intervalMin > intervalMax', path: ['intervalMinS'] });
    if (BigInt(m.chunkMin) > 0n) {
      const maxChunks = BigInt(m.maxSellAmount) / BigInt(m.chunkMin);
      if (maxChunks > BigInt(BOUNDS.maxChunks)) ctx.addIssue({ code: 'custom', message: `would need > ${BOUNDS.maxChunks} chunks`, path: ['chunkMin'] });
    }
    const pct = m.payouts.reduce((s, p) => s + (p.percent ?? 0), 0);
    if (pct > 100) ctx.addIssue({ code: 'custom', message: 'payout percents exceed 100', path: ['payouts'] });
    for (const [i, p] of m.payouts.entries())
      if (!tok[p.token]) ctx.addIssue({ code: 'custom', message: 'payout token not allowed', path: ['payouts', i, 'token'] });
  });
export type MandateTerms = z.infer<typeof MandateTerms>;

/** Tier by budget measured in the buy token's human units (computed by the app from a quote, not by the AI). */
export function tierForUsd(usd: number): (typeof TIERS)[number] {
  if (usd < 50) return 'small';
  if (usd < 500) return 'mid';
  return 'large';
}

/** Legal state transitions (mirrored in the Rust contract and tested on both sides). */
export const TRANSITIONS: Record<string, string[]> = {
  Approved: ['Funded', 'Cancelled', 'Expired'],
  Funded: ['Executing', 'Settling', 'Cancelled', 'Expired'],
  Executing: ['Settling', 'Cancelled', 'Expired'],
  Settling: ['Completed'],
  Completed: [],
  Cancelled: [],
  Expired: [],
};
export const canTransition = (from: string, to: string) => (TRANSITIONS[from] ?? []).includes(to);
