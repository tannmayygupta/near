'use client';
import { useState } from 'react';
import { BOUNDS, type OnchainMandate } from '@/lib/types';
import { ENV, fmtUnits, getMandates, getRecordedRun, nsToDate, withRecordedFallback } from '@/lib/data';
import { Src, StatusPill, useAsync, View } from './ui';

export const loadMandates = () => withRecordedFallback(getMandates(), (r) => (r.mandate ? [r.mandate] : undefined));

/** Most useful default: a mandate that is executing, else the latest Completed one with an anchored report, else the latest. */
export function defaultMandate(list: OnchainMandate[], covered?: Set<number>): OnchainMandate {
  const rev = [...list].reverse();
  // With no worker (hosted demo) prefer a completed mandate whose receipts/report are in the committed recorded run, so the page shows data instead of an empty state.
  const coveredDone = covered && covered.size ? rev.find((m) => covered.has(m.id) && m.status === 'Completed' && m.report_hash) : undefined;
  return rev.find((m) => m.status === 'Executing') ?? coveredDone ?? rev.find((m) => m.status === 'Completed' && m.report_hash) ?? rev.find((m) => m.status === 'Completed') ?? list[list.length - 1];
}

export const tokenInfo = (id: string) => BOUNDS.allowedTokens[id] ?? { symbol: id, decimals: 0 };
export const parseTerms = (m: OnchainMandate): Record<string, any> | null => {
  const raw = m.revealed_terms ?? m.terms_json;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

export const TIER_RULES: Record<string, string> = {
  small: '1 treasurer approval (trusted treasurer, low budget)',
  mid: 'council majority',
  large: 'full DAO vote',
};

export function MandateRow({ m, s }: { m: OnchainMandate; s: import('@/lib/types').Source }) {
  const t = tokenInfo(m.sell_token);
  return (
    <tr>
      <td>#{m.id}</td>
      <td><StatusPill status={m.status} /></td>
      <td>{m.tier}</td>
      <td>{fmtUnits(m.sold, t.decimals)} / {fmtUnits(m.max_sell, t.decimals)} {t.symbol}<Src s={s} /></td>
      <td>{m.chunks}<Src s={s} /></td>
      <td className="mono">{nsToDate(m.start_ns)} → {nsToDate(m.end_ns)}</td>
      <td className="mono">{m.terms_hash.slice(0, 10)}…{m.report_hash ? ` / report ${m.report_hash.slice(0, 8)}…` : ''}</td>
    </tr>
  );
}

export function MandateTable({ list, s }: { list: OnchainMandate[]; s: import('@/lib/types').Source }) {
  if (!list.length) return <div className="state">No mandates on-chain yet.</div>;
  return (
    <div className="card">
      <table>
        <thead><tr><th>ID</th><th>Status</th><th>Tier</th><th>Sold / budget</th><th>Chunks</th><th>Window</th><th>Hashes</th></tr></thead>
        <tbody>{list.map((m) => <MandateRow key={m.id} m={m} s={s} />)}</tbody>
      </table>
    </div>
  );
}

/** Picker that loads mandates and hands the selected one (default: executing, else latest) to children. */
export function WithMandate({ children }: { children: (m: OnchainMandate, s: import('@/lib/types').Source) => React.ReactNode }) {
  const a = useAsync(loadMandates, []);
  const rec = useAsync(getRecordedRun, []);
  const [sel, setSel] = useState<number | null>(null);
  const covered = new Set<number>();
  if (!ENV.worker && !rec.loading && rec.result.ok) {
    if (rec.result.data.mandate) covered.add(rec.result.data.mandate.id);
    if (rec.result.data.cancelRun?.mandate) covered.add(rec.result.data.cancelRun.mandate.id);
  }
  return (
    <View a={a} what="mandates">
      {(list, s) => {
        if (!list.length) return <div className="state">No mandates yet. Create one on the &ldquo;New mandate&rdquo; page{ENV.mandate ? '' : ' (and configure NEXT_PUBLIC_MANDATE_CONTRACT)'}.</div>;
        const def = defaultMandate(list, covered);
        const cur = list.find((m) => m.id === sel) ?? def;
        return (
          <>
            <div className="row" style={{ margin: '8px 0' }}>
              <label htmlFor="msel">Mandate</label>
              <select id="msel" value={cur.id} onChange={(e) => setSel(Number(e.target.value))} style={{ padding: 8, borderRadius: 8 }}>
                {list.map((m) => <option key={m.id} value={m.id}>#{m.id} – {m.status}{m.report_hash ? ' · report anchored' : m.status === 'Cancelled' ? ' · cancelled, no report' : ''}</option>)}
              </select>
              <StatusPill status={cur.status} /><Src s={s} />
            </div>
            {children(cur, s)}
          </>
        );
      }}
    </View>
  );
}

