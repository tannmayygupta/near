// What must hold before the red-team endpoint is exposed on a public worker (docs/DEPLOY.md, "Hosted worker"):
// an attack can only be REFUSED (never accepted into a live mandate's accounting), it never reaches the chain more often than the global budget allows,
// it is rate limited per client, and no answer carries a secret or a sealed term.
import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { RedteamGate, attackCost, runAttack, ATTACKS, type RedteamDeps } from '../worker/redteam';
import { makeRedactor, envRedactor } from '../worker/redact';
import { WindowBudget } from '../worker/ratelimit';
import { createApi } from '../worker/api';
import { State } from '../worker/state';
import { FakeChain, FakeClock, FakeOutLayer, NEAR1, makeTerms } from './worker/fakes';

class SpyChain extends FakeChain {
  attacks = { create: 0, record: [] as Array<{ id: number; index: number; amount: string }> };
  async attackCreateAsAgent(): Promise<unknown> { this.attacks.create++; return super.attackCreateAsAgent(); }
  async attackRecord(id: number, idx: number, amt: string) { this.attacks.record.push({ id, index: idx, amount: amt }); return super.attackRecord(id, idx, amt); }
}
let clock: FakeClock, chain: SpyChain, ol: FakeOutLayer;
const deps = (over: Partial<RedteamDeps> = {}): RedteamDeps => ({ chain, outlayer: ol, termsFor: async (m) => JSON.parse(m.terms_json ?? 'null') ?? makeTerms(clock), nowS: () => clock.now, redact: makeRedactor(), ...over });
beforeEach(() => { clock = new FakeClock(); chain = new SpyChain(clock); ol = new FakeOutLayer(); });

describe('secret scrubbing', () => {
  const KEY = 'ed25519:' + '5'.repeat(88);
  it('removes exact secrets and secret-shaped strings, and keeps public identifiers', () => {
    const redact = makeRedactor(['super-secret-seed-value']);
    const FAKE_SK = 'sk' + '-abcdefghijklmnopqrstuvwx'; // built at runtime so the repository secret scan does not flag a fake fixture
const text = `seed super-secret-seed-value key ${KEY} Bearer abcdef0123456789 ${FAKE_SK} wk_abcdefghijklmnopqrstuvwx pub ed25519:${'6'.repeat(44)} acct qtagent-68669.testnet tx ${'A'.repeat(44)} wallet ${'e0'.repeat(32)}`;
    const out = redact(text);
    for (const s of ['super-secret-seed-value', KEY, 'abcdef0123456789', FAKE_SK, 'wk_abcdefghijklmnopqrstuvwx']) expect(out).not.toContain(s);
    for (const keep of [`ed25519:${'6'.repeat(44)}`, 'qtagent-68669.testnet', 'A'.repeat(44), 'e0'.repeat(32)]) expect(out).toContain(keep);
  });
  it('ignores short or empty secret values (they would mangle ordinary text)', () => { expect(makeRedactor(['abc', '', undefined])('abc stays')).toBe('abc stays'); });
  it('envRedactor reads the secrets present in the environment', () => {
    const out = envRedactor({ AGENT_SECRET_KEY: 'env-held-secret-123', NEAR_AI_API_KEY: undefined })('leak env-held-secret-123 here');
    expect(out).not.toContain('env-held-secret-123');
  });
  it('an attack whose error text contains a key, a bearer token or the configured secrets answers without them', async () => {
    chain.add(makeTerms(clock), 'small', { status: 'Funded' });
    chain.attackCreateAsAgent = async () => { throw new Error(`rpc says: signer key ${KEY} sent Authorization: Bearer abcdef0123456789 with seed my-custody-seed-string`); };
    const r = await runAttack('non_dao_create', undefined, deps({ redact: makeRedactor(['my-custody-seed-string']) }));
    expect(r.blocked).toBe(true);
    for (const s of [KEY, 'abcdef0123456789', 'my-custody-seed-string']) expect(r.error).not.toContain(s);
  });
  it('a secret cut by the 320-character clip cannot survive as a recognisable half', async () => {
    chain.attackCreateAsAgent = async () => { throw new Error('x'.repeat(300) + KEY); };
    const r = await runAttack('non_dao_create', undefined, deps());
    expect(r.error).not.toMatch(/ed25519:5{10}/);
  });
});

describe('an attack can only be refused', () => {
  it('after_expiry sends nothing to the chain while the mandate can still be funded or is running inside its window', async () => {
    for (const status of ['Approved', 'Funded', 'Executing'] as const) {
      chain = new SpyChain(clock); chain.add(makeTerms(clock), 'small', { status });
      const r = await runAttack('after_expiry', 0, deps({ chain }));
      expect(r.blocked, status).toBe(true); expect(r.layer, status).toContain('executor guard'); expect(chain.attacks.record, status).toEqual([]);
    }
  });
  it('after_expiry hits the contract only where it must refuse for good: terminal mandates and an elapsed window (plus a clock margin)', async () => {
    for (const status of ['Completed', 'Cancelled', 'Expired', 'Settling'] as const) {
      chain = new SpyChain(clock); chain.add(makeTerms(clock), 'small', { status });
      const r = await runAttack('after_expiry', 0, deps({ chain }));
      expect(r.blocked, status).toBe(true); expect(r.layer, status).toContain('contract'); expect(chain.attacks.record.length, status).toBe(1);
    }
    chain = new SpyChain(clock); const t = makeTerms(clock); chain.add(t, 'small', { status: 'Funded' });
    clock.now = t.endTs + 10; // just past the end: inside the 30 s clock margin, so still the guard only
    expect((await runAttack('after_expiry', 0, deps({ chain }))).layer).toContain('executor guard'); expect(chain.attacks.record).toEqual([]);
    clock.now = t.endTs + 40;
    const late = await runAttack('after_expiry', 0, deps({ chain })); expect(late.blocked).toBe(true); expect(late.layer).toContain('contract'); expect(chain.attacks.record.length).toBe(1);
  });
  it('over_budget on an executable mandate is refused by the contract, and never recorded', async () => {
    chain.add(makeTerms(clock), 'small', { status: 'Funded' });
    const r = await runAttack('over_budget', 0, deps());
    expect(r.blocked).toBe(true); expect(chain.attacks.record.length).toBe(1);
    const m = (await chain.getMandate(0))!; expect(BigInt(m.sold)).toBeLessThanOrEqual(BigInt(m.max_sell)); expect(m.chunks).toBe(0);
  });
  it('over_budget: a silent success (the contract ignores an already-recorded index) is INCONCLUSIVE, not a false "accepted"', async () => {
    chain.add(makeTerms(clock), 'small', { status: 'Executing' });
    chain.attackRecord = async () => undefined; // resolves without error and without changing anything
    const r = await runAttack('over_budget', 0, deps());
    expect(r.blocked).toBe(false); expect(r.layer).toBe('n/a'); expect(r.error).toContain('inconclusive');
  });
  it('over_budget: a contract that really did exceed the budget is reported as NOT blocked (honest)', async () => {
    const m = chain.add(makeTerms(clock), 'small', { status: 'Executing' });
    chain.attackRecord = async () => { m.sold = (BigInt(m.max_sell) + 1n).toString(); };
    const r = await runAttack('over_budget', 0, deps());
    expect(r.blocked).toBe(false); expect(r.layer).toBe('none'); expect(r.error).toContain('ACCEPTED');
  });
  it('an explicit target is read straight from the chain, so a worker that lists no old mandates (MANDATE_FROM_ID) can still be attacked on one', async () => {
    chain.add(makeTerms(clock), 'small', { status: 'Completed' });
    chain.listMandates = async () => [];
    const r = await runAttack('over_budget', 0, deps());
    expect(r.blocked).toBe(true); expect(r.layer).toContain('executor guard');
    expect((await runAttack('over_budget', 5, deps())).error).toContain('no mandate exists');
  });
  it('an attack that cannot even run (chain unreachable) is never reported as blocked, and never throws', async () => {
    chain.listMandates = async () => { throw new Error('rpc down'); };
    const r = await runAttack('over_budget', undefined, deps());
    expect(r.blocked).toBe(false); expect(r.layer).toBe('n/a'); expect(r.error).toContain('could not run');
  });
  it('the offline attacks (no contract call) are classified as free; chain and wallet attacks are classified as costly', () => {
    expect(attackCost('wrong_token', {})).toBe('none'); expect(attackCost('unlisted_payout', {})).toBe('none'); expect(attackCost('over_cap', {})).toBe('none');
    for (const a of ['non_dao_create', 'over_budget', 'after_expiry']) expect(attackCost(a, {})).toBe('chain');
    const layerA = { transfer: async () => ({}), verdict: () => ({ blocked: true, status: 403, error: '' }), unlistedTo: 'x', allowedTo: 'y', smallAmount: '1', overCapAmount: '2' };
    expect(attackCost('over_cap', { layerA })).toBe('wallet'); expect(attackCost('unlisted_payout', { layerA })).toBe('wallet');
  });
});

describe('no sealed term leaves through an attack answer', () => {
  it('every attack on a sealed mandate answers without its payout addresses, fee recipient or price floor', async () => {
    const sealedTerms = makeTerms(clock, {
      minPrice: '3.14159265', feeRecipient: 'secret-fee-recipient.near',
      payouts: [{ label: 'carol', chain: 'solana', address: 'SecretSolanaRecipient999999999999999999999', token: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', percent: 50 }],
    });
    chain.add(sealedTerms, 'small', { status: 'Funded', terms_json: null }); // sealed: the chain has only the hash
    const results = [];
    for (const a of ATTACKS) results.push(await runAttack(a, 0, deps({ termsFor: async () => sealedTerms })));
    const all = JSON.stringify(results);
    for (const secret of ['3.14159265', 'secret-fee-recipient.near', 'SecretSolanaRecipient999999999999999999999', String(sealedTerms.chunkMax), sealedTerms.payouts[0]!.label]) expect(all, secret).not.toContain(secret);
    expect(results.filter((r) => r.blocked).length).toBeGreaterThanOrEqual(4); // and they are still real refusals, not blanked answers
  });
});

describe('RedteamGate (what the HTTP API runs)', () => {
  it('answers a repeat of the same attack on the same target from memory, labelled with its age; another target is a fresh attack', async () => {
    let now = 0; chain.add(makeTerms(clock), 'small', { status: 'Funded' }); chain.add(makeTerms(clock), 'small', { status: 'Funded' });
    const g = new RedteamGate(deps(), { nowMs: () => now, cacheTtlS: 600 });
    const a = await g.run('over_budget', 0); now += 90_000; const b = await g.run('over_budget', 0);
    expect(chain.attacks.record.length).toBe(1); expect(a.cachedAgeS).toBeUndefined(); expect(b.cachedAgeS).toBe(90); expect(b.blocked).toBe(a.blocked);
    await g.run('over_budget', 1); expect(chain.attacks.record.length).toBe(2);
    now += 601_000; await g.run('over_budget', 0); expect(chain.attacks.record.length).toBe(3); // the cache expired
  });
  it('shares one attack between concurrent identical requests', async () => {
    const g = new RedteamGate(deps());
    await Promise.all([g.run('non_dao_create', undefined), g.run('non_dao_create', undefined), g.run('non_dao_create', undefined)]);
    expect(chain.attacks.create).toBe(1);
  });
  it('caps on-chain attacks globally: past the hourly budget the answer is NOT RUN (never "blocked"), and the budget refills', async () => {
    let now = 0; for (let i = 0; i < 4; i++) chain.add(makeTerms(clock), 'small', { status: 'Funded' });
    const g = new RedteamGate(deps(), { nowMs: () => now, chainPerHour: 2, chainPerDay: 100 });
    expect((await g.run('over_budget', 0)).blocked).toBe(true); expect((await g.run('over_budget', 1)).blocked).toBe(true);
    const third = await g.run('over_budget', 2);
    expect(third.blocked).toBe(false); expect(third.layer).toBe('n/a'); expect(third.error).toContain('budget'); expect(chain.attacks.record.length).toBe(2);
    expect((await g.run('wrong_token', 0)).blocked).toBe(true); // offline attacks are not affected
    now += 3_600_001; expect((await g.run('over_budget', 2)).blocked).toBe(true); expect(chain.attacks.record.length).toBe(3);
  });
  it('also caps per day, so a steady trickle cannot drain the agent key either', async () => {
    let now = 0; for (let i = 0; i < 5; i++) chain.add(makeTerms(clock), 'small', { status: 'Funded' });
    const g = new RedteamGate(deps(), { nowMs: () => now, chainPerHour: 100, chainPerDay: 3, cacheTtlS: 0 });
    for (let i = 0; i < 3; i++) { await g.run('over_budget', i); now += 4_000_000; } // each in its own hour
    const r = await g.run('over_budget', 3); expect(r.layer).toBe('n/a'); expect(chain.attacks.record.length).toBe(3);
  });
  it('does not charge the budget for an attack that never ran (no mandate to attack), nor remember that answer', async () => {
    const g = new RedteamGate(deps(), { chainPerHour: 1, chainPerDay: 1 });
    for (let i = 0; i < 4; i++) { const r = await g.run('over_budget', 7); expect(r.layer).toBe('n/a'); expect(r.error).toContain('no mandate'); }
    chain.add(makeTerms(clock), 'small', { status: 'Funded' }); // now there is something to attack: the budget is intact
    expect((await g.run('over_budget', 0)).blocked).toBe(true);
  });
  it('rejects malformed input before anything runs', async () => {
    const g = new RedteamGate(deps());
    for (const bad of ['3', -1, 1.5, {}, [1], Number.NaN, 2 ** 60]) { const r = await g.run('over_budget', bad); expect(r.layer, String(bad)).toBe('n/a'); expect(r.blocked).toBe(false); }
    expect((await g.run('drop_table', 0)).error).toContain('unknown attack');
    expect(chain.attacks.record.length + chain.attacks.create).toBe(0);
  });
});

describe('WindowBudget', () => {
  it('slides: units come back one by one as they age out, and refund returns the latest', () => {
    let now = 0; const b = new WindowBudget(2, 1000, () => now);
    expect(b.take().ok).toBe(true); now = 100; expect(b.take().ok).toBe(true);
    const no = b.take(); expect(no.ok).toBe(false); expect(no.retryAfterS).toBe(1);
    now = 1001; expect(b.take().ok).toBe(true); expect(b.take().ok).toBe(false);
    b.refund(); expect(b.remaining()).toBe(1);
  });
});

describe('public HTTP surface', () => {
  async function serve(over: Partial<Parameters<typeof createApi>[0]> = {}) {
    const api = createApi({ state: new State(':memory:', randomBytes(32)), chain, outlayer: ol, redteam: deps(), cfg: { dao: 'dao.near', rpc: 'http://127.0.0.1:1', corsOrigin: '*', authRecipient: 'x' },
      isCouncil: async () => false, nowS: () => clock.now, health: () => ({}), ...over });
    const server = await api.listen(0); return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
  }
  const post = (base: string, path: string, body: unknown, ip = '9.9.9.9') => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });

  it('red-team POSTs are limited per client to 6 a minute (429 + retry-after); another client is unaffected', async () => {
    chain.add(makeTerms(clock), 'small', { status: 'Funded' });
    const srv = await serve();
    try {
      for (let i = 0; i < 6; i++) expect((await post(srv.base, '/api/redteam/wrong_token', {})).status).toBe(200);
      const r = await post(srv.base, '/api/redteam/wrong_token', {}); expect(r.status).toBe(429); expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect((await post(srv.base, '/api/redteam/wrong_token', {}, '8.8.8.8')).status).toBe(200);
    } finally { await srv.close(); }
  });
  it('the red-team route answers through the gate: validation, cache label and the NOT RUN shape the dashboard understands', async () => {
    chain.add(makeTerms(clock), 'small', { status: 'Funded' });
    const srv = await serve();
    try {
      const a: any = await (await post(srv.base, '/api/redteam/over_budget', { mandateId: 0 })).json(); expect(a.blocked).toBe(true); expect(a.cachedAgeS).toBeUndefined();
      const b: any = await (await post(srv.base, '/api/redteam/over_budget', { mandateId: 0 })).json(); expect(b.cachedAgeS).toBeGreaterThanOrEqual(0);
      const bad: any = await (await post(srv.base, '/api/redteam/over_budget', { mandateId: 'abc' })).json(); expect(bad).toMatchObject({ blocked: false, layer: 'n/a', status: null });
    } finally { await srv.close(); }
  });
  it('/api/parse has a GLOBAL budget on top of the per-client limit (it spends the operator\'s AI credits)', async () => {
    let calls = 0;
    const srv = await serve({ parse: async () => { calls++; return { terms: {}, summary: '' }; }, parseBudget: new WindowBudget(2) });
    try {
      expect((await post(srv.base, '/api/parse', { intent: 'x' }, '1.1.1.1')).status).toBe(200);
      expect((await post(srv.base, '/api/parse', { intent: 'x' }, '2.2.2.2')).status).toBe(200);
      const r = await post(srv.base, '/api/parse', { intent: 'x' }, '3.3.3.3'); const j: any = await r.json();
      expect(r.status).toBe(429); expect(j.rule).toBe('parse-global'); expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1); expect(calls).toBe(2);
    } finally { await srv.close(); }
  });
  it('a 500 from the API carries no secret of this process', async () => {
    const SECRET = 'ed25519:' + '7'.repeat(88);
    const old = process.env.AGENT_SECRET_KEY; process.env.AGENT_SECRET_KEY = SECRET;
    chain.listMandates = async () => { throw new Error(`rpc failed for signer ${SECRET}`); };
    const srv = await serve();
    try {
      const r = await fetch(`${srv.base}/api/mandates`); const text = await r.text();
      expect(r.status).toBe(500); expect(text).not.toContain(SECRET); expect(text).toContain('rpc failed');
    } finally { await srv.close(); if (old === undefined) delete process.env.AGENT_SECRET_KEY; else process.env.AGENT_SECRET_KEY = old; }
  });
});

void NEAR1;
