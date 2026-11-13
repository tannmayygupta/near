'use client';
import { explorerTx, fmtUnits } from '@/lib/data';
import { getCustodyRun, getFindings, getRestartRun, type CustodyRun, type Findings, type RestartRun } from '@/lib/custody';
import { PageHead, Src, Stat, useAsync, View } from '@/components/ui';
import { TxLink } from '@/components/real';

const pill = (ok: boolean, yes = 'pass', no = 'FAIL') => <span className={`pill ${ok ? 'ok' : 'bad'}`}>{ok ? yes : no}</span>;
const nearOf = (y: string) => (Number(BigInt(y) / 10n ** 20n) / 10_000).toString();

function CustodyBody({ run }: { run: CustodyRun }) {
  const passed = run.results.filter((r) => r.ok).length;
  const aRows = run.redteam.filter((r) => r.layer.startsWith('A'));
  return (
    <>
      <div className="grid">
        <Stat k="Vault" v="OutLayer agent wallet" s="recorded" />
        <Stat k="Run checks passed" v={`${passed}/${run.results.length}`} s="recorded" />
        <Stat k="Policies written by the worker" v={run.layerA.policies.length} s="recorded" />
        <Stat k="Real denials from OutLayer (403)" v={aRows.length + run.layerA.probes.filter((p) => p.blocked).length} s="recorded" />
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>Recorded {new Date(run.recordedAt).toUTCString()} on public NEAR {run.network}. Wallet <a className="mono" href={run.layerA.wallet.explorer} target="_blank" rel="noreferrer">{run.layerA.wallet.address.slice(0, 16)}… ↗</a></p>

      <h2>1. The DAO funds an OutLayer wallet, not a key the worker holds</h2>
      <p className="lead">The vault is an OutLayer agent wallet. Its signing key lives in OutLayer&rsquo;s TEE. The worker holds only an owner credential that can ask the wallet to act and write its policy. The swaps, wraps, payouts and returns below were signed by that wallet through OutLayer&rsquo;s API.</p>
      <div className="card">
        <div className="row" style={{ marginBottom: 6 }}><strong>Swaps signed by the OutLayer wallet (Ref Finance testnet)</strong><Src s="chain" /></div>
        <table><thead><tr><th>#</th><th>sold</th><th>received</th><th>tx</th></tr></thead><tbody>
          {run.real.swaps.map((s) => <tr key={s.tx}><td>{s.index}</td><td>{fmtUnits(s.in, 24, 4)} wNEAR</td><td>{fmtUnits(s.out, 6, 4)} USDT.e</td><td><TxLink hash={s.tx} /></td></tr>)}
        </tbody></table>
        <div className="row" style={{ margin: '10px 0 6px' }}><strong>Payouts, fee and returns</strong><Src s="chain" /></div>
        <table><thead><tr><th>kind</th><th>to</th><th>amount</th><th>status</th><th>tx</th></tr></thead><tbody>
          {run.real.payouts.map((p) => <tr key={p.tx ?? p.label}><td>{p.kind}: {p.label}</td><td className="mono">{p.to}</td><td>{p.kind === 'return_sell' ? `${fmtUnits(p.amount, 24, 4)} NEAR` : `${fmtUnits(p.amount, 6, 4)} USDT.e`}</td><td>{pill(p.status === 'success', p.status, p.status)}</td><td>{p.tx ? <TxLink hash={p.tx} /> : '-'}</td></tr>)}
        </tbody></table>
      </div>

      <h2>2. The worker writes a wallet policy per mandate (Layer A)</h2>
      <p className="lead">Before a mandate may trade, the worker derives a policy from the DAO-approved terms: only the contracts the trade needs, the DAO, and exactly the approved payout and fee accounts; native NEAR capped at the mandate budget. OutLayer stores it encrypted on <span className="mono">outlayer.testnet</span>.</p>
      {run.layerA.policies.map((p) => (
        <div className="card" key={p.storeTx}>
          <div className="row" style={{ marginBottom: 6 }}><strong>Mandate #{p.mandate}</strong><Src s="chain" /><TxLink hash={p.storeTx} /></div>
          <table><tbody>
            <tr><td>allowed transaction types</td><td className="mono">{p.rules.transaction_types.join(', ')}</td></tr>
            <tr><td>allowed destinations ({p.rules.addresses.list.length})</td><td className="mono">{p.rules.addresses.list.join(', ')}</td></tr>
            <tr><td>native NEAR per transaction</td><td className="mono">{nearOf(p.rules.limits.per_transaction.native)} NEAR (the mandate budget)</td></tr>
            <tr><td>rate limit</td><td className="mono">{p.rules.rate_limit.max_per_hour} per hour</td></tr>
          </tbody></table>
        </div>
      ))}

      {run.protocolScope && (
        <>
          <h2>Layer 0: the NEAR protocol scopes the worker&rsquo;s key</h2>
          <p className="lead">The key the worker uses to drive the mandate contract is a function-call access key, not a full-access key: it can call only {run.protocolScope.key.methods.length} methods on one contract, with no deposit. The NEAR protocol refuses anything else before any contract code runs.</p>
          <div className="card">
            <div className="row" style={{ marginBottom: 6 }}><strong>Key {run.protocolScope.key.publicKey.slice(0, 20)}…</strong><Src s="chain" />{run.protocolScope.key.addTx && <TxLink hash={run.protocolScope.key.addTx} />}</div>
            <table><tbody>
              <tr><td>receiver</td><td className="mono">{run.protocolScope.key.receiver}</td></tr>
              <tr><td>methods</td><td className="mono">{run.protocolScope.key.methods.join(', ')}</td></tr>
              <tr><td>allowance</td><td className="mono">{run.protocolScope.key.allowanceNear} NEAR (gas only)</td></tr>
            </tbody></table>
            <table style={{ marginTop: 8 }}><thead><tr><th>Attempt with that key</th><th>Result</th><th>NEAR answered</th></tr></thead><tbody>
              {run.protocolScope.probes.map((p, i) => <tr key={i}><td>{p.name}</td><td>{pill(p.ok, p.result, 'UNEXPECTED')}</td><td className="mono">{p.detail.slice(0, 110)}</td></tr>)}
            </tbody></table>
          </div>
        </>
      )}
      <h2>3. Attacks against the live wallet</h2>
      <div className="card">
        <div className="row" style={{ marginBottom: 6 }}><strong>Refused by OutLayer before signing</strong><Src s="recorded" /></div>
        <table><tbody>
          {run.layerA.probes.map((p, i) => <tr key={i}><td>{p.name}</td><td>{pill(p.blocked, `blocked (${p.status})`, 'NOT BLOCKED')}</td><td className="mono">{p.detail.slice(0, 150)}</td></tr>)}
          {aRows.map((r, i) => <tr key={`rt${i}`}><td>red team: {r.attack}</td><td>{pill(r.blocked, 'blocked', 'NOT BLOCKED')}</td><td className="mono">{String(r.error).slice(0, 150)}</td></tr>)}
        </tbody></table>
      </div>

      <details style={{ marginTop: 16 }}>
        <summary>All {run.results.length} checks of this run ({passed} pass)</summary>
        <div className="card"><table><tbody>{run.results.map((r, i) => <tr key={i}><td>{i + 1}. {r.name}</td><td>{pill(r.ok, 'ok', 'FAIL')}</td><td className="mono">{r.note ?? ''}</td></tr>)}</tbody></table></div>
      </details>
    </>
  );
}

function RestartBody({ run }: { run: RestartRun }) {
  const passed = run.results.filter((r) => r.ok).length;
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 6 }}>{pill(passed === run.results.length, `${passed}/${run.results.length} checks pass`, 'checks failing')}<Src s="recorded" /><span style={{ color: 'var(--muted)', fontSize: 13 }}>mandate #{run.mandateId}, recorded {new Date(run.recordedAt).toUTCString()}</span></div>
      <p style={{ margin: '4px 0 8px' }}>A real swap landed on chain ({run.crash.swapTx ? <a className="mono" href={explorerTx(run.crash.swapTx)} target="_blank" rel="noreferrer">{run.crash.swapTx.slice(0, 10)}… ↗</a> : '-'}) and the worker was killed before it could record it. A new worker started from the same files and finished the mandate.</p>
      <table><tbody>{run.results.map((r, i) => <tr key={i}><td>{r.name}</td><td>{pill(r.ok, 'ok', 'FAIL')}</td><td className="mono">{r.note ?? ''}</td></tr>)}</tbody></table>
    </div>
  );
}

function FindingsBody({ f }: { f: Findings }) {
  return (
    <div className="card">
      <p style={{ marginTop: 0 }}>{f.what}</p>
      <table><thead><tr><th>#</th><th>result</th><th>what we observed</th></tr></thead><tbody>
        {f.findings.map((x) => (
          <tr key={x.id}>
            <td>{x.id}</td>
            <td><span className={`pill ${x.result.startsWith('NOT') ? 'warn' : 'ok'}`}>{x.result}</span></td>
            <td>{x.claim}{x.consequence && <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>{x.consequence}</div>}</td>
          </tr>
        ))}
      </tbody></table>
    </div>
  );
}

export default function Custody() {
  const a = useAsync(getCustodyRun, []);
  const b = useAsync(getRestartRun, []);
  const c = useAsync(getFindings, []);
  return (
    <>
      <PageHead title="OutLayer custody" lead="On testnet the vault is an OutLayer agent wallet: its key is in OutLayer's TEE and every call is checked by a policy the worker writes for each mandate. Below: the recorded run, a live crash-restart, and what OutLayer's policy does and does not enforce." />
      <View a={a} what="the recorded custody run">{(run) => <CustodyBody run={run} />}</View>
      <h2>Crash-restart on testnet</h2>
      <p className="lead">Autonomous means it survives a crash. The worker is killed right after a real swap landed; a new worker must not swap that chunk twice.</p>
      <View a={b} what="the recorded crash-restart run">{(run) => <RestartBody run={run} />}</View>
      <h2>What OutLayer&rsquo;s policy enforces (probed, including what it does not)</h2>
      <View a={c} what="the OutLayer policy findings">{(f) => <FindingsBody f={f} />}</View>
      <h2>Honest limits</h2>
      <div className="card" role="note"><ul style={{ margin: 0, paddingLeft: 18 }}>
        <li>Testnet has no hidden execution: the wallet key is in OutLayer&rsquo;s TEE, but swaps and payouts are public testnet transactions.</li>
        <li>OutLayer holds governance keys for its TEE; we do not claim to remove that trust.</li>
        <li>Token amount caps in the OutLayer policy were not enforced in our probes; amounts are bounded by the executor guards and the mandate contract.</li>
        <li>Mainnet behaviour (confidential swaps, Intents payouts) is not proven.</li>
      </ul></div>
    </>
  );
}
