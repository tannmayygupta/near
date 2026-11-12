'use client';
import { useEffect, useState } from 'react';
import { asset, ENV, explorerTx, fmtUnits } from '@/lib/data';
import { getLiveSealedMandate, getSealedRun, KEY_TX_PATTERNS, commitOf, parseReveal, type Reveal, type SealedRun } from '@/lib/sealed';
import { PageHead, Src, Stat, StatusPill, useAsync, View } from '@/components/ui';
import { TxLink } from '@/components/real';
import type { OnchainMandate } from '@/lib/types';

const WNEAR = 24, USDT = 6;
const num = (raw: string, d: number) => Number(BigInt(raw)) / 10 ** d;
const pill = (ok: boolean, yes = 'pass', no = 'FAIL') => <span className={`pill ${ok ? 'ok' : 'bad'}`}>{ok ? yes : no}</span>;

function Step({ n, title, lead, children }: { n: number; title: string; lead: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`step-${n}`}>
      <h2 id={`step-${n}`}><span className="pill ok" style={{ marginRight: 8 }}>{n}</span>{title}</h2>
      <p className="lead" style={{ marginBottom: 8 }}>{lead}</p>
      {children}
    </section>
  );
}

/** Browser-side commit-reveal check: sha256(salt | canonical(terms)) must equal the terms_hash that was public from the start. */
function RevealChecker({ onchainHash, initial }: { onchainHash: string; initial: Reveal | null }) {
  const [text, setText] = useState('');
  const [res, setRes] = useState<{ ok: boolean; computed: string; error?: string } | null>(null);
  useEffect(() => { if (initial) setText(JSON.stringify(initial, null, 2)); }, [initial]);
  useEffect(() => {
    if (!text.trim()) { setRes(null); return; }
    let live = true;
    (async () => {
      try {
        const j = JSON.parse(text) as { salt?: unknown; terms?: unknown };
        if (typeof j.salt !== 'string' || !j.terms || typeof j.terms !== 'object') throw new Error('Paste JSON shaped like {"salt": "...", "terms": {...}}');
        const computed = await commitOf(j.terms, j.salt);
        if (live) setRes({ ok: computed === onchainHash.toLowerCase(), computed });
      } catch (e) {
        if (live) setRes({ ok: false, computed: '', error: (e as Error).message });
      }
    })();
    return () => { live = false; };
  }, [text, onchainHash]);

  function tamper() {
    try {
      const j = JSON.parse(text) as { salt: string; terms: Record<string, unknown> };
      j.terms = { ...j.terms, minPrice: '0.01' }; // pretend the price floor was different
      setText(JSON.stringify(j, null, 2));
    } catch { /* ignore: checker already shows the parse error */ }
  }
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <strong>Check the commitment yourself</strong><Src s="chain" />
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>computed here in your browser with Web Crypto</span>
      </div>
      <label htmlFor="reveal-json" className="sr">Revealed terms and salt as JSON</label>
      <textarea id="reveal-json" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12.5, minHeight: 220 }} placeholder={initial ? '' : 'The revealed terms could not be read from the chain right now. Paste {"salt": "...", "terms": {...}} here.'} />
      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={tamper} disabled={!text}>Tamper: change the price floor</button>
        <button onClick={() => initial && setText(JSON.stringify(initial, null, 2))} disabled={!initial}>Reset to the on-chain reveal</button>
        {res && (res.error ? <span className="pill warn">cannot compute</span> : pill(res.ok, 'MATCH: this is the committed recipe', 'MISMATCH: not the committed recipe'))}
      </div>
      <pre style={{ marginTop: 8 }}>{[
        `on-chain terms_hash (public since the proposal): ${onchainHash}`,
        `sha256(salt | canonical terms) computed here:     ${res?.computed || (res?.error ? `- (${res.error})` : '-')}`,
      ].join('\n')}</pre>
    </div>
  );
}

function SealedBody({ run }: { run: SealedRun }) {
  const live = useAsync(() => getLiveSealedMandate(run.mandateId), [run.mandateId]);
  const swaps = run.swaps.map((s) => ({ ...s, inN: num(s.in, WNEAR), outN: num(s.out, USDT) }));
  const authRows = run.results.filter((r) => /\(401\)|\(200\)|encrypted at rest/i.test(r.name));
  const tamperRows = run.results.filter((r) => /^verifier REJECTS tampering/i.test(r.name));
  const preRevealRows = run.results.filter((r) => /nothing secret is in the public|WHILE EXECUTING the public chain view|worker WAITS/i.test(r.name));
  const keyTxs = KEY_TX_PATTERNS.map((p) => ({ title: p.title, tx: run.txs.find((t) => p.re.test(t.label)) })).filter((x) => x.tx);
  const verPass = run.verifier.checks.filter((c) => c.ok).length;
  const allPass = run.results.filter((r) => r.ok).length;

  return (
    <>
      <div className="grid">
        <Stat k="Sealed mandate" v={`#${run.mandateId}`} s="recorded" />
        <Stat k="Contract" v={<span className="mono">{run.ids.mandateContract}</span>} s="recorded" />
        <Stat k="Run checks passed" v={`${allPass}/${run.results.length}`} s="recorded" />
        <Stat k="Independent verifier" v={`${verPass}/${run.verifier.checks.length}`} s="recorded" />
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>Run recorded {new Date(run.recordedAt).toUTCString()} on public NEAR {run.network}. Intent typed by the treasurer: <em>&ldquo;{run.intent}&rdquo;</em></p>

      <Step n={1} title="Seal" lead="The DAO votes on a mandate whose terms are NOT on chain. Only a salted fingerprint (and the budget it needs for custody) is public.">
        <View a={live} what="the on-chain mandate">
          {(m: OnchainMandate | null, s) => m ? (
            <div className="card">
              <div className="row" style={{ marginBottom: 6 }}><strong>Live read from the mandate contract</strong><Src s={s} /><StatusPill status={m.status} /></div>
              <table><tbody>
                <tr><td>terms_hash (the fingerprint, public from the start)</td><td className="mono">{m.terms_hash}</td></tr>
                <tr><td>terms_json</td><td>{m.terms_json === null ? <span className="pill ok">null: the terms were never on chain as plain text</span> : <span className="pill bad">PRESENT: this mandate is not sealed</span>}</td></tr>
                <tr><td>budget (public by design)</td><td className="mono">{fmtUnits(m.max_sell, WNEAR, 4)} wNEAR · window {new Date(m.start_ns / 1e6).toISOString().slice(11, 19)}–{new Date(m.end_ns / 1e6).toISOString().slice(11, 19)} UTC</td></tr>
                <tr><td>chunks recorded / sold</td><td className="mono">{m.chunks} / {fmtUnits(m.sold, WNEAR, 4)} wNEAR</td></tr>
                <tr><td>revealed_terms</td><td>{m.revealed_terms ? <span className="pill ok">published after settlement ({m.revealed_terms.length} chars)</span> : <span className="pill warn">not yet: terms stay sealed until the mandate settles</span>}</td></tr>
              </tbody></table>
            </div>
          ) : <div className="state">Mandate #{run.mandateId} was not found on the contract.</div>}
        </View>
        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}><strong>Before settlement the public view was clean</strong><Src s="recorded" /></div>
          <table><tbody>
            {preRevealRows.map((r, i) => <tr key={i}><td>{r.name}</td><td>{pill(r.ok, 'pass')}</td><td className="mono">{r.note ?? ''}</td></tr>)}
          </tbody></table>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 0 }}>
            The check searched the mandate record and the decoded DAO proposal for {run.commitment.forbiddenStrings.length} secret strings (recipient accounts, the price floor, field names). None appeared.
          </p>
        </div>
        <div className="card">
          <strong>Who could read the sealed terms during the run</strong><Src s="recorded" />
          <table><tbody>
            {authRows.map((r, i) => <tr key={i}><td>{r.name}</td><td>{pill(r.ok, 'as expected', 'UNEXPECTED')}</td><td className="mono">{r.note ?? ''}</td></tr>)}
          </tbody></table>
        </div>
      </Step>

      <Step n={2} title="Trade" lead="The vault funded by a real DAO transfer executes real swaps on Ref Finance testnet and pays real tokens. Every fill respected the sealed price floor.">
        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}><strong>Swaps</strong><Src s="chain" />{run.parse.floorFromLivePool && <span style={{ color: 'var(--muted)', fontSize: 13 }}>floor {run.parse.floorFromLivePool.floor} USDT.e per NEAR, set from live pool #{run.parse.floorFromLivePool.poolId} (spot {run.parse.floorFromLivePool.spot.toFixed(3)})</span>}</div>
          <table><thead><tr><th>#</th><th>sold</th><th>received</th><th>price</th><th>tx</th></tr></thead><tbody>
            {swaps.map((s) => <tr key={s.tx}><td>{s.index}</td><td>{s.inN.toFixed(4)} wNEAR</td><td>{s.outN.toFixed(4)} USDT.e</td><td>{(s.outN / s.inN).toFixed(3)}</td><td><TxLink hash={s.tx} /></td></tr>)}
          </tbody></table>
        </div>
        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}><strong>Payouts, fee and return</strong><Src s="chain" /></div>
          <table><thead><tr><th>kind</th><th>to</th><th>amount</th><th>status</th><th>tx</th></tr></thead><tbody>
            {run.payouts.map((p) => <tr key={p.tx}><td>{p.kind}: {p.label}</td><td className="mono">{p.to}</td><td>{fmtUnits(p.amount, USDT, 4)} USDT.e</td><td>{pill(p.status === 'success', p.status, p.status)}</td><td><TxLink hash={p.tx} /></td></tr>)}
          </tbody></table>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 0 }}>Recipients were sealed until settlement: they became visible only when these payouts executed. Testnet tokens have no value.</p>
        </div>
      </Step>

      <Step n={3} title="Reveal" lead="When the mandate settles, complete() publishes the salt and the terms on chain. Anyone can now check they are exactly what was committed at the start.">
        <View a={live} what="the on-chain reveal">
          {(m: OnchainMandate | null) => {
            const reveal = parseReveal(m);
            return (
              <>
                {m && !reveal && <div className="state">The reveal is not on chain yet (status {m.status}). The check below uses whatever you paste.</div>}
                {reveal && (
                  <div className="card">
                    <div className="row" style={{ marginBottom: 6 }}><strong>Revealed terms (live from the chain)</strong><Src s="chain" /></div>
                    <pre>{JSON.stringify(reveal.terms, null, 2)}</pre>
                  </div>
                )}
                <RevealChecker onchainHash={m?.terms_hash ?? run.commitment.hash} initial={reveal} />
              </>
            );
          }}
        </View>
      </Step>

      <Step n={4} title="Verify" lead="A separate program (not the dashboard, not the worker) re-checks the whole run from a proof bundle. It also has to reject five kinds of cheating.">
        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}>
            {pill(run.verifier.ok, `${verPass}/${run.verifier.checks.length} checks pass`, 'verifier reports failures')}<Src s="recorded" />
            <span className="mono">npx tsx src/verify/cli.ts data/demo-run/sealed-proof-bundle.json</span>
          </div>
          <table><thead><tr><th>Check</th><th>Result</th></tr></thead><tbody>
            {run.verifier.checks.map((c, i) => <tr key={i}><td>{c.name}</td><td>{pill(c.ok)}</td></tr>)}
          </tbody></table>
          <p style={{ marginBottom: 0 }}><a href={asset('/demo-run/sealed-proof-bundle.json')} download>Download the proof bundle (JSON)</a> and run the command above in the repo.</p>
        </div>
        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}><strong>Five tamper cases the verifier must reject</strong><Src s="recorded" /></div>
          <table><tbody>
            {tamperRows.map((r, i) => <tr key={i}><td>{r.name.replace(/^verifier REJECTS tampering: /i, '')}</td><td>{pill(r.ok, 'rejected as it should', 'NOT REJECTED')}</td></tr>)}
          </tbody></table>
        </div>
      </Step>

      <h2>On-chain evidence</h2>
      <div className="card">
        <table><tbody>
          {keyTxs.map((k) => <tr key={k.title}><td>{k.title}</td><td><TxLink hash={k.tx!.txHash} /></td></tr>)}
        </tbody></table>
        <details style={{ marginTop: 8 }}>
          <summary>All {run.txs.length} transactions of this run</summary>
          <table><tbody>{run.txs.map((t, i) => <tr key={i}><td>{t.label}</td><td><a className="mono" href={explorerTx(t.txHash)} target="_blank" rel="noreferrer">{t.txHash.slice(0, 10)}… ↗</a></td></tr>)}</tbody></table>
        </details>
      </div>

      <h2>Honest limits</h2>
      <div className="card" role="note">
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>The worker is <strong>not</strong> in a TEE: its operator can read the sealed terms (they are AES-256-GCM encrypted at rest and released only to council members who sign a request, but the operator holds the key).</li>
          <li>On testnet, swaps and payouts are public transactions, and recipients become visible when payouts execute at settlement. Sealing hides the <em>plan</em>, not the trades.</li>
          <li>Confidential (hidden) trades through NEAR Intents are mainnet-only and <strong>not proven</strong> here; OutLayer TEE custody is likewise unproven with money.</li>
          <li>The commitment proves the revealed terms are the ones fixed at the start and that fills obeyed them; it does not prove the operator never leaked the terms early.</li>
        </ul>
      </div>

      <details style={{ marginTop: 16 }}>
        <summary>All {run.results.length} checks of the end-to-end sealed run</summary>
        <div className="card"><table><tbody>
          {run.results.map((r, i) => <tr key={i}><td>{i + 1}. {r.name}</td><td>{pill(r.ok, 'ok', 'FAIL')}</td><td className="mono">{r.note ?? ''}</td></tr>)}
        </tbody></table></div>
      </details>
    </>
  );
}

export default function Sealed() {
  const a = useAsync(getSealedRun, []);
  return (
    <>
      <PageHead title="Sealed mandate" lead="Seal, Trade, Reveal, Verify. A sealed mandate keeps its terms off the public chain until it has settled, then proves the executor obeyed exactly what was committed." />
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>DAO <span className="mono">{ENV.dao || '-'}</span></p>
      <View a={a} what="the committed sealed run">{(run) => <SealedBody run={run} />}</View>
    </>
  );
}
