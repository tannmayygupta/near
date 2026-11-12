'use client';
import { useCallback } from 'react';
import { getBalances, getChunksFor, getRealRun, getRecordedFor, fmtPrice, fmtUnits, looksLikeTxHash, withRecordedFallback } from '@/lib/data';
import { PageHead, Src, Stat, StatusPill, useAsync, useTick, View } from '@/components/ui';
import { WithMandate, parseTerms, tokenInfo } from '@/components/mandates';
import { RealRunPanel, RunTxRange, TxLink, VaultBalances, WhatIsReal } from '@/components/real';
import type { OnchainMandate, Source } from '@/lib/types';
import { BOUNDS } from '@/lib/types';

function CancelRecord({ id }: { id: number }) {
  const rec = useAsync(() => getRecordedFor(id), [id]);
  if (rec.loading || !rec.result.ok || rec.result.data.kind !== 'cancelled') return null;
  const items = rec.result.data.items;
  return (
    <>
      <h2>Cancel record <Src s="recorded" /></h2>
      <div className="card">
        <p style={{ marginTop: 0 }}>This mandate was cancelled by a DAO vote. The worker stopped, settled the chunks already done, and returned the rest to the DAO (no payouts, no fee).</p>
        {items.length === 0 ? <div className="state">No settlement items were recorded.</div> : (
          <table>
            <thead><tr><th>Step</th><th>Status</th><th>Amount</th><th>Note</th></tr></thead>
            <tbody>{items.map((it, i) => (
              <tr key={i}><td>{it.key ?? it.kind ?? '-'}</td><td>{it.status ?? '-'}</td><td className="mono">{it.amount ?? '-'}</td><td>{it.note ?? it.to ?? ''}</td></tr>
            ))}</tbody>
          </table>
        )}
        <RunTxRange from={/create_mandate #2/} caption="Every transaction of this cancelled run (proposals, votes, swaps, real returns)" />
      </div>
    </>
  );
}

function Run({ m, s }: { m: OnchainMandate; s: Source }) {
  const chunks = useAsync(() => getChunksFor(m.id), [m.id]);
  const bal = useAsync(() => withRecordedFallback(getBalances(), (r) => r.balances), []);
  const run = useAsync(getRealRun, []); // present only when the committed run is a testnet-real run: then the vault's balances are read from the chain
  const vault = !run.loading && run.result.ok ? run.result.data.real.vault.accountId : null;
  const refresh = useCallback(() => { chunks.reload(); bal.reload(); }, [chunks, bal]);
  useTick(10000, m.status === 'Executing' || m.status === 'Funded', refresh);
  const sell = tokenInfo(m.sell_token);
  const terms = parseTerms(m);
  const buy = tokenInfo((terms?.buyToken as string | undefined) ?? 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1');
  const floor = terms?.minPrice as string | undefined;
  const pct = BigInt(m.max_sell) > 0n ? Number((BigInt(m.sold) * 10000n) / BigInt(m.max_sell)) / 100 : 0;
  return (
    <>
      <div className="grid">
        <Stat k="Status" v={<StatusPill status={m.status} />} s={s} />
        <Stat k={`Sold (${sell.symbol})`} v={`${fmtUnits(m.sold, sell.decimals)} / ${fmtUnits(m.max_sell, sell.decimals)}`} s={s} />
        <Stat k="Progress" v={`${fmtPrice(pct, 2)}%`} s={s} />
        <Stat k="Chunks recorded on-chain" v={m.chunks} s={s} />
        <Stat k={`Price floor (${buy.symbol} per ${sell.symbol})`} v={floor ? fmtPrice(floor) : terms ? '-' : 'sealed'} s={terms ? s : undefined} />
      </div>
      <h2>Chunks</h2>
      <View a={chunks} what="chunk timeline">
        {(list, cs) => list.length === 0 ? (
          <div className="state">
            {m.chunks > 0
              ? `The chain recorded ${m.chunks} chunk(s) for mandate #${m.id}, but their per-chunk fills are not in the worker database or the committed recorded run, so they cannot be shown here.`
              : m.status === 'Cancelled' ? 'No chunks were executed before this mandate was cancelled.' : 'No chunks executed yet.'}
          </div>
        ) : (
          <div className="card"><table>
            <thead><tr><th>#</th><th>Time</th><th>Sold ({sell.symbol})</th><th>Received ({buy.symbol})</th><th>Price</th><th>Benchmark</th><th>Floor</th><th>Status</th><th>Request</th></tr></thead>
            <tbody>
              {list.map((c) => {
                const okFloor = floor && c.price ? Number(c.price) >= Number(floor) : null;
                return (
                  <tr key={c.index}>
                    <td>{c.index}</td><td className="mono">{c.ts}</td>
                    <td>{fmtUnits(c.sellAmount, sell.decimals)}<Src s={cs} /></td>
                    <td>{c.buyAmount ? fmtUnits(c.buyAmount, buy.decimals) : '-'}<Src s={cs} /></td>
                    <td>{fmtPrice(c.price)}</td><td>{fmtPrice(c.benchmarkPrice)}</td>
                    <td>{okFloor === null ? '-' : okFloor ? <span className="pill ok">≥ floor</span> : <span className="pill bad">below floor</span>}</td>
                    <td><StatusPill status={c.status} /></td>
                    <td>{c.requestId ? (looksLikeTxHash(c.requestId) ? <TxLink hash={c.requestId} /> : <span className="mono">{c.requestId.slice(0, 12)}…{c.requestId.startsWith('sim-') && <> <Src s="simulated" /></>}</span>) : '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </View>
      <RealRunPanel mandateId={m.id} part="payouts" />
      <CancelRecord id={m.id} />
      <h2>{vault ? 'Vault balances (read from the chain)' : 'Agent balances'}</h2>
      {vault ? <VaultBalances vault={vault} /> : (
        <View a={bal} what="balances">
          {(b, bs) => b.length === 0 ? <div className="state">No balances reported.</div> : (
            <div className="grid">{b.map((x, i) => <Stat key={i} k={`${x.symbol} · ${x.where}`} v={fmtUnits(x.amount, BOUNDS.allowedTokens[x.token]?.decimals ?? 0)} s={bs} />)}</div>
          )}
        </View>
      )}
      <WhatIsReal />
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>Auto-refreshes every 10 s while the mandate is funded or executing.</p>
    </>
  );
}

export default function Live() {
  return (
    <>
      <PageHead title="Live run" lead="The agent’s progress. Sold amounts and the chunk counter come from the mandate contract; per-chunk fills come from the agent’s receipts (or the committed recorded run, labelled)." />
      <WithMandate>{(m, s) => <Run m={m} s={s} />}</WithMandate>
    </>
  );
}
