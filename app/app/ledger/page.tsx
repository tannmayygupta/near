'use client';
import { useMemo, useState } from 'react';
import { download, fmtUnits, getLedgerAll, getRealRun, looksLikeTxHash, toCsv, type RealRun, type RecordedRun, type RunTx } from '@/lib/data';
import { PageHead, Src, useAsync, View } from '@/components/ui';
import { RunTxList, TxLink } from '@/components/real';
import { BOUNDS, type LedgerRow } from '@/lib/types';

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
/** Ledger rows name the token either by asset id or as "sell" / "buy" (the mandate's sell and buy token). On testnet that is wNEAR / USDT.e. */
function tokenOf(t: string): { symbol: string; decimals: number } {
  if (t === 'sell') return BOUNDS.allowedTokens['nep141:wrap.testnet'] ?? BOUNDS.allowedTokens['nep141:wrap.near'];
  if (t === 'buy') return BOUNDS.allowedTokens['nep141:usdt.fakes.testnet'] ?? BOUNDS.allowedTokens[USDC];
  // rows may name the token by asset id or by its symbol ("USDT.e", "wNEAR")
  return BOUNDS.allowedTokens[t] ?? Object.values(BOUNDS.allowedTokens).find((x) => x.symbol === t) ?? { symbol: t.replace('nep141:', '').slice(0, 14), decimals: 0 };
}

/** Ledger sale rows carry no tx hash; map "mandate N chunk i" to the real swap transactions of the committed testnet-real run. */
function swapRefs(run: RecordedRun & { real: RealRun; txs: RunTx[] }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of run.real.swaps) out[`mandate ${run.mandate?.id} chunk ${s.index}`] = s.tx;
  const cancelId = run.cancelRun?.mandate?.id;
  const i = run.txs.findIndex((t) => /create_mandate #2/.test(t.label));
  if (i >= 0 && cancelId !== undefined) {
    let n = 0;
    for (const t of run.txs.slice(i)) if (/ft_transfer_call/.test(t.label)) out[`mandate ${cancelId} chunk ${n++}`] = t.txHash;
  }
  return out;
}

function Table({ rows, s, refs }: { rows: LedgerRow[]; s: import('@/lib/types').Source; refs: Record<string, string> }) {
  const [kind, setKind] = useState('all');
  const shown = useMemo(() => rows.filter((r) => kind === 'all' || r.kind === kind), [rows, kind]);
  const kinds = ['all', ...new Set(rows.map((r) => r.kind))];
  return (
    <>
      <div className="row" style={{ margin: '8px 0' }}>
        <label htmlFor="k">Filter</label>
        <select id="k" value={kind} onChange={(e) => setKind(e.target.value)} style={{ padding: 8, borderRadius: 8 }}>{kinds.map((k) => <option key={k}>{k}</option>)}</select>
        <button onClick={() => download('quiet-treasury-ledger.csv', toCsv(rows.map((r) => ({ ...r, ref: r.ref ?? refs[r.label] ?? null }))))} disabled={!rows.length}>Download CSV (accountant)</button>
        <Src s={s} />
      </div>
      {shown.length === 0 ? <div className="state">No ledger entries.</div> : (
        <div className="card"><table>
          <thead><tr><th>Time</th><th>Kind</th><th>Label</th><th>Amount</th><th>Token</th><th>Chain</th><th>Status</th><th>Reference</th></tr></thead>
          <tbody>{shown.map((r, i) => {
            const t = tokenOf(r.token);
            return (
              <tr key={i}><td className="mono">{r.ts}</td><td>{r.kind}</td><td>{r.label}</td><td title={`${r.amount} (smallest units)`}>{/^\d+$/.test(r.amount) ? fmtUnits(r.amount, t.decimals, 6) : r.amount}</td><td>{t.symbol}</td><td>{r.chain}</td><td>{r.status}</td><td>{(() => { const ref = r.ref ?? refs[r.label] ?? null; return looksLikeTxHash(ref) ? <TxLink hash={ref!} /> : <span className="mono">{ref ?? '-'}</span>; })()}</td></tr>
            );
          })}</tbody>
        </table></div>
      )}
    </>
  );
}

export default function Ledger() {
  const a = useAsync(getLedgerAll, []);
  const run = useAsync(getRealRun, []);
  const refs = !run.loading && run.result.ok ? swapRefs(run.result.data) : {};
  return (
    <>
      <PageHead title="Public ledger" lead="Every sale, cost, fee, payout and return. Amounts are shown in token units (hover for the exact smallest-unit value; the CSV keeps the exact values). Rows come from the worker, or from the committed recorded run when the worker has none." />
      <View a={a} what="ledger">{(rows, s) => (rows.length === 0 ? <div className="state">No ledger entries yet.</div> : <Table rows={rows} s={s} refs={refs} />)}</View>
      <h2>On-chain transactions behind the ledger</h2>
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>Every swap, payout, fee and return above is a real public-testnet transaction. Open any of them in the explorer.</p>
      <RunTxList match={/./} caption="Show all transactions of the recorded run" />
    </>
  );
}
