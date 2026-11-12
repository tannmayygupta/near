'use client';
import { useMemo, useState } from 'react';
import { download, fmtUnits, getLedgerAll, toCsv } from '@/lib/data';
import { PageHead, Src, useAsync, View } from '@/components/ui';
import { BOUNDS, type LedgerRow } from '@/lib/types';

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
/** Ledger rows name the token either by asset id or as "sell" / "buy" (the mandate's sell and buy token). */
function tokenOf(t: string): { symbol: string; decimals: number } {
  if (t === 'sell') return BOUNDS.allowedTokens['nep141:wrap.near'];
  if (t === 'buy') return BOUNDS.allowedTokens[USDC];
  return BOUNDS.allowedTokens[t] ?? { symbol: t.replace('nep141:', '').slice(0, 14), decimals: 0 };
}

function Table({ rows, s }: { rows: LedgerRow[]; s: import('@/lib/types').Source }) {
  const [kind, setKind] = useState('all');
  const shown = useMemo(() => rows.filter((r) => kind === 'all' || r.kind === kind), [rows, kind]);
  const kinds = ['all', ...new Set(rows.map((r) => r.kind))];
  return (
    <>
      <div className="row" style={{ margin: '8px 0' }}>
        <label htmlFor="k">Filter</label>
        <select id="k" value={kind} onChange={(e) => setKind(e.target.value)} style={{ padding: 8, borderRadius: 8 }}>{kinds.map((k) => <option key={k}>{k}</option>)}</select>
        <button onClick={() => download('quiet-treasury-ledger.csv', toCsv(rows))} disabled={!rows.length}>Download CSV (accountant)</button>
        <Src s={s} />
      </div>
      {shown.length === 0 ? <div className="state">No ledger entries.</div> : (
        <div className="card"><table>
          <thead><tr><th>Time</th><th>Kind</th><th>Label</th><th>Amount</th><th>Token</th><th>Chain</th><th>Status</th><th>Reference</th></tr></thead>
          <tbody>{shown.map((r, i) => {
            const t = tokenOf(r.token);
            return (
              <tr key={i}><td className="mono">{r.ts}</td><td>{r.kind}</td><td>{r.label}</td><td title={`${r.amount} (smallest units)`}>{/^\d+$/.test(r.amount) ? fmtUnits(r.amount, t.decimals, 6) : r.amount}</td><td>{t.symbol}</td><td>{r.chain}</td><td>{r.status}</td><td className="mono">{r.ref ?? '-'}</td></tr>
            );
          })}</tbody>
        </table></div>
      )}
    </>
  );
}

export default function Ledger() {
  const a = useAsync(getLedgerAll, []);
  return (
    <>
      <PageHead title="Public ledger" lead="Every sale, cost, fee, payout and return. Amounts are shown in token units (hover for the exact smallest-unit value; the CSV keeps the exact values). Rows come from the worker, or from the committed recorded run when the worker has none." />
      <View a={a} what="ledger">{(rows, s) => (rows.length === 0 ? <div className="state">No ledger entries yet.</div> : <Table rows={rows} s={s} />)}</View>
    </>
  );
}
