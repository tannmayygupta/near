'use client';
import { useState } from 'react';
import { getVerifyFor, sha256Hex, type VerifyView } from '@/lib/data';
import { PageHead, Src, useAsync, View } from '@/components/ui';
import { WithMandate } from '@/components/mandates';
import { RunTxList } from '@/components/real';
import type { OnchainMandate } from '@/lib/types';
import { canonical } from '@/lib/canon';

const MODEL = 'z-ai/glm-5.3-flash';

function Checks({ view, s }: { view: VerifyView; s: import('@/lib/types').Source }) {
  const list = view.checks;
  if (!list.length) return <div className="state">No checks are available for this mandate.</div>;
  const pass = list.filter((c) => c.state === 'pass').length, fail = list.filter((c) => c.state === 'fail').length, pend = list.filter((c) => c.state === 'pending').length;
  return (
    <>
      <div className="row" style={{ margin: '8px 0' }}>
        <span className={`pill ${fail ? 'bad' : pend ? 'warn' : 'ok'}`}>{pass} pass · {fail} fail · {pend} pending</span>
        {view.note && <span style={{ color: 'var(--muted)', fontSize: 13 }}>{view.note}</span>}
      </div>
      <div className="card"><table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>
        {list.map((c, i) => (
          <tr key={`${i}-${c.name}`}>
            <td>{c.name}<Src s={s} /></td>
            <td>{c.state === 'pass' ? <span className="pill ok">pass</span> : c.state === 'pending' ? <span className="pill warn">pending</span> : <span className="pill bad">FAIL</span>}</td>
            <td className="mono">{c.detail}</td>
          </tr>
        ))}
      </tbody></table></div>
      <RunTxList match={/complete #|mark_funded|funding vote .*executes|cancel vote .*executes/i} caption="On-chain evidence: funding, anchor and cancel transactions" />
      {view.verifier && (
        <>
          <h3>Independent verifier (separate program)</h3>
          <div className="card">
            <div className="row"><span className={`pill ${view.verifier.ok ? 'ok' : 'bad'}`}>{view.verifier.checks.filter((c) => c.ok).length}/{view.verifier.checks.length} pass</span><Src s="recorded" /><span className="mono">npx tsx src/verify/cli.ts data/demo-run/proof-bundle.json</span></div>
            <table><tbody>
              {view.verifier.checks.map((c, i) => <tr key={`${i}-${c.name}`}><td>{c.name}</td><td>{c.ok ? <span className="pill ok">pass</span> : <span className="pill bad">FAIL</span>}</td><td className="mono">{c.detail ?? ''}</td></tr>)}
            </tbody></table>
          </div>
        </>
      )}
    </>
  );
}

/** Live, in-browser check of the NEAR AI Cloud attestation with a fresh random nonce (no API key needed). */
function LiveAttestation() {
  const [out, setOut] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true); setOut(null);
    try {
      const nonce = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const url = `https://cloud-api.near.ai/v1/attestation/report?model=${encodeURIComponent(MODEL)}&provider=near&signing_algo=ecdsa&nonce=${nonce}`;
      const r = await fetch(url, { headers: { 'x-no-aliasing': 'true' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const g = j.gateway_attestation ?? {};
      const m = (j.model_attestations ?? [])[0] ?? {};
      const echoed = g.request_nonce === nonce;
      setOut({
        ok: echoed && !!g.intel_quote && !!m.intel_quote,
        lines: [
          `fresh nonce sent: ${nonce.slice(0, 16)}…`,
          `nonce echoed by gateway: ${echoed}`,
          `gateway signer: ${g.signing_address ?? '-'}`,
          `gateway Intel TDX quote present: ${!!g.intel_quote} (${(g.intel_quote ?? '').length} hex chars)`,
          `model signer: ${m.signing_address ?? '-'}`,
          `model Intel TDX quote present: ${!!m.intel_quote} · NVIDIA GPU payload present: ${!!m.nvidia_payload}`,
          'Scope: this checks nonce freshness and presence of hardware evidence. Full quote verification is done by the worker (DCAP) or NEAR’s verifier: https://cloud.near.ai/verify',
        ],
      });
    } catch (e) {
      setOut({ ok: false, lines: [`Could not fetch attestation from the browser: ${(e as Error).message} (CORS or network). The worker performs the same check server-side.`] });
    }
    setBusy(false);
  }
  return (
    <div className="card">
      <div className="row"><button className="primary" onClick={run} disabled={busy}>{busy ? 'Checking…' : 'Run live attestation check'}</button><Src s="api" /><span className="mono">{MODEL}</span></div>
      {out && <><div style={{ marginTop: 8 }}>{out.ok ? <span className="pill ok">pass</span> : <span className="pill bad">not verified</span>}</div><pre>{out.lines.join('\n')}</pre></>}
    </div>
  );
}

function HashCheck({ m }: { m: OnchainMandate }) {
  const [text, setText] = useState('');
  const [res, setRes] = useState<string | null>(null);
  async function run() {
    let h = '';
    try { h = await sha256Hex(canonical(JSON.parse(text))); } catch { return setRes('Input is not valid JSON.'); }
    const asIs = await sha256Hex(text.trim());
    const hit = h === m.terms_hash ? 'canonical JSON' : asIs === m.terms_hash ? 'raw text' : null;
    setRes(hit ? `MATCH (${hit}) · ${m.terms_hash}` : `NO MATCH · computed ${h} · on-chain ${m.terms_hash}`);
  }
  return (
    <div className="card">
      <p style={{ marginTop: 0 }}>Paste revealed mandate terms (JSON). We compute SHA-256 of the canonical form and compare with the commitment stored on-chain <Src s="chain" />.</p>
      <label htmlFor="terms" className="sr">Revealed terms JSON</label>
      <textarea id="terms" value={text} onChange={(e) => setText(e.target.value)} placeholder='{"dao":"…"}' />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" onClick={run} disabled={!text.trim()}>Check commitment</button>
        {m.revealed_terms && <button onClick={() => setText(m.revealed_terms ?? '')}>Load revealed terms from chain</button>}
      </div>
      {res && <pre>{res}</pre>}
    </div>
  );
}

function Body({ m, s }: { m: OnchainMandate; s: import('@/lib/types').Source }) {
  const checks = useAsync(() => getVerifyFor(m), [m.id]);
  return (
    <>
      <h2>Worker verification</h2>
      <View a={checks} what="verification checks">{(v, cs) => <Checks view={v} s={cs} />}</View>
      <h2>Commitment check <Src s={s} /></h2>
      <HashCheck m={m} />
    </>
  );
}

export default function Verify() {
  return (
    <>
      <PageHead title="Verify" lead="Do not trust the dashboard: check it. Attestation freshness, signatures, and the hash commitments can all be re-computed independently." />
      <h2>Live private-AI attestation</h2>
      <LiveAttestation />
      <WithMandate>{(m, s) => <Body m={m} s={s} />}</WithMandate>
    </>
  );
}

