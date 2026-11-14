import { describe, expect, it } from 'vitest';
import { STALE_TICK_S, ageText, parseHealth, pingWorker } from '../app/lib/worker-health';

const healthy = { ok: true, lastTick: 1_000, nowS: 1_004, ticking: false, net: 'testnet', execMode: 'testnet-outlayer', needsHuman: [], attestation: { ok: true, ageSeconds: 600, checkedAt: '2026-11-14T10:00:00.000Z' } };
const res = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('live worker detection (what the hosted site shows)', () => {
  it('reads a healthy /health: tick age on the worker\'s own clock, nothing needs a human, attestation ok', () => {
    const l = parseHealth(healthy, 5_000_000)!;
    expect(l).toMatchObject({ state: 'live', checkedAt: 5_000_000, tickAgeS: 4, needsHuman: 0, execMode: 'testnet-outlayer', net: 'testnet', attestation: { ok: true, ageSeconds: 600 } });
  });
  it('counts items that need a human, and reports an attestation that is failing or not reported at all', () => {
    expect(parseHealth({ ...healthy, needsHuman: [{ mandate_id: 3, key: 'payout:a', note: 'x' }, { mandate_id: 3, key: 'fee', note: 'y' }] }, 0)!.needsHuman).toBe(2);
    expect(parseHealth({ ...healthy, attestation: { ok: false, ageSeconds: 5 } }, 0)!.attestation).toEqual({ ok: false, ageSeconds: 5 });
    expect(parseHealth({ ...healthy, attestation: { ok: null, ageSeconds: null } }, 0)!.attestation).toEqual({ ok: null, ageSeconds: null });
    const { attestation, ...old } = healthy; void attestation;
    expect(parseHealth(old, 0)!.attestation).toBeNull(); // an older worker that does not report attestation
  });
  it('a worker that has not ticked yet has no tick age; without the worker clock the browser clock is used', () => {
    expect(parseHealth({ ...healthy, lastTick: 0 }, 0)!.tickAgeS).toBeNull();
    const { nowS, ...noClock } = healthy; void nowS;
    expect(parseHealth(noClock, 1_030_000)!.tickAgeS).toBe(30);
    expect(parseHealth({ ...healthy, lastTick: 2_000, nowS: 1_000 }, 0)!.tickAgeS).toBe(0); // never negative
  });
  it('anything that is not a healthy worker answer is not "live"', () => {
    for (const bad of [null, undefined, 'ok', 7, [], {}, { ok: false }, { ok: 'true' }]) expect(parseHealth(bad, 0), JSON.stringify(bad)).toBeNull();
  });

  it('pings <worker>/health with no cache and reports a healthy worker as live', async () => {
    let seen = '';
    const r = await pingWorker('https://worker.example', { fetchFn: (async (u: string, init?: RequestInit) => { seen = `${u} ${init?.cache}`; return res(200, healthy); }) as never, nowMs: () => 42 });
    expect(seen).toBe('https://worker.example/health no-store'); expect(r.state).toBe('live');
  });
  it('unreachable, erroring, non-JSON and not-a-worker answers are all "down" with a reason (never an exception)', async () => {
    const down = async (f: () => Promise<Response>) => pingWorker('https://w', { fetchFn: f as never });
    expect(await down(async () => res(502, 'bad gateway'))).toEqual({ state: 'down', reason: 'HTTP 502' });
    expect(await down(async () => { throw new TypeError('Failed to fetch'); })).toEqual({ state: 'down', reason: 'Failed to fetch' });
    expect((await down(async () => res(200, '<html>asleep</html>'))) as { reason: string }).toMatchObject({ state: 'down', reason: 'the answer was not JSON' });
    expect((await down(async () => res(200, { hello: 'world' }))) as { reason: string }).toMatchObject({ state: 'down' });
  });
  it('a worker that does not answer in time (a sleeping free host) is "down" after the short timeout', async () => {
    const hang = ((_: string, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))) as never;
    const t0 = Date.now(); const r = await pingWorker('https://w', { fetchFn: hang, timeoutMs: 30 });
    expect(r).toMatchObject({ state: 'down' }); expect((r as { reason: string }).reason).toContain('no answer within'); expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('formats ages the way the strip shows them', () => {
    expect(ageText(null)).toBe('never'); expect(ageText(4)).toBe('4 s'); expect(ageText(600)).toBe('10 min'); expect(ageText(7200)).toBe('2 h');
    expect(STALE_TICK_S).toBeGreaterThan(30); // the worker ticks every few seconds: a tick two minutes old is a warning
  });
});
