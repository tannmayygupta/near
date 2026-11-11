// Settlement report builder + CSV export + report hash. Nothing here invents data: inputs are fills/payouts/samples with source tags.
import { BOUNDS, MandateTerms } from './schema';
import { hashJson } from './hash';
import { Fill, PriceSample, Source, Tagged, edgeBps, fillPrice, tag, twap, vwap } from './benchmark';

export interface PayoutResult { label: string; chain: string; address: string; token: string; amount: string; status: 'success' | 'failed' | 'refunded' | 'needs_review'; requestId?: string; destTxHash?: string; source: Source }
export interface Violation { code: string; detail: string }
export interface Leftover { token: string; amount: string; returnedTo: string; txRef?: string; source: Source }

export interface ReportInput {
  mandateId: number | string;
  terms: MandateTerms;
  fills: Fill[];
  samples: PriceSample[]; // benchmark samples (price api / quotes)
  payouts: PayoutResult[];
  feeAmount: string; // buy-token smallest units actually paid as fee
  feeSource: Source;
  leftovers: Leftover[];
  violations: Violation[];
  generatedAt: string; // ISO; passed in so the report is reproducible
  aiSummary?: { text: string; chatId: string; requestHash: string; responseHash: string; signer: string };
}

export interface Report {
  version: 1;
  mandateId: number | string;
  generatedAt: string;
  totals: {
    soldSell: Tagged<string>; // smallest units of sell token
    proceedsBuy: Tagged<string>;
    fills: Tagged<number>;
    avgPrice: Tagged<number | null>; // VWAP of our fills
    benchmarkTwap: Tagged<number | null>;
    edgeBps: Tagged<number | null>;
    floorPrice: Tagged<string>;
    worstFillPrice: Tagged<number | null>;
    feePaid: Tagged<string>;
    payoutTotalBuy: Tagged<string>;
  };
  floorRespected: boolean;
  fills: Fill[];
  payouts: PayoutResult[];
  leftovers: Leftover[];
  violations: Violation[];
  benchmarkSamples: PriceSample[];
  aiSummary?: ReportInput['aiSummary'];
  reportHash: string; // hash of everything above (this field excluded)
}

const sumStr = (xs: string[]) => xs.reduce((s, x) => s + BigInt(x), 0n).toString();
const worstSource = (fs: Fill[]): Source => (fs.some((f) => f.source === 'recorded') ? 'recorded' : fs.some((f) => f.source === 'api') ? 'api' : 'chain');

export function buildReport(inp: ReportInput): Report {
  const { terms } = inp;
  const sd = BOUNDS.allowedTokens[terms.sellToken].decimals, bd = BOUNDS.allowedTokens[terms.buyToken].decimals;
  const fills = [...inp.fills].sort((a, b) => a.index - b.index);
  const src = worstSource(fills);
  const ours = vwap(fills, sd, bd);
  const bench = fills.length ? twap(inp.samples, fills[0].ts, fills[fills.length - 1].ts) : null;
  const prices = fills.map((f) => fillPrice(f, sd, bd));
  const floor = Number(terms.minPrice);
  const worst = prices.length ? Math.min(...prices) : null;
  const body = {
    version: 1 as const,
    mandateId: inp.mandateId,
    generatedAt: inp.generatedAt,
    totals: {
      soldSell: tag(sumStr(fills.map((f) => f.amountIn)), src),
      proceedsBuy: tag(sumStr(fills.map((f) => f.amountOut)), src),
      fills: tag(fills.length, src),
      avgPrice: tag(ours, src),
      benchmarkTwap: tag(bench, inp.samples.length ? inp.samples[0].source : 'api'),
      edgeBps: tag(edgeBps(ours, bench), 'api' as Source),
      floorPrice: tag(terms.minPrice, 'chain' as Source),
      worstFillPrice: tag(worst, src),
      feePaid: tag(inp.feeAmount, inp.feeSource),
      payoutTotalBuy: tag(sumStr(inp.payouts.filter((p) => p.status === 'success').map((p) => p.amount)), inp.payouts[0]?.source ?? 'chain'),
    },
    floorRespected: worst === null ? true : worst + 1e-12 >= floor,
    fills,
    payouts: inp.payouts,
    leftovers: inp.leftovers,
    violations: inp.violations,
    benchmarkSamples: inp.samples,
    aiSummary: inp.aiSummary,
  };
  return { ...body, reportHash: hashJson(body) };
}

export function verifyReportHash(r: Report): boolean {
  const { reportHash, ...body } = r;
  return hashJson(body) === reportHash;
}

const q = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Accountant CSV: one section per table, plain columns, units spelled out in headers. */
export function toCsv(r: Report, terms: MandateTerms): string {
  const sd = BOUNDS.allowedTokens[terms.sellToken], bd = BOUNDS.allowedTokens[terms.buyToken];
  const lines: string[] = [];
  lines.push(`# Quiet Treasury settlement for mandate ${r.mandateId} (report hash ${r.reportHash})`);
  lines.push('## Sales');
  lines.push(`index,timestamp_utc,sold_${sd.symbol}_smallest_units,received_${bd.symbol}_smallest_units,price_${bd.symbol}_per_${sd.symbol},request_id,source`);
  for (const f of r.fills) lines.push([f.index, new Date(f.ts * 1000).toISOString(), f.amountIn, f.amountOut, fillPrice(f, sd.decimals, bd.decimals).toFixed(8), f.requestId, f.source].map(q).join(','));
  lines.push('## Payouts');
  lines.push('label,chain,address,token,amount_smallest_units,status,destination_tx,source');
  for (const p of r.payouts) lines.push([p.label, p.chain, p.address, p.token, p.amount, p.status, p.destTxHash ?? '', p.source].map(q).join(','));
  lines.push('## Totals');
  lines.push('metric,value,source');
  for (const [k, v] of Object.entries(r.totals)) lines.push([k, (v as Tagged<unknown>).value, (v as Tagged<unknown>).source].map(q).join(','));
  lines.push('## Leftovers returned');
  lines.push('token,amount_smallest_units,returned_to,source');
  for (const l of r.leftovers) lines.push([l.token, l.amount, l.returnedTo, l.source].map(q).join(','));
  return lines.join('\n') + '\n';
}
