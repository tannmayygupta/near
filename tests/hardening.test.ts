import { describe, expect, it } from 'vitest';
import { validateEnv, accountBelongsTo, classifyPermission, agentKeyProblems } from '../worker/config';
import { RateLimiter, clientBucket, clientIp } from '../worker/ratelimit';
import { Alerts, TelegramSink, type AlertSink } from '../worker/alerts';
import { evaluate, monitorOnce, DEFAULT_THRESHOLDS } from '../worker/monitor';
import { RefPriceGuard, ReferenceUnavailable, inBand } from '../worker/adapters/price-guard';
import { parseMandateEvents } from '../src/near/mandate';

const KEY = 'ed25519:' + '3'.repeat(88);
const good = { NEAR_NETWORK: 'testnet', EXEC_MODE: 'testnet-outlayer', DAO_ACCOUNT: 'dao.sputnikv2.testnet', MANDATE_CONTRACT: 'qt.testnet', AGENT_ACCOUNT_ID: 'agent.testnet', AGENT_SECRET_KEY: KEY, CUSTODY_SEED: 'seed', SIM_QUOTE_RECIPIENT: '0x1111111111111111111111111111111111111111', CUSTODY_OWNER_KEY: KEY };

describe('startup config guard', () => {
  it('accepts a complete testnet custody configuration', () => {
    const r = validateEnv(good); expect(r.ok).toBe(true);
    if (r.ok) expect(r.cfg).toMatchObject({ network: 'testnet', execMode: 'testnet-outlayer', port: 8787 });
  });
  it('lists EVERY problem at once, not just the first', () => {
    const r = validateEnv({ NEAR_NETWORK: 'testnet', EXEC_MODE: 'testnet-real' });
    expect(r.ok).toBe(false);
    if (!r.ok) { for (const k of ['DAO_ACCOUNT', 'MANDATE_CONTRACT', 'AGENT_ACCOUNT_ID', 'AGENT_SECRET_KEY', 'VAULT_ACCOUNT_ID', 'VAULT_SECRET_KEY']) expect(r.problems.join('\n')).toContain(k); }
  });
  it('refuses a cross-network mix-up (a .near account on testnet, a .testnet account on mainnet)', () => {
    const r1 = validateEnv({ ...good, MANDATE_CONTRACT: 'qt.near' }); expect(r1.ok).toBe(false);
    const r2 = validateEnv({ ...good, NEAR_NETWORK: 'mainnet', EXEC_MODE: 'live', OUTLAYER_WK: 'wk_x', ALLOW_MAINNET: '1', SEALED_TERMS_KEY: 'ab'.repeat(32) }); expect(r2.ok).toBe(false);
    expect(accountBelongsTo('testnet', 'a'.repeat(64))).toBe(true); // implicit accounts exist on both
  });
  it('mainnet needs an explicit opt-in and a real sealed-terms key; real-money testnet modes refuse mainnet', () => {
    const base = { ...good, NEAR_NETWORK: 'mainnet', DAO_ACCOUNT: 'dao.sputnik-dao.near', MANDATE_CONTRACT: 'qt.near', AGENT_ACCOUNT_ID: 'agent.near', EXEC_MODE: 'live', OUTLAYER_WK: 'wk_x' };
    const r = validateEnv(base); expect(r.ok).toBe(false); if (!r.ok) { expect(r.problems.join('\n')).toContain('ALLOW_MAINNET'); expect(r.problems.join('\n')).toContain('SEALED_TERMS_KEY'); }
    expect(validateEnv({ ...base, ALLOW_MAINNET: '1', SEALED_TERMS_KEY: 'ab'.repeat(32) }).ok).toBe(true);
    const t = validateEnv({ ...base, EXEC_MODE: 'testnet-real', ALLOW_MAINNET: '1', SEALED_TERMS_KEY: 'ab'.repeat(32), VAULT_ACCOUNT_ID: 'v.near', VAULT_SECRET_KEY: KEY }); expect(t.ok).toBe(false);
  });
  it('validates key and port formats', () => {
    expect(validateEnv({ ...good, AGENT_SECRET_KEY: 'not-a-key' }).ok).toBe(false);
    expect(validateEnv({ ...good, PORT: '99999' }).ok).toBe(false);
    expect(validateEnv({ ...good, SEALED_TERMS_KEY: 'zz' }).ok).toBe(false);
  });
  it('warns when the agent key must double as the wallet-policy owner', () => {
    const { CUSTODY_OWNER_KEY, ...rest } = good; void CUSTODY_OWNER_KEY;
    const r = validateEnv(rest); expect(r.ok).toBe(true); if (r.ok) expect(r.warnings.join(' ')).toContain('CUSTODY_OWNER_KEY');
  });
  it('classifies the agent key: full access is a problem; the exact 5-method function-call key is not', () => {
    expect(agentKeyProblems(classifyPermission('FullAccess'), 'qt.testnet')[0]).toContain('FULL ACCESS');
    const scoped = classifyPermission({ FunctionCall: { receiver_id: 'qt.testnet', method_names: ['mark_funded', 'record_chunk', 'begin_settlement', 'complete', 'expire'] } });
    expect(agentKeyProblems(scoped, 'qt.testnet')).toEqual([]);
    expect(agentKeyProblems(scoped, 'other.testnet').join(' ')).toContain('not the mandate contract');
    expect(agentKeyProblems(classifyPermission({ FunctionCall: { receiver_id: 'qt.testnet', method_names: ['create_mandate'] } }), 'qt.testnet').join(' ')).toContain('extra methods');
    expect(agentKeyProblems(classifyPermission({ FunctionCall: { receiver_id: 'qt.testnet', method_names: [] } }), 'qt.testnet').join(' ')).toContain('no method restriction');
  });
});

describe('rate limiter', () => {
  it('allows up to the tier limit per window, then answers retry-after; the next window resets', () => {
    let now = 1_000_000; const rl = new RateLimiter({ now: () => now });
    for (let i = 0; i < 20; i++) expect(rl.check('1.2.3.4', '/api/parse').ok).toBe(true);
    const blocked = rl.check('1.2.3.4', '/api/parse'); expect(blocked.ok).toBe(false); expect(blocked.retryAfterS).toBeGreaterThanOrEqual(1);
    expect(rl.check('5.6.7.8', '/api/parse').ok).toBe(true); // another client is unaffected
    now += 61_000; expect(rl.check('1.2.3.4', '/api/parse').ok).toBe(true);
  });
  it('tiers: expensive routes are tight, plain reads are generous, and tiers do not share a bucket', () => {
    const rl = new RateLimiter({ now: () => 5 });
    for (let i = 0; i < 20; i++) rl.check('9.9.9.9', '/api/parse');
    expect(rl.check('9.9.9.9', '/api/mandates').ok).toBe(true);
    expect(rl.check('9.9.9.9', '/api/mandates/3/terms').limit).toBe(20);
    expect(rl.check('9.9.9.9', '/api/redteam/run').limit).toBe(6); // strict: tighter than parse/auth (20)
  });
  it('buckets IPv6 by /64 and unwraps IPv4-mapped addresses', () => {
    expect(clientBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(clientBucket('2001:db8:1:2:1111:2222:3333:4444'));
    expect(clientBucket('2001:db8:1:3::1')).not.toBe(clientBucket('2001:db8:1:2::1'));
    expect(clientBucket('::ffff:10.0.0.7')).toBe('10.0.0.7');
  });
  it('trusts X-Forwarded-For only when the peer is loopback', () => {
    expect(clientIp('127.0.0.1', '8.8.8.8, 10.0.0.1')).toBe('8.8.8.8');
    expect(clientIp('203.0.113.9', '8.8.8.8')).toBe('203.0.113.9'); // spoofed header from the open internet is ignored
  });
  it('sweeps expired windows', () => {
    let now = 0; const rl = new RateLimiter({ now: () => now }); rl.check('a', '/x'); rl.check('b', '/x'); expect(rl.size()).toBe(2);
    now = 130_000; rl.check('c', '/x'); expect(rl.size()).toBe(1);
  });
});

describe('alerts', () => {
  const sink = (results: Array<'sent' | 'retry' | 'refused'>) => { const sent: string[] = []; const s: AlertSink = { send: async (t) => { sent.push(t); return results.shift() ?? 'sent'; } }; return { s, sent }; };
  it('de-duplicates the same condition for an hour even when the numbers change, then tells again', async () => {
    let now = 0; const { s, sent } = sink([]); const a = new Alerts(s, { now: () => now });
    expect(await a.admin('3 purchases stuck')).toBe('sent'); expect(await a.admin('4 purchases stuck')).toBe('deduped');
    expect(sent.length).toBe(1); now = 3_600_001; expect(await a.admin('5 purchases stuck')).toBe('sent');
  });
  it('a failed (retry) send is not remembered, so the next attempt tries again', async () => {
    const { s, sent } = sink(['retry', 'sent']); const a = new Alerts(s, { now: () => 0 });
    expect(await a.admin('vault low')).toBe('retry'); expect(await a.admin('vault low')).toBe('sent'); expect(sent.length).toBe(2);
  });
  it('is disabled (and says so) when no sink is configured', async () => { expect(await new Alerts(null).admin('x')).toBe('disabled'); });
  it('Telegram sink: 429/5xx = retry, other 4xx = refused, ok = sent; the bot token never reaches a log line', async () => {
    const TOKEN = 'SECRET-BOT-TOKEN'; const logs: string[] = [];
    const mk = (status: number | 'throw') => new TelegramSink(TOKEN, '42', (async (url: string) => { if (status === 'throw') throw new Error(`fetch failed for ${url}`); return { ok: status === 200, status } as Response; }) as unknown as typeof fetch, (k, f) => logs.push(k + JSON.stringify(f)));
    expect(await mk(200).send('x')).toBe('sent'); expect(await mk(429).send('x')).toBe('retry'); expect(await mk(500).send('x')).toBe('retry');
    expect(await mk(403).send('x')).toBe('refused'); expect(await mk('throw').send('x')).toBe('retry');
    expect(logs.join('\n')).not.toContain(TOKEN);
  });
});

describe('monitor', () => {
  const base = { nowS: 10_000, lastTickS: 9_990, tickEveryS: 5, needsReview: 0, running: [], vaultNativeYocto: 10n ** 24n };
  it('is quiet when everything is healthy', () => { expect(evaluate(base)).toEqual([]); });
  it('flags a stale tick, items needing a human, a stuck mandate inside its window, and a low vault', () => {
    const f = evaluate({ ...base, lastTickS: 9_000, needsReview: 2, running: [{ id: 7, lastProgressS: 8_000, windowEndS: 12_000 }], vaultNativeYocto: 10n ** 22n });
    expect(f.map((x) => x.key).sort()).toEqual(['needs-review', 'stuck-7', 'tick-stale', 'vault-gas']);
  });
  it('does not call a mandate stuck once its window has ended, and ignores an unreadable vault balance', () => {
    expect(evaluate({ ...base, running: [{ id: 1, lastProgressS: 1_000, windowEndS: 5_000 }], vaultNativeYocto: null })).toEqual([]);
  });
  it('one failing source never hides the others', async () => {
    const told: string[] = []; const a = new Alerts({ send: async (t) => { told.push(t); return 'sent'; } }, { now: () => 0 }); const logs: string[] = [];
    const f = await monitorOnce({ tick: () => { throw new Error('boom'); }, tickEveryS: 5, needsReview: () => 3, running: () => [], vaultNative: async () => 10n ** 24n }, a, 10_000, (k) => logs.push(k), DEFAULT_THRESHOLDS);
    expect(f.map((x) => x.key)).toEqual(['needs-review']); expect(told.length).toBe(1); expect(logs).toContain('monitor_source_failed');
  });
});

describe('reference price guard (fails closed)', () => {
  it('uses a fresh reference, remembers it, and falls back to it for up to an hour when the fetch fails', async () => {
    let now = 0; let next: number | null = 1.7; const g = new RefPriceGuard({ fetch: async () => next, now: () => now, retries: 2, sleep: async () => {} });
    expect(await g.get()).toBe(1.7); next = null; now = 30 * 60_000; expect(await g.get()).toBe(1.7);
  });
  it('REFUSES (throws) when there is no reference and no recent good one, instead of skipping the band', async () => {
    const g = new RefPriceGuard({ fetch: async () => null, retries: 2, sleep: async () => {} }); await expect(g.get()).rejects.toThrow(/refusing to trade/);
    let now = 0; let next: number | null = 2; const g2 = new RefPriceGuard({ fetch: async () => next, now: () => now, retries: 1, sleep: async () => {} });
    await g2.get(); next = null; now = 61 * 60_000; await expect(g2.get()).rejects.toBeInstanceOf(ReferenceUnavailable);
  });
  it('retries a failing fetch before giving up and rejects non-positive or non-finite prices', async () => {
    let calls = 0; const g = new RefPriceGuard({ fetch: async () => (++calls < 3 ? null : 1.5), retries: 3, sleep: async () => {} }); expect(await g.get()).toBe(1.5); expect(calls).toBe(3);
    const bad = new RefPriceGuard({ fetch: async () => 0, retries: 1, sleep: async () => {} }); await expect(bad.get()).rejects.toThrow();
  });
  it('the band keeps a market-like pool and rejects the absurd ones seen on testnet (1e16x and 0.0001x)', () => {
    expect(inBand(4.5, 1.7)).toBe(true); expect(inBand(36.9, 1.7)).toBe(false); expect(inBand(1.07e16, 1.7)).toBe(false); expect(inBand(0.0001, 1.7)).toBe(false); expect(inBand(NaN, 1.7)).toBe(false);
  });
});

describe('NEP-297 event parser (mandate contract v2)', () => {
  const log = (event: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard: 'quiet_treasury', version: '1.0.0', event, data })}`; // the real on-chain shape: data is an object
  it('keeps only quiet_treasury events and ignores plain logs, malformed JSON and other standards', () => {
    const ev = parseMandateEvents([log('chunk_recorded', { id: 1, index: 0 }), 'some plain log', 'EVENT_JSON:{not json', `EVENT_JSON:${JSON.stringify({ standard: 'nep171', event: 'nft_mint', data: [] })}`, log('mandate_completed', { id: 1, report_hash: 'a'.repeat(64) })]);
    expect(ev.map((e) => e.event)).toEqual(['chunk_recorded', 'mandate_completed']);
    expect((ev[1]!.data as { report_hash: string }).report_hash).toBe('a'.repeat(64));
  });
});
