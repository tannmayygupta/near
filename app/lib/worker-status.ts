'use client';
// Run-time worker detection for the hosted static site. One shared poller (not one per component), paused while the tab is hidden,
// so a free-tier worker is not kept awake by a forgotten tab. Used by the banner and by the features that need the worker.
import { useSyncExternalStore } from 'react';
import { ENV, NO_WORKER, STATIC_DEMO } from './data';
import { pingWorker, type WorkerStatus } from './worker-health';

const POLL_MS = 15_000;
const initial: WorkerStatus = ENV.worker ? { state: 'checking' } : { state: 'off' };
let current: WorkerStatus = initial;
let misses = 0;
let inflight = false;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function publish(next: WorkerStatus) { current = next; listeners.forEach((l) => l()); }

async function poll() {
  if (inflight || !ENV.worker) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  inflight = true;
  try {
    const r = await pingWorker(ENV.worker);
    if (r.state === 'live') { misses = 0; publish(r); }
    else if (current.state === 'live' && ++misses < 2) { /* one missed ping does not turn a live worker into an unreachable one */ }
    else publish(r);
  } finally { inflight = false; }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  // only the static hosted demo needs run-time detection; a local or normal deployment behaves exactly as before
  if (STATIC_DEMO && ENV.worker && listeners.size === 1) { void poll(); timer = setInterval(() => void poll(), POLL_MS); }
  return () => { listeners.delete(cb); if (!listeners.size && timer) { clearInterval(timer); timer = null; } };
}

/** Live status of the worker named by NEXT_PUBLIC_WORKER_API (state "off" when none was configured at build time). */
export function useWorkerStatus(): WorkerStatus {
  return useSyncExternalStore(subscribe, () => current, () => initial);
}

export type LiveFeatures = { enabled: boolean; status: WorkerStatus['state']; reason: string };
/**
 * Are the features that need the worker (parse a new intent, fire live attacks) usable right now?
 * On the static hosted demo: only while a worker answers /health; otherwise they stay disabled with the explanation.
 * Anywhere else (local dev, a normal deployment) they are not gated: a call that fails reports its own error.
 */
export function useLiveFeatures(): LiveFeatures {
  const s = useWorkerStatus();
  if (!STATIC_DEMO) return { enabled: true, status: s.state, reason: '' };
  if (s.state === 'live') return { enabled: true, status: 'live', reason: '' };
  if (s.state === 'off') return { enabled: false, status: 'off', reason: NO_WORKER };
  if (s.state === 'checking') return { enabled: false, status: 'checking', reason: 'Checking whether the live worker for this site is reachable…' };
  return {
    enabled: false, status: 'down',
    reason: `The live worker for this site is not reachable right now (${s.reason}). Free hosts sleep when idle and can take up to a minute to wake: this page keeps trying and will switch on by itself. Until then the recorded results below are the evidence, and everything on them opens on the public testnet explorer.`,
  };
}
