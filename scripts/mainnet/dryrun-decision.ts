// Runs the LIVE executor decision path in dry-run against REAL mainnet liquidity: plan a chunk -> real 1Click dry quote -> price floor -> the
// exact OutLayer request that WOULD be sent (recorded, never sent). No key, no funds, no chain writes.
// Run: npx tsx scripts/mainnet/dryrun-decision.ts   (writes data/demo-run/mainnet-dryrun-decision.json)
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { MandateTerms } from '../../src/engine/schema.js';
import { LiveDryRunOutLayer, dryRunDecision } from '../../worker/adapters/live-dryrun.js';
import { MAINNET_ASSETS } from '../../src/near/routes.js';

const IMPLICIT = '36842e2f73d0b7b2f2af6e0d94a7a997398c2c09d9cf09ca3fa23b5426fccf88';
const now = Math.floor(Date.now() / 1000);
const terms = MandateTerms.parse({
  dao: 'sample-dao.sputnik-dao.near', treasurer: 'alice.near', sellToken: MAINNET_ASSETS.wNEAR.id, buyToken: MAINNET_ASSETS.USDC.near,
  maxSellAmount: (5n * 10n ** 24n).toString(), minPrice: '2.5', // floor deliberately below the live price so the live quote can pass
  startTs: now - 60, endTs: now + 86400, chunkMin: (10n ** 24n).toString(), chunkMax: (2n * 10n ** 24n).toString(), intervalMinS: 600, intervalMaxS: 1200,
  payouts: [], feeBps: 0, returnTo: 'sample-dao.sputnik-dao.near', sealed: false,
});

const decisions: unknown[] = [];
for (const [label, floor] of [['floor below market (would swap)', '2.5'], ['floor above market (would refuse)', '9.0']] as const) {
  const adapter = new LiveDryRunOutLayer({ recipient: IMPLICIT });
  const t = MandateTerms.parse({ ...terms, minPrice: floor });
  const d = await dryRunDecision(t, { adapter, nowS: Math.floor(Date.now() / 1000), remaining: BigInt(t.maxSellAmount), idem: 'sample:0' });
  console.log(`\n== ${label}\n${d.note}`);
  console.log('plan', d.plan.kind === 'chunk' ? `chunk ${(Number(d.plan.size) / 1e24).toFixed(3)} wNEAR` : d.plan.kind);
  console.log('quoted out', d.quote?.amount_out, 'min (floor)', d.minAmountOut, 'floorOk', d.floorOk);
  if (d.wouldSend) console.log('WOULD SEND (blocked):', JSON.stringify(d.wouldSend));
  decisions.push({ label, floorPrice: floor, plan: d.plan.kind === 'chunk' ? { kind: 'chunk', size: d.plan.size.toString(), delayAfterS: d.plan.delayAfterS } : d.plan, quote: d.quote, minAmountOut: d.minAmountOut, floorOk: d.floorOk, wouldSend: d.wouldSend, note: d.note });
}
const out = { recordedAt: new Date().toISOString(), mode: 'live-dryrun: real 1Click dry quotes, money-moving calls blocked, nothing sent, no chain writes', source: 'api', decisions };
mkdirSync('data/demo-run', { recursive: true });
writeFileSync('data/demo-run/mainnet-dryrun-decision.json', JSON.stringify(out, null, 2));
if (existsSync('app/public/demo-run')) copyFileSync('data/demo-run/mainnet-dryrun-decision.json', 'app/public/demo-run/mainnet-dryrun-decision.json');
console.log('\nwrote data/demo-run/mainnet-dryrun-decision.json');
process.exit(0);
