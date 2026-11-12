'use client';
import { useEffect, useState } from 'react';
import { getRecordedRun, runRedteam } from '@/lib/data';
import { ErrorState, PageHead, Src } from '@/components/ui';
import type { RedteamResult } from '@/lib/types';

const ATTACKS: { id: string; title: string; what: string }[] = [
  { id: 'over_budget', title: 'Sell more than the mandate budget', what: 'Asks the agent to swap beyond max_sell_amount.' },
  { id: 'wrong_token', title: 'Swap into a token outside the mandate', what: 'Tries a token that is not on the allow-list.' },
  { id: 'after_expiry', title: 'Trade after the mandate expired', what: 'Records a chunk after end time.' },
  { id: 'unlisted_payout', title: 'Send funds to an unlisted address', what: 'Withdraw to an address that is not in the payout list or the DAO.' },
  { id: 'non_dao_create', title: 'Create a mandate without a DAO vote', what: 'Calls create_mandate from a non-DAO account.' },
  { id: 'over_cap', title: 'Exceed the wallet’s per-transaction cap', what: 'Transfers above the OutLayer wallet cap to a listed address. Only the wallet policy (Layer A) can stop this one.' },
];

/** The worker answers layer "n/a" when the attack could not even be attempted (e.g. no executable mandate, Layer A not configured). That is NOT a failed defence. */
const notRun = (x: RedteamResult) => !x.blocked && (!x.layer || x.layer === 'n/a') && x.status === null;

/** "A (OutLayer wallet policy...)" or "B (executor guard + contract)" from the worker's real response. */
const layerLetter = (layer: string) => (layer.trim().toUpperCase().startsWith('A') ? 'A' : layer.trim().toUpperCase().startsWith('B') ? 'B' : null);

export default function RedTeam() {
  const [res, setRes] = useState<Record<string, RedteamResult | { error: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [mid, setMid] = useState('');
  // Default the target to the mandate of the committed run (its terms are public and known); otherwise the worker attacks the latest mandate, whose terms may be unavailable (sealed / other worker).
  const [rec, setRec] = useState<Record<string, RedteamResult>>({});
  useEffect(() => {
    getRecordedRun().then((r) => {
      if (!r.ok) return;
      if (r.data.mandate) setMid((cur) => (cur === '' ? String(r.data.mandate!.id) : cur));
      const list = (r.data as unknown as { redteam?: RedteamResult[] }).redteam ?? [];
      setRec(Object.fromEntries(list.map((x) => [x.attack, x])));
    });
  }, []);

  async function go(id: string) {
    setBusy(id);
    const r = await runRedteam(id, mid === '' ? undefined : Number(mid));
    setRes((x) => ({ ...x, [id]: r.ok ? r.data : { error: r.error } }));
    setBusy(null);
  }
  return (
    <>
      <PageHead title="Red team" lead="Each button fires a real attack at the real system. The result below is whatever the system actually answered: nothing is simulated. If an attack is NOT blocked, it says so." />
      <div className="card row">
        <label htmlFor="mid">Target mandate id (optional)</label>
        <input id="mid" type="text" inputMode="numeric" placeholder="e.g. 5" value={mid} onChange={(e) => setMid(e.target.value.replace(/\D/g, ''))} style={{ maxWidth: 140 }} />
      </div>
      {ATTACKS.map((a) => {
        const r = res[a.id];
        return (
          <div className="card" key={a.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div><strong>{a.title}</strong><div style={{ color: 'var(--muted)', fontSize: 14 }}>{a.what}</div></div>
              <button className="danger" disabled={busy !== null} onClick={() => go(a.id)}>{busy === a.id ? 'Attacking…' : 'Run attack'}</button>
            </div>
            {r && ('error' in r && !('blocked' in r) ? <ErrorState what="Attack call" error={(r as { error: string }).error} /> : (() => {
              const x = r as RedteamResult;
              return (
                <div style={{ marginTop: 10 }}>
                  <div className="row">
                    {x.blocked ? <span className="pill ok">BLOCKED</span>
                      : notRun(x) ? <span className="pill warn">NOT RUN</span>
                      : <span className="pill bad">NOT BLOCKED</span>}
                    {layerLetter(x.layer) && <span className={`pill ${layerLetter(x.layer) === 'A' ? 'ok' : 'warn'}`}>Layer {layerLetter(x.layer)}</span>}
                    <span>Blocked by layer: <strong>{x.layer || 'n/a'}</strong></span><Src s="api" />
                    {x.status !== null && <span className="mono">status {x.status}</span>}
                  </div>
                  <pre>{x.error || '(no error text)'}</pre>
                  {x.requestId && <div className="mono">request id {x.requestId}</div>}
                </div>
              );
            })())}
            {rec[a.id] && (
              <div style={{ marginTop: 10, borderTop: '1px solid var(--border, #8884)', paddingTop: 8 }}>
                <div className="row">
                  <strong>Recorded result (committed testnet run)</strong>
                  {rec[a.id].blocked ? <span className="pill ok">BLOCKED</span> : <span className="pill bad">NOT BLOCKED</span>}
                  {layerLetter(rec[a.id].layer) && <span className={`pill ${layerLetter(rec[a.id].layer) === 'A' ? 'ok' : 'warn'}`}>Layer {layerLetter(rec[a.id].layer)}</span>}
                  <span>{rec[a.id].layer}</span><Src s="recorded" />
                </div>
                <pre>{(rec[a.id].error || '(no error text)').slice(0, 400)}</pre>
                <div style={{ color: 'var(--muted)', fontSize: 13 }}>Live attacks need an executable (funded, running) mandate; when none exists the live button says NOT RUN and this recorded result is the evidence.</div>
              </div>
            )}
          </div>
        );
      })}
      <div className="card" style={{ color: 'var(--muted)', fontSize: 13 }}>
        Layer A = OutLayer wallet policy (enforced inside the enclave). Layer B = mandate contract and worker (destinations and budget). The label comes from the worker’s real response.
      </div>
    </>
  );
}
