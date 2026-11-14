// READ-ONLY proof for the DeFi track: live 1Click DRY quotes (dry:true; no key, no funds, no deposit address) for the sell leg and every
// cross-chain payout leg of a sample mandate. Nothing is executed. Run: npx tsx scripts/mainnet/readonly-proof.ts
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { planRoutes, type RouteInput, type Leg } from '../../src/near/routes.js';

const sample: RouteInput = {
  sellAmount: (5n * 10n ** 24n).toString(), // 5 wNEAR
  // 64-hex IMPLICIT account (the account type an OutLayer agent wallet has; this is the example address from OutLayer's docs). Used only as
  // recipient/refund in DRY quotes; never funded. Probe finding 2026-11-12, corrected 2026-11-14 (docs/DEFI.md): for a wNEAR-origin quote 1Click answered
  // HTTP 400 "Internal server error" when refundTo/recipient was wrap.near and 201 with an implicit 64-hex account; ordinary existing named accounts
  // (alice.near) also quote, so the implicit address is used because it is the OutLayer wallet's account type, not because named accounts always fail.
  treasuryAccount: '36842e2f73d0b7b2f2af6e0d94a7a997398c2c09d9cf09ca3fa23b5426fccf88',
  payouts: [
    { label: 'alice', chain: 'solana', address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', percent: 25 },
    { label: 'bob', chain: 'base', address: '0x1111111111111111111111111111111111111111', percent: 25 },
    { label: 'carol', chain: 'arbitrum', address: '0x2222222222222222222222222222222222222222', percent: 20 },
    { label: 'dave', chain: 'ethereum', address: '0x3333333333333333333333333333333333333333', percent: 15 },
    { label: 'erin', chain: 'near', address: 'contributor.near', percent: 15 },
  ],
};

const plan = await planRoutes(sample);
const human = (v: string | undefined, d = 6) => (v === undefined ? '-' : (Number(BigInt(v)) / 10 ** d).toFixed(d === 24 ? 4 : 4));
const row = (l: Leg) => {
  const dIn = l.from.symbol === 'wNEAR' ? 24 : 6;
  const q = l.quote;
  return {
    leg: l.id, route: `${l.from.symbol}(${l.from.chain}) -> ${l.to.symbol}(${l.to.chain})`, in: human(l.amountIn, dIn),
    out: q ? human(q.amountOut, 6) : '-', minOut: q ? human(q.minAmountOut, 6) : '-', eta_s: q?.timeEstimateS ?? '-',
    note: l.error ? `ERR ${l.error.status}: ${l.error.message.slice(0, 80)}` : l.skipped ?? 'quoted',
  };
};
console.table(plan.legs.map(row));
console.log('summary', plan.summary);

const out = {
  recordedAt: plan.recordedAt,
  mode: 'dry-run quotes only, no funds moved',
  source: 'api',
  endpoint: `${plan.baseUrl}/v0/quote (dry: true)`,
  sampleMandate: sample,
  legs: plan.legs,
  summary: plan.summary,
  honesty: 'These are live 1Click DRY quotes on NEAR mainnet liquidity. Nothing was deposited, swapped or withdrawn. Executing these routes (NEAR Intents / OutLayer custody / confidential swaps) is implemented but NOT proven with real money. A dry quote is not a fill: real prices can differ at execution time.',
};
mkdirSync('data/demo-run', { recursive: true });
writeFileSync('data/demo-run/mainnet-readonly.json', JSON.stringify(out, null, 2));
if (existsSync('app/public/demo-run')) copyFileSync('data/demo-run/mainnet-readonly.json', 'app/public/demo-run/mainnet-readonly.json');
console.log('wrote data/demo-run/mainnet-readonly.json');
process.exit(plan.summary.quoted > 0 ? 0 : 1);
