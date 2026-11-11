'use client';
import { ENV, getChunks, getPublicTxns, viewAccountExists, withRecordedFallback } from '@/lib/data';
import { PageHead, Src, Stat, useAsync, View } from '@/components/ui';

export default function Copycat() {
  const shard = useAsync(() => viewAccountExists('intents.far', 'mainnet'), []);
  const pub = useAsync(() => getPublicTxns(ENV.agent), []);
  const chunks = useAsync(() => withRecordedFallback(getChunks(0), (r) => r.chunks), []);
  return (
    <>
      <PageHead title="Copycat view" lead="What a public observer can learn about the sale, next to what the agent actually did. Privacy here means: no public trace of the trades inside the confidential shard. Entry and exit transfers are public." />
      <div className="split">
        <section>
          <h2>What the public sees</h2>
          <h3 style={{ fontSize: 15 }}>1 · Can anyone read the private shard?</h3>
          <View a={shard} what="public RPC check">
            {(r, s) => (
              <div className="card">
                <div>Public mainnet RPC, <code>view_account intents.far</code><Src s={s} /></div>
                <div style={{ marginTop: 8 }}>{r.exists ? <span className="pill bad">account visible on the public chain</span> : <span className="pill ok">{r.raw}</span>}</div>
                <p style={{ color: 'var(--muted)', fontSize: 13 }}>Expected: UNKNOWN_ACCOUNT, because the confidential shard has no public RPC. Caveat: its operator and the swap solvers can read it.</p>
              </div>
            )}
          </View>
          <h3 style={{ fontSize: 15 }}>2 · Public transactions of the agent wallet</h3>
          <View a={pub} what="agent public transactions">
            {(txs, s) => {
              const swapLike = txs.filter((t) => /swap|trade|exchange/i.test(t.method ?? ''));
              return (
                <>
                  <div className="grid">
                    <Stat k="Public transactions found" v={txs.length} s={s} />
                    <Stat k="Swap-like calls a copycat can see" v={swapLike.length} s={s} />
                  </div>
                  {txs.length === 0 ? <div className="state">Nothing public yet for this wallet.</div> : (
                    <div className="card"><table><thead><tr><th>Tx</th><th>Method</th><th>Receiver</th></tr></thead><tbody>
                      {txs.map((t) => <tr key={t.hash}><td className="mono">{t.hash.slice(0, 12)}…</td><td>{t.method ?? t.action ?? '-'}</td><td className="mono">{t.receiver}</td></tr>)}
                    </tbody></table></div>
                  )}
                </>
              );
            }}
          </View>
        </section>
        <section>
          <h2>What actually happened</h2>
          <View a={chunks} what="agent receipts">
            {(list, s) => (
              <>
                <div className="grid">
                  <Stat k="Chunks the agent executed" v={list.filter((c) => c.status === 'success').length} s={s} />
                  <Stat k="Chunks attempted" v={list.length} s={s} />
                </div>
                <p style={{ color: 'var(--muted)', fontSize: 13 }}>The agent’s own receipts are the only complete record of the in-shard trades. Compare this count with the public one on the left.</p>
              </>
            )}
          </View>
          <div className="card"><strong>Honest limits</strong><ul style={{ margin: '6px 0 0 18px' }}>
            <li>The DAO’s funding transfer is public (use routine top-ups to avoid signalling a specific sale).</li>
            <li>The exit/payout transfers are public on their destination chains.</li>
            <li>Swap solvers see swap details before execution; the shard operator can read the shard.</li>
          </ul></div>
        </section>
      </div>
    </>
  );
}
