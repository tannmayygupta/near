'use client';
import { useState } from 'react';
import { PageHead, Src, Stat, useAsync, View } from '@/components/ui';
import { getDryrunRun, getRoutesRun, human, refreshLeg, type RouteLeg, type RouteQuote } from '@/lib/routes';

const when = (s: number) => new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const short = (a: string) => (a.length > 18 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

const STORY: { step: string; what: string; status: 'real' | 'quoted' | 'unproven'; note: string }[] = [
  { step: '1. DAO-approved mandate', what: 'Sputnik DAO vote creates the mandate on our contract; only the DAO can create or cancel it.', status: 'real', note: 'real on public testnet (see Votes, Report)' },
  { step: '2. Non-custodial agent', what: 'The DAO funds a vault by vote; the agent cannot exceed the on-chain budget/window; a DAO cancel switches it off.', status: 'real', note: 'real on public testnet' },
  { step: '3. Price floor on every chunk', what: 'min_amount_out derived from the mandate floor is checked before each swap (Ref Finance on testnet).', status: 'real', note: 'real swaps on testnet; the same floor check runs in live-dryrun against mainnet quotes' },
  { step: '4. Intents routes', what: 'Sell wNEAR for USDC on NEAR, then route each payout to the contributor\'s chain through NEAR Intents.', status: 'quoted', note: 'live 1Click dry quotes below (nothing executed)' },
  { step: '5. Cross-chain settlement', what: 'OutLayer-custody / confidential swap and cross-chain withdraws execute the routes with real funds.', status: 'unproven', note: 'implemented and request-shape tested; NOT proven with real money' },
];

export default function Routes() {
  const a = useAsync(getRoutesRun, []);
  const d = useAsync(getDryrunRun, []);
  const [live, setLive] = useState<Record<string, { quote?: RouteQuote; error?: string }>>({});
  const [busy, setBusy] = useState(false);

  async function refresh(legs: RouteLeg[]) {
    setBusy(true);
    const out: Record<string, { quote?: RouteQuote; error?: string }> = {};
    for (const l of legs) { if (l.needsSwap && l.amountIn !== '0') out[l.id] = await refreshLeg(l); }
    setLive(out); setBusy(false);
  }

  return (
    <>
      <PageHead title="Cross-chain routes" lead="How a DAO-approved sale would settle across chains through NEAR Intents. These are live 1Click DRY quotes on mainnet liquidity: real prices and fees, but nothing is executed." />
      <div className="card" role="note" style={{ borderColor: 'var(--warn, #b7791f)' }}>
        <strong>Dry-run quotes only. Nothing was executed.</strong> No funds were deposited, swapped or withdrawn, and no deposit address was created. Executing these routes
        (NEAR Intents, OutLayer custody, confidential swaps) is implemented but <strong>not proven with real money</strong>. A quote is not a fill: real prices can differ at execution time.
      </div>

      <h2>Where this fits</h2>
      <div className="card"><table>
        <thead><tr><th>Step</th><th>What happens</th><th>Status</th></tr></thead>
        <tbody>{STORY.map((s) => (
          <tr key={s.step}><td>{s.step}</td><td>{s.what}</td>
            <td><span className={`pill ${s.status === 'real' ? 'ok' : s.status === 'quoted' ? '' : 'bad'}`}>{s.status === 'real' ? 'REAL (testnet)' : s.status === 'quoted' ? 'QUOTED (mainnet, dry)' : 'NOT PROVEN'}</span> <span style={{ color: 'var(--muted)', fontSize: 13 }}>{s.note}</span></td></tr>
        ))}</tbody>
      </table></div>

      <h2>Route quotes</h2>
      <View a={a} what="recorded dry-run route quotes">
        {(run, source) => (
          <>
            <div className="grid">
              <Stat k="Recorded" v={run.recordedAt.replace('T', ' ').slice(0, 19) + ' UTC'} s={source} />
              <Stat k="Legs quoted" v={`${run.summary.quoted} of ${run.legs.length}`} s="api" />
              <Stat k="API errors" v={run.summary.errors} s="api" />
              <Stat k="Mode" v={run.mode} />
            </div>
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>Endpoint: <code>{run.endpoint}</code>. Sample mandate: sell {human(run.sampleMandate.sellAmount, 'wNEAR', 2)} wNEAR, then pay {run.sampleMandate.payouts.length} contributors on their own chains.
              Refund/recipient on the NEAR side is an implicit 64-hex account, the account type an OutLayer agent wallet has (a named account such as wrap.near made 1Click answer HTTP 400 &quot;Internal server error&quot; for wNEAR-origin quotes in our probe).</p>
            <div className="card" style={{ overflowX: 'auto' }}>
              <table>
                <thead><tr><th>Leg</th><th>Route</th><th>In</th><th>Quoted out</th><th>Min out</th><th>Withdraw fee</th><th>ETA</th><th>Recipient</th><th>Status</th></tr></thead>
                <tbody>{run.legs.map((l) => {
                  const lv = live[l.id]; const q = lv?.quote ?? l.quote;
                  return (
                    <tr key={l.id}>
                      <td>{l.label}</td>
                      <td>{l.from.symbol} ({l.from.chain}) → {l.to.symbol} ({l.to.chain})</td>
                      <td>{human(l.amountIn, l.from.symbol, 4)} {l.from.symbol}</td>
                      <td>{q ? `${human(q.amountOut, l.to.symbol)} ${l.to.symbol}` : '-'}{q && <Src s="api" />}</td>
                      <td>{q ? human(q.minAmountOut, l.to.symbol) : '-'}</td>
                      <td>{q?.withdrawFee ? `${human(q.withdrawFee, 'USDC')} USDC` : '-'}</td>
                      <td>{q?.timeEstimateS ? `${q.timeEstimateS}s` : '-'}</td>
                      <td className="mono" title={l.recipient}>{short(l.recipient)}</td>
                      <td>
                        {l.error && <span className="pill bad" title={l.error.message}>API {l.error.status}: {l.error.message.slice(0, 60)}</span>}
                        {!l.error && l.skipped && <span className="pill" title={l.skipped}>no swap needed</span>}
                        {!l.error && !l.skipped && <span className="pill ok">{lv?.quote ? `live ${when(lv.quote.fetchedAtS)}` : 'quoted'}</span>}
                        {lv?.error && <div className="mono" style={{ color: 'var(--bad, #c53030)', fontSize: 12 }}>refresh: {lv.error}</div>}
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <button onClick={() => refresh(run.legs)} disabled={busy}>{busy ? 'Requesting live dry quotes…' : 'Refresh live (dry quotes from your browser)'}</button>
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>If your browser blocks the request or the API rate-limits, the error is shown and the recorded quotes stay.</span>
            </div>
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>{run.honesty}</p>
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>Note the Ethereum leg: a 0.30 USDC withdraw fee on a small amount is visible, not hidden. It is why small payouts are better routed to cheaper chains.</p>
          </>
        )}
      </View>

      <h2>Live executor path without funds (EXEC_MODE=live-dryrun)</h2>
      <div className="card">
        <p>The worker can run the <em>live</em> decision path against mainnet liquidity with every money-moving call blocked: it plans the next chunk, takes a real 1Click dry quote, applies the mandate price floor, and logs the exact OutLayer request
          (<code>POST /wallet/v1/confidential/swap</code> with body and <code>X-Idempotency-Key</code>) that it <em>would</em> send. It builds that request with the same client code the live executor uses, but its fetch is a recorder, so nothing leaves the process and nothing is written on chain.
          Unit tests assert that no money-moving endpoint is ever called. See <code>worker/adapters/live-dryrun.ts</code> and <code>tests/routes.test.ts</code>.</p>
      </div>
      <View a={d} what="recorded live-dryrun decisions">
        {(run, source) => (
          <>
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>Recorded {run.recordedAt.replace('T', ' ').slice(0, 19)} UTC <Src s={source} />: the same sample sale against live mainnet quotes, once with a price floor below the market and once above it.</p>
            <div className="card" style={{ overflowX: 'auto' }}><table>
              <thead><tr><th>Case</th><th>Chunk</th><th>Quoted out</th><th>Floor (min out)</th><th>Decision</th></tr></thead>
              <tbody>{run.decisions.map((x) => (
                <tr key={x.label}>
                  <td>{x.label}<div className="mono" style={{ fontSize: 12 }}>floor price {x.floorPrice} USDC / wNEAR</div></td>
                  <td>{x.plan.size ? `${(Number(BigInt(x.plan.size)) / 1e24).toFixed(3)} wNEAR` : x.plan.kind}</td>
                  <td>{x.quote?.amount_out ? `${human(x.quote.amount_out, 'USDC')} USDC` : '-'}<Src s="api" /></td>
                  <td>{x.minAmountOut ? `${human(x.minAmountOut, 'USDC')} USDC` : '-'}</td>
                  <td><span className={`pill ${x.floorOk ? 'ok' : 'bad'}`}>{x.floorOk ? 'would swap (blocked)' : 'would refuse'}</span>
                    {x.wouldSend && <pre style={{ marginTop: 6, fontSize: 11.5, whiteSpace: 'pre-wrap' }}>{`${x.wouldSend.method} ${x.wouldSend.url}\n${JSON.stringify({ ...x.wouldSend.headers }, null, 1)}\n${JSON.stringify(x.wouldSend.body, null, 1)}`}</pre>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </>
        )}
      </View>
    </>
  );
}
