'use client';
import { useEffect, useState } from 'react';
import { asset, RPC } from '@/lib/data';
import { recomputeRun, rpcChain, type BundleFile, type Check, type RunFile } from '@/lib/recompute';
import { PageHead, Src } from '@/components/ui';

const RUNS = [
  { key: 'custody', label: 'OutLayer custody run (vault = an OutLayer wallet)', run: '/demo-run/custody-run.json', bundle: '/demo-run/custody-proof-bundle.json' },
  { key: 'real', label: 'Key-held vault run', run: '/demo-run/run.json', bundle: '/demo-run/proof-bundle.json' },
  { key: 'sealed', label: 'Sealed mandate run (terms revealed at settlement)', run: '/demo-run/sealed-run.json', bundle: '/demo-run/sealed-proof-bundle.json' },
  { key: 'restart', label: 'Crash-restart run', run: '/demo-run/restart-run.json', bundle: null },
] as const;

export default function Recompute() {
  const [key, setKey] = useState<(typeof RUNS)[number]['key']>('custody');
  const [state, setState] = useState<{ busy: boolean; checks: Check[]; error: string | null; ranFor: string | null }>({ busy: false, checks: [], error: null, ranFor: null });
  async function go(pick: (typeof RUNS)[number]['key'] = key) {
    const r = RUNS.find((x) => x.key === pick)!;
    setState({ busy: true, checks: [], error: null, ranFor: null });
    try {
      const run = (await (await fetch(asset(r.run), { cache: 'no-store' })).json()) as RunFile;
      const bundle: BundleFile | null = r.bundle ? await fetch(asset(r.bundle), { cache: 'no-store' }).then((x) => (x.ok ? x.json() : null)).catch(() => null) : null;
      const checks = await recomputeRun(run, bundle, rpcChain(['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org', RPC.testnet]) /* archival first: ordinary RPC nodes forget transactions after ~2 days */);
      setState({ busy: false, checks, error: null, ranFor: r.label });
    } catch (e) { setState({ busy: false, checks: [], error: (e as Error).message, ranFor: null }); }
  }
  // shareable: /recompute?run=custody&auto=1 opens the page and runs it
  useEffect(() => {
    const q = new URLSearchParams(window.location.search); const want = RUNS.find((r) => r.key === q.get('run'));
    if (want) { setKey(want.key); if (q.get('auto') === '1') void go(want.key); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const failed = state.checks.filter((c) => !c.ok).length;
  return (
    <>
      <PageHead title="Recompute a run in your browser" lead="Do not trust this site's JSON or our worker. This page reads the mandate from the contract, fetches every chunk and the completion as transactions from public NEAR RPC, and re-derives the hashes, sums and price floors itself." />
      <div className="card">
        <label htmlFor="run-pick" className="sr">Recorded run</label>
        <div className="row">
          <select id="run-pick" value={key} onChange={(e) => setKey(e.target.value as typeof key)}>{RUNS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select>
          <button className="primary" onClick={() => go()} disabled={state.busy}>{state.busy ? 'Recomputing from the chain…' : 'Recompute in my browser'}</button>
          <Src s="chain" />
        </div>
      </div>
      {state.error && <div className="state" role="alert"><strong>Could not finish.</strong> {state.error}</div>}
      {state.checks.length > 0 && (
        <>
          <div className="card" role="status" style={{ marginTop: 12 }}>
            {failed === 0 ? <span className="pill ok">{state.checks.length} of {state.checks.length} checks recomputed and agree</span> : <span className="pill bad">{failed} of {state.checks.length} checks DISAGREE</span>} <span style={{ color: 'var(--muted)' }}>for: {state.ranFor}</span>
          </div>
          <div className="card" style={{ marginTop: 12 }}>
            <table><thead><tr><th>Check</th><th>Chain / run file says</th><th>Your browser got</th><th /></tr></thead><tbody>
              {state.checks.map((c, i) => <tr key={i}><td>{c.name}</td><td className="mono">{c.logged}</td><td className="mono">{c.recomputed}</td><td><span className={`pill ${c.ok ? 'ok' : 'bad'}`}>{c.ok ? 'agree' : 'DISAGREE'}</span></td></tr>)}
            </tbody></table>
          </div>
        </>
      )}
      <h2>What this proves, and what it does not</h2>
      <div className="card" role="note"><ul style={{ margin: 0, paddingLeft: 18 }}>
        <li>It proves the run file and the chain agree: the chunks were recorded by the agent key on the mandate contract, they add up to what the contract says was sold, no swap was below the mandate&rsquo;s price floor, and the anchored report hash is the hash of the report we show.</li>
        <li>It does <strong>not</strong> prove the swaps themselves happened at the prices shown (open the swap transactions on the explorer for that), that the AI summary is honest, or anything about mainnet: nothing here ran on mainnet.</li>
        <li>The same recomputation, with tamper cases that must fail, is unit-tested (<span className="mono">tests/recompute.test.ts</span>).</li>
      </ul></div>
    </>
  );
}
