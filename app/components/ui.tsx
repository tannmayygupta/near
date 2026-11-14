'use client';
import { useEffect, useState, type ReactNode } from 'react';
import type { Result, Source } from '@/lib/types';
import { NO_WORKER } from '@/lib/data';

/** Small badge saying where a number came from. Required next to every displayed figure. */
export function Src({ s }: { s: Source }) {
  const label = s === 'simulated' ? 'SIMULATED (not a real trade)' : s;
  return <span className={`tag ${s}`} title={`Source: ${label}`}>{label}</span>;
}

export function Loading({ what }: { what: string }) {
  return <div className="state loading" role="status">Loading {what}…</div>;
}
export function ErrorState({ what, error }: { what: string; error: string }) {
  // Not a failure: the hosted static demo simply has no worker. Say so plainly and point at the local run.
  if (error === NO_WORKER) {
    return (
      <div className="state" role="status">
        <strong>{what}: needs the worker.</strong>
        <div style={{ marginTop: 6 }}>{error}</div>
      </div>
    );
  }
  return (
    <div className="state error" role="alert">
      <strong>{what} unavailable.</strong>
      <div className="mono" style={{ marginTop: 6 }}>{error}</div>
      <div style={{ marginTop: 6, color: 'var(--muted)' }}>No placeholder data is shown. Fix the source or connect it in the environment settings.</div>
    </div>
  );
}
export function Empty({ what, hint }: { what: string; hint?: string }) {
  return <div className="state">No {what} yet.{hint ? ` ${hint}` : ''}</div>;
}

export type Async<T> = { loading: true } | { loading: false; result: Result<T> };

/** Run an async loader on mount (and when deps change). */
export function useAsync<T>(loader: () => Promise<Result<T>>, deps: unknown[] = []): Async<T> & { reload: () => void } {
  const [state, setState] = useState<Async<T>>({ loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ loading: true });
    loader().then((result) => live && setState({ loading: false, result })).catch((e) =>
      live && setState({ loading: false, result: { ok: false, error: (e as Error).message } }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

/** Render a loader result with loading / error states handled. */
export function View<T>({ a, what, children }: { a: Async<T>; what: string; children: (data: T, source: Source) => ReactNode }) {
  if (a.loading) return <Loading what={what} />;
  if (!a.result.ok) return <ErrorState what={what} error={a.result.error} />;
  return <>{children(a.result.data, a.result.source)}</>;
}

export function Stat({ k, v, s }: { k: string; v: ReactNode; s?: Source }) {
  // Short figures are shown big; a long sentence or a long id would shout, so those get a compact style (presentation only).
  const text = typeof v === 'string' ? v : null;
  const cls = text && text.length > 16 ? (/\s/.test(text) ? 'v long' : 'v id') : 'v';
  return (
    <div className="card stat">
      <div className="k">{k}{s && <Src s={s} />}</div>
      <div className={cls}>{v}</div>
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const cls = ['Completed', 'success', 'Executed', 'Approved'].includes(status) ? 'ok' : ['Cancelled', 'Expired', 'failed', 'Rejected'].includes(status) ? 'bad' : 'warn';
  return <span className={`pill ${cls}`}>{status}</span>;
}

export function PageHead({ title, lead }: { title: string; lead: string }) {
  return (<><h1>{title}</h1><p className="lead">{lead}</p></>);
}

export function useTick(ms: number, enabled: boolean, fn: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  }, [ms, enabled, fn]);
}

