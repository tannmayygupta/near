'use client';
import { ENV, STATIC_DEMO } from '@/lib/data';
import { useWorkerStatus } from '@/lib/worker-status';
import { STALE_TICK_S, ageText, type LiveInfo } from '@/lib/worker-health';

/** Shown only on the static hosted demo (GitHub Pages). Turns into a green strip when the worker named by NEXT_PUBLIC_WORKER_API answers /health. */
export function StaticBanner() {
  const s = useWorkerStatus();
  if (!STATIC_DEMO) return null;
  if (s.state === 'live') return <LiveStrip s={s} />;
  return (
    <div className="wrap" role="note" aria-label="Hosted demo notice" style={{ paddingBottom: 0 }}>
      <div className="state" style={{ margin: '12px 0 0' }}>
        <strong>Hosted read-only demo.</strong> Pages read the committed testnet runs and the public NEAR testnet live from your browser.
        Parsing a new intent and firing live red-team attacks need the worker: run it locally (see the repo README, &ldquo;Run it&rdquo;).
        Everything shown opens on the public testnet explorer.
      </div>
    </div>
  );
}

function host(url: string) { try { return new URL(url).host; } catch { return url; } }

function LiveStrip({ s }: { s: LiveInfo }) {
  const tickStale = s.tickAgeS === null || s.tickAgeS > STALE_TICK_S;
  const att = s.attestation;
  return (
    <div className="wrap" role="status" aria-live="polite" aria-label="Live worker status" style={{ paddingBottom: 0 }}>
      <div style={{ margin: '12px 0 0', padding: '12px 16px', border: '1px solid var(--ok)', borderRadius: 'var(--radius)', background: 'color-mix(in srgb, var(--ok) 10%, var(--surface))' }}>
        <div className="row" style={{ gap: 8 }}>
          <strong style={{ color: 'var(--ok)' }}>Live worker connected</strong>
          <span className="mono" title="NEXT_PUBLIC_WORKER_API">{host(ENV.worker)}</span>
          {s.execMode && <span className="pill" title="the worker's execution mode (EXEC_MODE)">{s.execMode}</span>}
        </div>
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <span className={`pill ${tickStale ? 'warn' : 'ok'}`}>agent tick {s.tickAgeS === null ? 'not yet' : `${ageText(s.tickAgeS)} ago`}</span>
          <span className={`pill ${s.needsHuman === 0 ? 'ok' : 'bad'}`}>{s.needsHuman === 0 ? 'nothing needs a human' : `${s.needsHuman} item(s) need a human`}</span>
          <span className={`pill ${att === null ? 'warn' : att.ok === true ? 'ok' : att.ok === false ? 'bad' : 'warn'}`} title="live NEAR AI attestation check run by the worker">
            {att === null ? 'private AI attestation: not reported' : att.ok === true ? `private AI attestation: verified ${ageText(att.ageSeconds)} ago` : att.ok === false ? 'private AI attestation: NOT verified' : 'private AI attestation: pending'}
          </span>
          <a href={`${ENV.worker}/attestation`} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>attestation details</a>
        </div>
        <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 8 }}>
          Parsing a new intent and the live red-team attacks are switched on. Live numbers carry the <span className="tag api">api</span> tag, recorded runs stay labelled <span className="tag recorded">recorded</span>, and everything on-chain opens on the public testnet explorer.
          {s.execMode === 'simulated' && <strong> This worker runs in SIMULATED mode: its fills are not real trades.</strong>}
        </div>
      </div>
    </div>
  );
}
