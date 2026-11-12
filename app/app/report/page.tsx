'use client';
import { download, getLedger, getReport, fmtUnits, toCsv, withRecordedFallback } from '@/lib/data';
import { PageHead, Src, Stat, useAsync, View } from '@/components/ui';
import { WithMandate, tokenInfo } from '@/components/mandates';
import type { OnchainMandate, Report } from '@/lib/types';

function Body({ m, s }: { m: OnchainMandate; s: import('@/lib/types').Source }) {
  const rep = useAsync(() => withRecordedFallback(getReport(m.id), (r) => r.report), [m.id]);
  const led = useAsync(() => withRecordedFallback(getLedger(), (r) => r.ledger), []);
  const sell = tokenInfo(m.sell_token);
  return (
    <>
      <View a={rep} what="settlement report">
        {(r: Report, rs) => {
          const anchored = m.report_hash;
          const match = anchored && r.reportHash ? anchored === r.reportHash : null;
          return (
            <>
              <div className="grid">
                <Stat k={`Sold (${sell.symbol})`} v={fmtUnits(r.totalSold, sell.decimals)} s={rs} />
                <Stat k="Received (buy token, 6 dp)" v={fmtUnits(r.totalBought, 6)} s={rs} />
                <Stat k="Average price" v={r.avgPrice ?? '-'} s={rs} />
                <Stat k={`Benchmark (${r.benchmarkSource})`} v={r.benchmarkPrice ?? '-'} s={rs} />
                <Stat k="Slippage vs benchmark" v={r.slippageBps === null ? '-' : `${r.slippageBps} bps`} s={rs} />
                <Stat k="Fees paid" v={r.feesPaid} s={rs} />
                <Stat k="Returned to DAO" v={r.returned} s={rs} />
                <Stat k="Policy violations" v={r.violations} s={rs} />
              </div>
              <h2>AI summary</h2>
              {r.summary ? (
                <div className="card">
                  <p>{r.summary}</p>
                  {r.summarySignature && <p className="mono">signed by {r.summarySignature.signingAddress} ({r.summarySignature.signingAlgo}) Â· {r.summarySignature.signature.slice(0, 40)}â€¦</p>}
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
        }}
      </View>
      <h2>Accountant export</h2>
      <View a={led} what="ledger for export">
        {(rows, ls) => <div className="row"><button className="primary" onClick={() => download(`quiet-treasury-mandate-${m.id}.csv`, toCsv(rows))} disabled={!rows.length}>Download CSV</button><Src s={ls} /><span style={{ color: 'var(--muted)' }}>{rows.length} rows</span></div>}
      </View>
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

