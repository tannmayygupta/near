// Tiered fixed-window rate limiter for the worker API. Per process, in memory (the worker is a single instance by design).
// Expensive or sensitive routes get a tight tier; /64 buckets stop an IPv6 user from rotating addresses; X-Forwarded-For is trusted only from loopback
// (the tunnel / reverse proxy on the same host), never from the open internet.
export interface RateRule { match: RegExp; max: number; name: string }
export const DEFAULT_RULES: RateRule[] = [
  { name: 'ai-and-auth', match: /^\/api\/(parse|auth)|\/terms$|^\/api\/sealed/, max: 20 },
  { name: 'red-team', match: /^\/api\/redteam/, max: 6 }, // strict: the six attacks of one dashboard round fit in a minute; the global budget in worker/redteam.ts caps what reaches the chain
  { name: 'default', match: /.*/, max: 600 },
];

/** Canonical bucket for a client address: IPv4 as is, IPv4-mapped IPv6 unwrapped, other IPv6 collapsed to its /64. */
export function clientBucket(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i); if (mapped) return mapped[1]!;
  if (!ip.includes(':')) return ip;
  const full = expandV6(ip); return full ? full.slice(0, 4).join(':') + '::/64' : ip;
}
function expandV6(ip: string): string[] | null {
  const [head, tail] = ip.split('::'); const h = head ? head.split(':') : []; const t = tail !== undefined && tail ? tail.split(':') : [];
  if (tail === undefined && h.length !== 8) return null;
  const fill = tail === undefined ? [] : Array(Math.max(0, 8 - h.length - t.length)).fill('0');
  const all = [...h, ...fill, ...t]; return all.length === 8 ? all.map((x) => x.replace(/^0+(?=.)/, '').toLowerCase()) : null;
}
const isLoopback = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

/** The address to rate-limit: the socket peer, or the first X-Forwarded-For hop when (and only when) the peer is loopback. */
export function clientIp(remote: string | undefined, forwardedFor: string | undefined): string {
  const peer = remote ?? 'unknown';
  if (isLoopback(peer) && forwardedFor) { const first = forwardedFor.split(',')[0]?.trim(); if (first) return first; }
  return peer;
}

/** A GLOBAL (all clients together) sliding-window budget for actions that cost the operator something (gas, AI credits). `take` consumes one unit; `refund` gives back the latest one. */
export class WindowBudget {
  private stamps: number[] = [];
  constructor(private max: number, private windowMs = 3_600_000, private nowFn: () => number = Date.now) {}
  private prune(now: number) { while (this.stamps.length && now - this.stamps[0]! >= this.windowMs) this.stamps.shift(); }
  take(): { ok: boolean; retryAfterS: number } {
    const now = this.nowFn(); this.prune(now);
    if (this.stamps.length >= this.max) return { ok: false, retryAfterS: Math.max(1, Math.ceil((this.stamps[0]! + this.windowMs - now) / 1000)) };
    this.stamps.push(now); return { ok: true, retryAfterS: 0 };
  }
  refund() { this.stamps.pop(); }
  remaining() { this.prune(this.nowFn()); return Math.max(0, this.max - this.stamps.length); }
}

export class RateLimiter {
  private windows = new Map<string, { start: number; n: number }>();
  private lastSweep = 0;
  constructor(private o: { now?: () => number; windowMs?: number; rules?: RateRule[] } = {}) {}
  private get now() { return this.o.now?.() ?? Date.now(); }
  private get windowMs() { return this.o.windowMs ?? 60_000; }
  check(ip: string, path: string): { ok: boolean; limit: number; remaining: number; retryAfterS: number; rule: string } {
    const rule = (this.o.rules ?? DEFAULT_RULES).find((r) => r.match.test(path))!;
    const now = this.now; this.sweep(now);
    const key = `${clientBucket(ip)} ${rule.name}`; let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) { w = { start: now, n: 0 }; this.windows.set(key, w); }
    w.n++;
    const retryAfterS = Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000));
    return { ok: w.n <= rule.max, limit: rule.max, remaining: Math.max(0, rule.max - w.n), retryAfterS, rule: rule.name };
  }
  private sweep(now: number) { if (now - this.lastSweep < this.windowMs) return; this.lastSweep = now; for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k); }
  size() { return this.windows.size; }
}
