// Pure helpers for detecting a live worker from the browser (no React, no env: unit-tested in tests/worker-status.test.ts).
// The hosted static site is built once; whether a worker is reachable is decided at run time by pinging `${worker}/health`.

export type AttestationBrief = { ok: boolean | null; ageSeconds: number | null };
export type LiveInfo = {
  state: 'live';
  /** browser time (ms) of the ping that produced this */
  checkedAt: number;
  /** seconds since the worker's last executor tick (null = it has not ticked yet); uses the worker's own clock when it reports one */
  tickAgeS: number | null;
  /** how many settlement items are parked for a human (0 = none) */
  needsHuman: number;
  execMode: string | null;
  net: string | null;
  /** the worker's own live NEAR AI attestation check; null = this worker does not report one */
  attestation: AttestationBrief | null;
};
export type WorkerStatus =
  | { state: 'off' }                         // no worker was configured when the site was built
  | { state: 'checking' }                    // configured, first ping not answered yet
  | { state: 'down'; reason: string }        // configured, not reachable (asleep, offline, blocked)
  | LiveInfo;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Turn a /health body into LiveInfo; null when it is not a healthy worker answer. */
export function parseHealth(body: unknown, nowMs: number): LiveInfo | null {
  if (!body || typeof body !== 'object') return null;
  const h = body as Record<string, unknown>;
  if (h.ok !== true) return null;
  const lastTick = num(h.lastTick) ?? 0;
  const workerNow = num(h.nowS) ?? nowMs / 1000; // the worker's clock when it tells us, else ours
  const att = h.attestation && typeof h.attestation === 'object' ? (h.attestation as Record<string, unknown>) : null;
  return {
    state: 'live', checkedAt: nowMs,
    tickAgeS: lastTick > 0 ? Math.max(0, Math.round(workerNow - lastTick)) : null,
    needsHuman: Array.isArray(h.needsHuman) ? h.needsHuman.length : 0,
    execMode: typeof h.execMode === 'string' ? h.execMode : null,
    net: typeof h.net === 'string' ? h.net : null,
    attestation: att ? { ok: typeof att.ok === 'boolean' ? att.ok : null, ageSeconds: num(att.ageSeconds) } : null,
  };
}

/** One short ping of `${base}/health`. Never throws. */
export async function pingWorker(base: string, o: { fetchFn?: typeof fetch; timeoutMs?: number; nowMs?: () => number } = {}): Promise<LiveInfo | { state: 'down'; reason: string }> {
  const timeoutMs = o.timeoutMs ?? 6000; const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  const down = (reason: string) => ({ state: 'down' as const, reason });
  try {
    const r = await (o.fetchFn ?? fetch)(`${base}/health`, { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) return down(`HTTP ${r.status}`);
    let body: unknown; try { body = await r.json(); } catch { return down('the answer was not JSON'); }
    return parseHealth(body, (o.nowMs ?? Date.now)()) ?? down('the answer was not a healthy worker /health');
  } catch (e) {
    return down(ctl.signal.aborted ? `no answer within ${Math.round(timeoutMs / 1000)}s` : String((e as Error)?.message ?? e).slice(0, 120));
  } finally { clearTimeout(t); }
}

/** "3 s", "4 min", "2 h" */
export function ageText(seconds: number | null): string {
  if (seconds === null) return 'never';
  if (seconds < 90) return `${seconds} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

/** A tick older than this (the worker ticks every few seconds) is shown as a warning, not as live. */
export const STALE_TICK_S = 120;
