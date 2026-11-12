'use client';
import { useMemo, useState } from 'react';
import { download, getLedger, toCsv, withRecordedFallback } from '@/lib/data';
import { PageHead, Src, useAsync, View } from '@/components/ui';
import type { LedgerRow } from '@/lib/types';

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
          <tbody>{shown.map((r, i) => (
            <tr key={i}><td className="mono">{r.ts}</td><td>{r.kind}</td><td>{r.label}</td><td>{r.amount}</td><td className="mono">{r.token.replace('nep141:', '').slice(0, 14)}</td><td>{r.chain}</td><td>{r.status}</td><td className="mono">{r.ref ?? '-'}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}

export default function Ledger() {
  const a = useAsync(() => withRecordedFallback(getLedger(), (r) => r.ledger), []);
  return (
    <>
      <PageHead title="Public ledger" lead="Every sale, cost, fee, payout and return. Each row links to a request id or transaction hash. Amounts are in smallest units, exactly as the wallet reported them." />
      <View a={a} what="ledger">{(rows, s) => <Table rows={rows} s={s} />}</View>
    </>
  );
}

