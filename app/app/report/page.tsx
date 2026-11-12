'use client';
import { download, getLedgerFor, getReportFor, fmtPrice, fmtUnits, humanizeText, toCsv } from '@/lib/data';
import { PageHead, Src, Stat, useAsync, View } from '@/components/ui';
import { WithMandate, parseTerms, tokenInfo } from '@/components/mandates';
import type { OnchainMandate, Report, Source } from '@/lib/types';

function Body({ m, s }: { m: OnchainMandate; s: Source }) {
  const rep = useAsync(() => getReportFor(m), [m.id]);
  const led = useAsync(() => getLedgerFor(m.id), [m.id]);
  const sell = tokenInfo(m.sell_token);
  const terms = parseTerms(m);
  const buy = tokenInfo((terms?.buyToken as string | undefined) ?? 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1');
  return (
    <>
      <View a={rep} what="settlement report">
        {({ report: r, why }, rs) => {
          if (!r) {
            return (
              <div className="state" role="status">
                <strong>No settlement report for mandate #{m.id}.</strong>
                <div style={{ marginTop: 6 }}>{why}</div>
                <div style={{ marginTop: 6 }}><Src s={rs} /></div>
              </div>
            );
          }
          return <ReportBody m={m} r={r} rs={rs} s={s} sell={sell} buy={buy} />;
        }}
      </View>
      <h2>Accountant export</h2>
      <View a={led} what="ledger for export">
        {(rows, ls) => rows.length === 0 ? (
          <div className="state">No ledger rows for mandate #{m.id}: nothing was sold, paid or returned through the ledger for this mandate.</div>
        ) : (
          <div className="row">
            <button className="primary" onClick={() => download(`quiet-treasury-mandate-${m.id}.csv`, toCsv(rows))}>Download CSV</button>
            <Src s={ls} /><span style={{ color: 'var(--muted)' }}>{rows.length} rows for mandate #{m.id} (amounts in the file are exact smallest units)</span>
          </div>
        )}
      </View>
    </>
  );
}

function ReportBody({ m, r, rs, s, sell, buy }: { m: OnchainMandate; r: Report; rs: Source; s: Source; sell: { symbol: string; decimals: number }; buy: { symbol: string; decimals: number } }) {
  const anchored = m.report_hash;
  const match = anchored && r.reportHash ? anchored === r.reportHash : null;
  const avg = r.avgPrice !== null ? Number(r.avgPrice) : null;
  const bench = r.benchmarkPrice !== null ? Number(r.benchmarkPrice) : null;
  // slippage may be missing in the stored report; derive it from the two prices shown (sell side: higher than benchmark is better)
  const bps = r.slippageBps ?? (avg !== null && bench ? Math.round(((avg - bench) / bench) * 10000) : null);
  const bpsLabel = bps === null ? '-' : `${bps >= 0 ? '+' : ''}${bps} bps ${bps >= 0 ? 'better' : 'worse'} than benchmark`;
  return (
    <>
      <div className="grid">
        <Stat k={`Sold (${sell.symbol})`} v={fmtUnits(r.totalSold, sell.decimals)} s={rs} />
        <Stat k={`Received (${buy.symbol})`} v={fmtUnits(r.totalBought, buy.decimals)} s={rs} />
        <Stat k={`Average price (${buy.symbol} per ${sell.symbol})`} v={fmtPrice(r.avgPrice)} s={rs} />
        <Stat k={`Benchmark (${r.benchmarkSource})`} v={fmtPrice(r.benchmarkPrice)} s={rs} />
        <Stat k="Versus benchmark" v={bpsLabel} s={rs} />
        <Stat k={`Fees paid (${buy.symbol})`} v={fmtUnits(r.feesPaid, buy.decimals)} s={rs} />
        <Stat k={`Returned to DAO (${buy.symbol})`} v={fmtUnits(r.returned, buy.decimals)} s={rs} />
        <Stat k="Policy violations" v={r.violations} s={rs} />
      </div>
      {r.slippageBps === null && bps !== null && <p style={{ color: 'var(--muted)', fontSize: 13 }}>The stored report has no slippage field, so the comparison above is computed here from the two prices shown.</p>}
      <h2>AI summary</h2>
      {r.summary ? (
        <div className="card">
          <p>{humanizeText(r.summary, sell.decimals, buy.decimals)}</p>
          <details>
            <summary>Exact text signed by the private AI (raw smallest units)</summary>
            <pre>{r.summary}</pre>
          </details>
          {r.summarySignature && <p className="mono">signed by {r.summarySignature.signingAddress} ({r.summarySignature.signingAlgo}) · {r.summarySignature.signature.slice(0, 40)}…</p>}
          <Src s={rs} />
        </div>
      ) : <div className="state">No AI summary attached to this report.</div>}
      <h2>On-chain anchor</h2>
      <div className="card">
        <div>Report hash in report <span className="mono">{r.reportHash ?? '-'}</span><Src s={rs} /></div>
        <div>Report hash on mandate contract <span className="mono">{anchored ?? 'not anchored yet'}</span><Src s={s} /></div>
        <div style={{ marginTop: 6 }}>{match === null ? <span className="pill warn">cannot compare yet</span> : match ? <span className="pill ok">hashes match</span> : <span className="pill bad">hash MISMATCH</span>}</div>
      </div>
    </>
  );
}

export default function ReportPage() {
  return (
    <>
      <PageHead title="Settlement report" lead="What was sold and at what price, compared with a public benchmark, with fees, payouts and leftovers, and a hash anchored on-chain so it cannot be quietly rewritten." />
      <WithMandate>{(m, s) => <Body m={m} s={s} />}</WithMandate>
    </>
  );
}
