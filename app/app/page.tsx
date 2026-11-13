'use client';
import { ENV, getBalances, getDaoPolicy, getRealRun, withRecordedFallback } from '@/lib/data';
import { VaultBalances, WhatIsReal } from '@/components/real';
import { PageHead, Src, Stat, useAsync, View } from '@/components/ui';
import { Acct } from '@/components/acct';
import { MandateTable, loadMandates, TIER_RULES } from '@/components/mandates';
import { BOUNDS, type Balances } from '@/lib/types';
import { fmtUnits } from '@/lib/data';
import { StartHere } from '@/components/start-here';

function Config() {
  const rows: [string, string][] = [
    ['Worker API', ENV.worker], ['DAO account', ENV.dao], ['Mandate contract', ENV.mandate], ['Agent wallet', ENV.agent],
  ];
  return (
    <div className="card">
      <table><tbody>
        {rows.map(([k, v]) => (
          <tr key={k}><td>{k}</td><td>{!v ? (k === 'Worker API' ? <span className="pill warn" title="Wizard parsing and live red-team attacks need the worker">none: hosted demo (run locally for the worker)</span> : <span className="pill bad">not configured</span>) : k === 'Worker API' ? <span className="mono">{v}</span> : <Acct id={v} role={k === 'DAO account' ? 'sputnik dao' : k === 'Agent wallet' ? 'agent' : 'contract'} />}</td></tr>
        ))}
        <tr><td>Network</td><td><span className="pill">{ENV.network}</span></td></tr>
      </tbody></table>
    </div>
  );
}

function BalancesCard({ b, s }: { b: Balances; s: import('@/lib/types').Source }) {
  if (!b.length) return <div className="state">Wallet reports no balances.</div>;
  return (
    <div className="grid">
      {b.map((x, i) => (
        <Stat key={i} k={`${x.symbol} · ${x.where}`} v={fmtUnits(x.amount, BOUNDS.allowedTokens[x.token]?.decimals ?? 0)} s={s} />
      ))}
    </div>
  );
}

export default function Page() {
  const mandates = useAsync(loadMandates, []);
  const policy = useAsync(getDaoPolicy, []);
  const balances = useAsync(() => withRecordedFallback(getBalances(), (r) => r.balances), []);
  const run = useAsync(getRealRun, []);
  const vault = !run.loading && run.result.ok ? run.result.data.real.vault.accountId : null;
  return (
    <>
      <PageHead title="Treasury overview" lead="A DAO votes once on a plain-English mandate. An agent executes it in chunks, stays inside the mandate, and posts a verifiable settlement report. The execution shown here is real on the public NEAR testnet; the confidential, mainnet-only parts are marked as not proven." />
      <StartHere />
      <WhatIsReal />
      <h2>Connection</h2>
      <Config />
      <h2>{vault ? 'Vault balances (read from the chain)' : 'Agent balances'}</h2>
      {vault ? <VaultBalances vault={vault} /> : <View a={balances} what="balances">{(b, s) => <BalancesCard b={b} s={s} />}</View>}
      <h2>Mandates</h2>
      <View a={mandates} what="mandates">{(list, s) => <MandateTable list={list} s={s} />}</View>
      <h2>Approval tiers <span className="tag chain">design</span></h2>
      <div className="card"><table><tbody>
        {Object.entries(TIER_RULES).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}
      </tbody></table></div>
      <h2>DAO policy</h2>
      <View a={policy} what="DAO policy">{(p, s) => <div className="card"><div>On-chain policy <Src s={s} /></div><pre>{JSON.stringify(p, null, 2)}</pre></div>}</View>
    </>
  );
}

