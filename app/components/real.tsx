'use client';
// Shared views for the committed testnet-real run: explorer links, vault balances, the "What is real here" box and the real-run panel.
// Nothing here invents data: everything comes from app/public/demo-run/run.json (recorded provenance) or from NEAR RPC views (chain).
import { fmtPrice, fmtUnits, explorerTx, getRealRun, getVaultBalances, looksLikeTxHash, type RunTx } from '@/lib/data';
import { Src, Stat, useAsync, View } from './ui';
import { Acct } from './acct';

export function TxLink({ hash, label }: { hash: string; label?: string }) {
  if (!looksLikeTxHash(hash)) return <span className="mono">{hash ? hash.slice(0, 12) + '…' : '-'}</span>;
  return <a className="mono" href={explorerTx(hash)} target="_blank" rel="noreferrer" title={`Open ${hash} in the NEAR explorer`}>{label ?? `${hash.slice(0, 8)}…`} ↗</a>;
}

/** Visible boundary between what is real on the public testnet and what is mainnet-only / unproven. */
export function WhatIsReal() {
  return (
    <div className="card" role="note" aria-label="What is real here">
      <h3 style={{ marginTop: 0 }}>What is real here</h3>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        <div>
          <div className="pill ok">REAL on public NEAR testnet</div>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            <li>Sputnik DAO proposals and 2-of-3 council votes, including the funding transfer and the cancel</li>
            <li>Swaps on Ref Finance testnet (every swap has a transaction hash)</li>
            <li>Payouts, fee and returns of real testnet tokens to named accounts</li>
            <li>Mandate contract state and the report hash anchored on-chain</li>
            <li>NEAR AI Cloud (TEE) parsing and summary, signed and attested</li>
            <li>OutLayer wallet-policy denials (Layer A) on testnet</li>
          </ul>
        </div>
        <div>
          <div className="pill bad">NOT proven (mainnet-only)</div>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            <li>Confidential swaps and hidden trades (NEAR Intents has no testnet)</li>
            <li>OutLayer TEE custody doing the swaps (here a worker-held vault key signs)</li>
            <li>Cross-chain payouts (Solana, Base) through Intents</li>
            <li>The DAO funding the agent&apos;s Intents balance</li>
          </ul>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>Testnet tokens have no value. Not investment advice.</p>
        </div>
      </div>
    </div>
  );
}

const SELL = { symbol: 'wNEAR', decimals: 24 }, BUY = { symbol: 'USDT.e', decimals: 6 };
const toNum = (raw: string, dec: number) => Number(fmtUnits(raw, dec, 12));

/** Vault balances straight from the chain (no worker needed). */
export function VaultBalances({ vault }: { vault: string }) {
  const a = useAsync(() => getVaultBalances(vault), [vault]);
  return (
    <View a={a} what="vault balances">
      {(list, s) => (
        <div className="grid">{list.map((b) => <Stat key={b.symbol} k={`${b.symbol} · vault`} v={fmtUnits(b.amount, b.decimals, 6)} s={s} />)}</div>
      )}
    </View>
  );
}

function TxTable({ txs, caption }: { txs: RunTx[]; caption: string }) {
  if (!txs.length) return null;
  return (
    <details>
      <summary>{caption} ({txs.length})</summary>
      <div className="card"><table>
        <thead><tr><th>Step</th><th>Transaction</th></tr></thead>
        <tbody>{txs.map((t, i) => <tr key={`${i}-${t.txHash}`}><td>{t.label}</td><td><TxLink hash={t.txHash} /></td></tr>)}</tbody>
      </table></div>
    </details>
  );
}

/** Transactions of the recorded run from the first one whose label matches `from` to the end (the cancelled mandate's group). */
export function RunTxRange({ from, caption }: { from: RegExp; caption: string }) {
  const a = useAsync(getRealRun, []);
  if (a.loading || !a.result.ok) return null;
  const txs = a.result.data.txs;
  const i = txs.findIndex((t) => from.test(t.label));
  return i < 0 ? null : <TxTable txs={txs.slice(i)} caption={caption} />;
}

/** Transactions of the recorded run whose label matches (e.g. proposals + votes, or the anchor). */
export function RunTxList({ match, caption }: { match: RegExp; caption: string }) {
  const a = useAsync(getRealRun, []);
  if (a.loading || !a.result.ok) return null;
  return <TxTable txs={a.result.data.txs.filter((t) => match.test(t.label))} caption={caption} />;
}

/** The completed mandate of the run (swaps, payouts, returns, balance deltas, one-shot baseline, all txs). */
export function RealRunPanel({ mandateId, part = 'all' }: { mandateId: number; part?: 'all' | 'comparison' | 'payouts' }) {
  const a = useAsync(getRealRun, []);
  return (
    <View a={a} what="real testnet run">
      {(run) => {
        if (run.mandate?.id !== mandateId) return null;
        const { real } = run;
        const sumOut = real.swaps.reduce((x, y) => x + BigInt(y.out), 0n);
        const one = BigInt(real.oneShot.amountOut);
        const bps = one > 0n ? (Number(sumOut - one) / Number(one)) * 10000 : null;
        const sumIn = real.swaps.reduce((x, y) => x + BigInt(y.in), 0n);
        const p = real.pool.before;
        return (
          <>
            {part !== 'payouts' && (
              <>
                <h2>Chunked vs one-shot <Src s="chain" /></h2>
                <div className="card">
                  <div className="grid">
                    <Stat k={`Chunked: ${BUY.symbol} received (${real.swaps.length} swaps)`} v={fmtUnits(sumOut.toString(), BUY.decimals, 6)} s="chain" />
                    <Stat k={`One-shot baseline: ${BUY.symbol} (same ${fmtUnits(sumIn.toString(), SELL.decimals, 4)} ${SELL.symbol}, pool snapshot)`} v={fmtUnits(real.oneShot.amountOut, BUY.decimals, 6)} s="chain" />
                    <Stat k="Chunked minus one-shot" v={bps === null ? '-' : `${bps >= 0 ? '+' : ''}${fmtPrice(bps, 1)} bps`} s="chain" />
                  </div>
                  <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 0 }}>
                    Honest reading: about {fmtPrice(bps ?? 0, 1)} bp, effectively no difference. A constant-product pool is path independent, and this thin testnet pool has no arbitrageurs refilling it between chunks, so splitting the sale does <strong>not</strong> improve the price here and we do not claim a gain. The one-shot figure is the pool&apos;s own quote at the same moment (Ref pool #{real.oneShot.poolId}, fee {real.oneShot.feeBps / 100}%). Splitting matters when liquidity refills or when the schedule must not be telegraphed; neither is demonstrated by this run.
                  </p>
                </div>
                <h2>Vault and pool <Src s="chain" /></h2>
                <div className="card"><table><tbody>
                  <tr><td>Vault account (holds the budget, signs swaps)</td><td><Acct id={real.vault.accountId} role="vault" /></td></tr>
                  <tr><td>DEX</td><td><Acct id={real.pool.dex} /> pool #{p.poolId} ({p.tokenIn} → {p.tokenOut}), fee {p.feeBps / 100}%</td></tr>
                  <tr><td>Pool reserves before the run</td><td>{fmtUnits(p.reserveIn, SELL.decimals, 4)} {SELL.symbol} / {fmtUnits(p.reserveOut, BUY.decimals, 4)} {BUY.symbol} (spot ≈ {fmtPrice(toNum(p.reserveOut, BUY.decimals) / toNum(p.reserveIn, SELL.decimals), 3)})</td></tr>
                </tbody></table></div>
                <h2>Real swaps <Src s="chain" /></h2>
                <div className="card"><table>
                  <thead><tr><th>#</th><th>Sold ({SELL.symbol})</th><th>Received ({BUY.symbol})</th><th>Price</th><th>Transaction</th></tr></thead>
                  <tbody>{real.swaps.map((w) => (
                    <tr key={w.tx}><td>{w.index}</td><td>{fmtUnits(w.in, SELL.decimals, 4)}</td><td>{fmtUnits(w.out, BUY.decimals, 6)}</td><td>{fmtPrice(toNum(w.out, BUY.decimals) / toNum(w.in, SELL.decimals), 4)}</td><td><TxLink hash={w.tx} /></td></tr>
                  ))}</tbody>
                </table></div>
              </>
            )}
            {part !== 'comparison' && (
              <>
                <h2>Real payouts, fee and returns <Src s="chain" /></h2>
                <div className="card"><table>
                  <thead><tr><th>Kind</th><th>Label</th><th>To</th><th>Amount ({BUY.symbol})</th><th>Status</th><th>Transaction</th></tr></thead>
                  <tbody>{real.payouts.map((x) => (
                    <tr key={x.tx}><td>{x.kind}</td><td>{x.label}</td><td><Acct id={x.to} /></td><td>{fmtUnits(x.amount, BUY.decimals, 6)}</td><td>{x.status}</td><td><TxLink hash={x.tx} /></td></tr>
                  ))}</tbody>
                </table></div>
                <h2>Balance changes checked on-chain <Src s="chain" /></h2>
                <div className="grid">
                  {Object.entries(real.balanceDeltas).map(([k, v]) => <Stat key={k} k={`${k.replace(/Usdt$/, '')} (+${BUY.symbol})`} v={fmtUnits(v, BUY.decimals, 6)} s="chain" />)}
                </div>
              </>
            )}
            {part === 'all' && (
              <>
                <h2>Every transaction in the run</h2>
                <p style={{ color: 'var(--muted)', fontSize: 13 }}>Recorded {run.recordedAt} <Src s="recorded" /> · mode <code>{run.mode}</code> on public {run.network}. Each link opens the NEAR testnet explorer.</p>
                <TxTable txs={run.txs} caption="Show all transactions" />
              </>
            )}
          </>
        );
      }}
    </View>
  );
}
