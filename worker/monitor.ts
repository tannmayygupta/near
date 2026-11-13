// Monitor: a pure `evaluate(snapshot)` that turns facts into findings, and a loop that gathers each fact independently
// (one failing source never hides the others) and alerts. The pure part is unit-tested; thresholds are config, not constants in the loop.
import type { Alerts } from './alerts';

export interface Snapshot {
  nowS: number;
  /** unix seconds of the last completed executor tick (0 = never) */
  lastTickS: number;
  tickEveryS: number;
  /** items the worker parked for a human (state.items status needs_review) */
  needsReview: number;
  /** running mandates and when each last made progress (last chunk) */
  running: Array<{ id: number; lastProgressS: number; windowEndS: number }>;
  /** native NEAR held by the vault for gas and storage; null = could not be read */
  vaultNativeYocto: bigint | null;
}
export interface Thresholds { tickStaleFactor: number; stuckAfterS: number; vaultNativeMinYocto: bigint }
export const DEFAULT_THRESHOLDS: Thresholds = { tickStaleFactor: 6, stuckAfterS: 20 * 60, vaultNativeMinYocto: 3n * 10n ** 23n }; // 0.3 NEAR
export interface Finding { key: string; text: string }

export function evaluate(s: Snapshot, t: Thresholds = DEFAULT_THRESHOLDS): Finding[] {
  const out: Finding[] = [];
  if (s.lastTickS > 0 && s.nowS - s.lastTickS > s.tickEveryS * t.tickStaleFactor) out.push({ key: 'tick-stale', text: `Quiet Treasury worker: no executor tick for ${s.nowS - s.lastTickS}s (expected every ${s.tickEveryS}s). The worker may be down.` });
  if (s.needsReview > 0) out.push({ key: 'needs-review', text: `Quiet Treasury worker: ${s.needsReview} item(s) need a human (a payout or return could not be completed). See /health and the mandate status.` });
  for (const r of s.running) {
    if (s.nowS < r.windowEndS && s.nowS - r.lastProgressS > t.stuckAfterS) out.push({ key: `stuck-${r.id}`, text: `Mandate #${r.id} has made no progress for ${Math.round((s.nowS - r.lastProgressS) / 60)} min inside its window (price floor not met, wallet refused, or pool unavailable). Check /api/mandates/${r.id}/events.` });
  }
  if (s.vaultNativeYocto !== null && s.vaultNativeYocto < t.vaultNativeMinYocto) out.push({ key: 'vault-gas', text: `Vault native balance is ${(Number(s.vaultNativeYocto / 10n ** 20n) / 1e4).toFixed(3)} NEAR, below the ${(Number(t.vaultNativeMinYocto / 10n ** 20n) / 1e4).toFixed(3)} NEAR needed for gas and storage.` });
  return out;
}

export interface MonitorSources {
  tick: () => number; tickEveryS: number;
  needsReview: () => Promise<number> | number;
  running: () => Promise<Snapshot['running']> | Snapshot['running'];
  vaultNative?: () => Promise<bigint | null>;
}
/** One monitoring pass. Every source is read in its own try/catch; a source that fails is reported as such instead of aborting the pass. */
export async function monitorOnce(src: MonitorSources, alerts: Alerts, nowS: number, log: (k: string, f: Record<string, unknown>) => void, t: Thresholds = DEFAULT_THRESHOLDS): Promise<Finding[]> {
  const snap: Snapshot = { nowS, lastTickS: 0, tickEveryS: src.tickEveryS, needsReview: 0, running: [], vaultNativeYocto: null };
  const read = async <T>(name: string, fn: () => Promise<T> | T, set: (v: T) => void) => { try { set(await fn()); } catch (e) { log('monitor_source_failed', { source: name, message: (e as Error).message.slice(0, 120) }); } };
  await read('tick', src.tick, (v) => { snap.lastTickS = v; });
  await read('needsReview', src.needsReview, (v) => { snap.needsReview = v; });
  await read('running', src.running, (v) => { snap.running = v; });
  if (src.vaultNative) await read('vaultNative', src.vaultNative, (v) => { snap.vaultNativeYocto = v; });
  const findings = evaluate(snap, t);
  for (const f of findings) { log('monitor_finding', { key: f.key }); await alerts.admin(f.text); }
  return findings;
}
export function startMonitor(src: MonitorSources, alerts: Alerts, log: (k: string, f: Record<string, unknown>) => void, everyMs = 5 * 60_000): () => void {
  const h = setInterval(() => { void monitorOnce(src, alerts, Math.floor(Date.now() / 1000), log); }, everyMs); h.unref?.();
  return () => clearInterval(h);
}
