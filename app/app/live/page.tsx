'use client';
import { useCallback } from 'react';
import { getBalances, getChunks, fmtUnits, withRecordedFallback } from '@/lib/data';
import { PageHead, Src, Stat, StatusPill, useAsync, useTick, View } from '@/components/ui';
import { WithMandate, parseTerms, tokenInfo } from '@/components/mandates';
import type { OnchainMandate } from '@/lib/types';
import { BOUNDS } from '@/lib/types';

function Run({ m, s }: { m: OnchainMandate; s: 'chain' | 'api' | 'recorded' }) {
  const chunks = useAsync(() => withRecordedFallback(getChunks(m.id), (r) => r.chunks), [m.id]);
  const bal = useAsync(() => withRecordedFallback(getBalances(), (r) => r.balances), []);
  const refresh = useCallback(() => { chunks.reload(); bal.reload(); }, [chunks, bal]);
  useTick(10000, m.status === 'Executing' || m.status === 'Funded', refresh);
  const sell = tokenInfo(m.sell_token);
  const terms = parseTerms(m);
  const floor = terms?.minPrice as string | undefined;
  const pct = BigInt(m.max_sell) > 0n ? Number((BigInt(m.sold) * 10000n) / BigInt(m.max_sell)) / 100 : 0;
  return (
    <>
      <div className="grid">
        <Stat k="Status" v={<StatusPill status={m.status} />} s={s} />
        <Stat k={`Sold (${sell.symbol})`} v={`${fmtUnits(m.sold, sell.decimals)} / ${fmtUnits(m.max_sell, sell.decimals)}`} s={s} />
        <Stat k="Progress" v={`${pct}%`} s={s} />
        <Stat k="Chunks recorded on-chain" v={m.chunks} s={s} />
        <Stat k="Price floor" v={floor ?? (terms ? '-' : 'sealed')} s={terms ? s : undefined} />
      </div>
      <h2>Chunks</h2>
      <View a={chunks} what="chunk timeline">
        {(list, cs) => list.length === 0 ? <div className="state">No chunks executed yet.</div> : (
          <div className="card"><table>
            <thead><tr><th>#</th><th>Time</th><th>Sold</th><th>Received</th><th>Price</th><th>Benchmark</th><th>Floor</th><th>Status</th><th>Request</th></tr></thead>
            <tbody>
              {list.map((c) => {
                const okFloor = floor && c.price ? Number(c.price) >= Number(floor) : null;
                return (
                  <tr key={c.index}>
                    <td>{c.index}</td><td className="mono">{c.ts}</td>
                    <td>{fmtUnits(c.sellAmount, sell.decimals)}<Src s={cs} /></td>
                    <td>{c.buyAmount ? fmtUnits(c.buyAmount, 6) : '-'}<Src s={cs} /></td>
                    <td>{c.price ?? '-'}</td><td>{c.benchmarkPrice ?? '-'}</td>
                    <td>{okFloor === null ? '-' : okFloor ? <span className="pill ok">≥ floor</span> : <span className="pill bad">below floor</span>}</td>
                    <td><StatusPill status={c.status} /></td>
                    <td className="mono">{c.requestId ? c.requestId.slice(0, 12) + '…' : '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </View>
      <h2>Agent balances</h2>
      <View a={bal} what="balances">
        {(b, bs) => b.length === 0 ? <div className="state">No balances reported.</div> : (
          <div className="grid">{b.map((x, i) => <Stat key={i} k={`${x.symbol} · ${x.where}`} v={fmtUnits(x.amount, BOUNDS.allowedTokens[x.token]?.decimals ?? 0)} s={bs} />)}</div>
        )}
      </View>
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>Auto-refreshes every 10 s while the mandate is funded or executing.</p>
    </>
  );
}

export default function Live() {
  return (
    <>
      <PageHead title="Live run" lead="The agent’s progress. Sold amounts and the chunk counter come from the mandate contract; per-chunk fills come from the agent’s receipts." />
      <WithMandate>{(m, s) => <Run m={m} s={s} />}</WithMandate>
    </>
  );
}
