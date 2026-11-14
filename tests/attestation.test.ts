import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { NearAiError, expectedSignatureText, type SignedCompletion } from '../src/near/ai';
import { sha256Hex } from '../src/engine/hash';
import { AttestationService, type AttestationClient } from '../worker/attestation';
import { createApi } from '../worker/api';
import { State } from '../worker/state';
import { FakeChain, FakeClock, FakeOutLayer } from './worker/fakes';

// ---------- a fake NEAR AI client (no network): it signs for real, so the real verifier code is what judges it ----------
const priv = secp256k1.utils.randomSecretKey();
const ADDRESS = '0x' + bytesToHex(keccak_256(secp256k1.getPublicKey(priv, false).slice(1)).slice(12));
function sign(text: string): string {
  const msg = utf8ToBytes(text);
  const hash = keccak_256(new Uint8Array([...utf8ToBytes(`\u0019Ethereum Signed Message:\n${msg.length}`), ...msg]));
  const rec = secp256k1.sign(hash, priv, { prehash: false, format: 'recovered' }) as Uint8Array;
  return '0x' + bytesToHex(new Uint8Array([...rec.slice(1), rec[0] + 27]));
}
type Fault = { down?: 'model' | 'attestation' | 'completion'; echo?: 'wrong' | 'silent-wrong'; unlistedSigner?: boolean; tamper?: boolean; hang?: boolean; leak?: string };
function fakeClient(f: Fault = {}) {
  const calls = { resolve: 0, attest: 0, complete: 0, nonces: [] as string[] };
  const client: AttestationClient = {
    async resolveConfidentialModel(name) {
      calls.resolve++; if (f.hang) await new Promise(() => {});
      if (f.down === 'model') throw new NearAiError('HTTP', `model list 503 ${f.leak ?? ''}`, 503);
      return name ?? 'test/model';
    },
    async fetchAttestation(_model, nonce = 'f'.repeat(64)) {
      calls.attest++; calls.nonces.push(nonce);
      if (f.down === 'attestation') throw new NearAiError('HTTP', 'attestation 502', 502);
      const echoed = f.echo ? 'e'.repeat(64) : nonce;
      const report: any = {
        gateway_attestation: { request_nonce: echoed, signing_address: '0x' + '1'.repeat(40), signing_algo: 'ecdsa', intel_quote: '00' },
        model_attestations: [{ request_nonce: echoed, signing_address: f.unlistedSigner ? '0x' + '2'.repeat(40) : ADDRESS, signing_algo: 'ecdsa' }],
      };
      if (f.echo === 'wrong') throw new NearAiError('NONCE_MISMATCH', 'gateway nonce not echoed'); // what the real client does itself
      return { report, nonce }; // 'silent-wrong': a client that does not check the echo: the service must catch it
    },
    async signedCompletion(o): Promise<SignedCompletion> {
      calls.complete++;
      if (f.down === 'completion') throw new NearAiError('SIGNATURE_UNAVAILABLE', 'signature 404', 404);
      const model = o.model ?? 'test/model';
      const requestBody = JSON.stringify({ model, messages: [{ role: 'user', content: o.user }] });
      const responseBody = JSON.stringify({ id: 'chatcmpl-test-1234567890', choices: [{ message: { content: 'OK' } }] });
      const text = expectedSignatureText(model, requestBody, responseBody);
      return { model, chatId: 'chatcmpl-test-1234567890', content: 'OK', requestBody, responseBody: f.tamper ? responseBody + ' ' : responseBody, requestHash: sha256Hex(requestBody), responseHash: sha256Hex(responseBody),
        signature: { text, signature: sign(text), signing_address: ADDRESS, signing_algo: 'ecdsa', signature_kind: 'provider_tee' }, fetchedAt: new Date().toISOString() };
    },
  };
  return { client, calls };
}
const svc = (f: Fault = {}, o: Partial<ConstructorParameters<typeof AttestationService>[0]> = {}) => { const c = fakeClient(f); return { ...c, svc: new AttestationService({ client: c.client, hasKey: true, model: 'test/model', redact: (s) => s, ...o }) }; };
const failed = (r: { checks: Array<{ name: string; ok: boolean }> }) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe('attestation check (injected NEAR AI client)', () => {
  it('passes end to end: fresh nonce echoed, signed completion verified, signer listed in the attestation report', async () => {
    const { svc: s, calls } = svc();
    const r = await s.get();
    expect(r.ok).toBe(true); expect(failed(r)).toEqual([]);
    expect(r.model).toBe('test/model'); expect(r.signingAddress).toBe(ADDRESS);
    expect(r.nonce).toMatch(/^[0-9a-f]{64}$/); expect(calls.nonces).toEqual([r.nonce]); // the nonce in the answer is the one NEAR AI was asked to echo
    const names = r.checks.map((c) => c.name).join(' | ');
    for (const part of ['fresh 256-bit nonce', 'confidential TEE model', 'nonce echoed', 'signed text matches','recovered signer == claimed signing_address', 'signing address is listed in the attestation report']) expect(names).toContain(part);
    expect(r.note).toContain('NOT checked'); // the Intel TDX quote is not verified here and the answer says so
    expect(r.checkedAt).toMatch(/^\d{4}-\d\d-\d\dT/); expect(r.ageSeconds).toBe(0);
  });

  it('uses a different nonce for every check', async () => {
    let now = 0; const { svc: s, calls } = svc({}, { nowMs: () => now });
    await s.get(); now += 3_600_001; await s.get();
    expect(calls.nonces.length).toBe(2); expect(calls.nonces[0]).not.toBe(calls.nonces[1]);
  });

  it('fails when the nonce is not echoed, and does not even ask for a completion', async () => {
    const { svc: s, calls } = svc({ echo: 'wrong' });
    const r = await s.get();
    expect(r.ok).toBe(false); expect(failed(r)).toEqual(['nonce echoed by the gateway and every model attestation']); expect(calls.complete).toBe(0);
  });

  it('catches a wrong nonce even when the client itself does not check it', async () => {
    const r = await svc({ echo: 'silent-wrong' }).svc.get();
    expect(r.ok).toBe(false); expect(failed(r)).toContain('nonce echoed by the gateway and every model attestation');
  });

  it('fails when the signing address is not listed in the attestation report', async () => {
    const r = await svc({ unlistedSigner: true }).svc.get();
    expect(r.ok).toBe(false); expect(failed(r)).toEqual(['signing address is listed in the attestation report']);
  });

  it('fails when the signed response bytes were altered', async () => {
    const r = await svc({ tamper: true }).svc.get();
    expect(r.ok).toBe(false); expect(failed(r)).toContain('signed text matches sha256(request):sha256(response)');
  });

  it('without a NEAR AI key: runs the keyless checks, says the signature check was not run, and is ok:false (not a pass)', async () => {
    const { svc: s, calls } = svc({}, { hasKey: false });
    const r = await s.get();
    expect(calls.complete).toBe(0); expect(calls.attest).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.checks.filter((c) => c.ok).length).toBe(4); // nonce, model, report, echo
    const miss = r.checks.find((c) => !c.ok)!; expect(miss.detail).toContain('NEAR_AI_API_KEY');
  });

  it('NEAR AI unreachable at each step: ok:false with the reason, never an exception', async () => {
    for (const down of ['model', 'attestation', 'completion'] as const) {
      const r = await svc({ down }).svc.get();
      expect(r.ok, down).toBe(false); expect(r.checks.some((c) => !c.ok && /503|502|404/.test(c.detail)), down).toBe(true);
    }
  });

  it('a check that hangs ends in ok:false at the time limit instead of hanging the request', async () => {
    const r = await svc({ hang: true }, { runTimeoutMs: 30 }).svc.get();
    expect(r.ok).toBe(false); expect(r.checks[0]!.detail).toContain('timed out');
  });

  it('never puts a configured secret into the answer', async () => {
    const SECRET = 'sk' + '-live-1234567890abcdef1234567890abcdef'; // built at runtime so the repository secret scan does not flag a fake fixture
    const { svc: s } = svc({ down: 'model', leak: SECRET }, { redact: (t) => t.split(SECRET).join('[redacted]') });
    expect(JSON.stringify(await s.get())).not.toContain(SECRET);
  });

  it('caches a good result for an hour (one NEAR AI check, not one per request) and reports its age', async () => {
    let now = 1_000_000; const { svc: s, calls } = svc({}, { nowMs: () => now });
    const a = await s.get(); now += 30 * 60_000; const b = await s.get();
    expect(calls.attest).toBe(1); expect(b.nonce).toBe(a.nonce); expect(b.ageSeconds).toBe(1800); expect(b.checkedAt).toBe(a.checkedAt);
    now += 31 * 60_000; const c = await s.get(); // past the hour: a new live check
    expect(calls.attest).toBe(2); expect(c.nonce).not.toBe(a.nonce); expect(c.ageSeconds).toBe(0);
  });

  it('a failure is cached only briefly (60 s), so NEAR AI is not hammered but recovery is quick', async () => {
    let now = 0; const { svc: s, calls } = svc({ down: 'attestation' }, { nowMs: () => now });
    await s.get(); now += 30_000; await s.get(); expect(calls.attest).toBe(1);
    now += 31_000; await s.get(); expect(calls.attest).toBe(2);
  });

  it('concurrent requests share one live check', async () => {
    const { svc: s, calls } = svc();
    const rs = await Promise.all([s.get(), s.get(), s.get(), s.get()]);
    expect(calls.attest).toBe(1); expect(new Set(rs.map((r) => r.nonce)).size).toBe(1);
  });

  it('health() is a cheap summary of what is cached and never triggers a check', async () => {
    const { svc: s, calls } = svc();
    expect(s.health()).toEqual({ ok: null, ageSeconds: null, checkedAt: null }); expect(calls.attest).toBe(0);
    await s.get(); const h = s.health();
    expect(h.ok).toBe(true); expect(h.ageSeconds).toBe(0); expect(typeof h.checkedAt).toBe('string'); expect(calls.attest).toBe(1);
  });

  it('start() checks once in the background, then a stale good result is refreshed without a request', async () => {
    let now = 0; const { svc: s, calls } = svc({}, { nowMs: () => now });
    const stop = s.start(5);
    await new Promise((r) => setTimeout(r, 40)); expect(calls.attest).toBe(1); expect(s.health().ok).toBe(true);
    now += 46 * 60_000; await new Promise((r) => setTimeout(r, 40)); // 75% of the hour has passed: refreshed ahead of expiry
    expect(calls.attest).toBe(2); stop();
  });
});

describe('GET /attestation and /health on the API', () => {
  async function serve(over: Partial<Parameters<typeof createApi>[0]>) {
    const clock = new FakeClock(); const chain = new FakeChain(clock); const outlayer = new FakeOutLayer();
    const api = createApi({ state: new State(':memory:', randomBytes(32)), chain, outlayer, redteam: { chain, outlayer, termsFor: async () => null, nowS: clock.nowS },
      cfg: { dao: 'dao.near', rpc: 'http://127.0.0.1:1', corsOrigin: 'https://example.github.io', authRecipient: 'x' }, isCouncil: async () => false, nowS: clock.nowS, health: () => ({ lastTick: 1 }), ...over } as never);
    const server = await api.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it('answers with the service result, CORS for the dashboard origin, and the documented fields', async () => {
    const { svc: s } = svc(); const srv = await serve({ attestation: () => s.get() });
    try {
      const r = await fetch(`${srv.base}/attestation`); const j: any = await r.json();
      expect(r.status).toBe(200); expect(r.headers.get('access-control-allow-origin')).toBe('https://example.github.io');
      for (const k of ['ok', 'checkedAt', 'ageSeconds', 'nonce', 'model', 'signingAddress', 'checks']) expect(j).toHaveProperty(k);
      expect(j.ok).toBe(true); expect(Array.isArray(j.checks)).toBe(true);
    } finally { await srv.close(); }
  });

  it('never fails the request: a check that throws, or none configured, is a 200 with ok:false and a reason', async () => {
    const boom = await serve({ attestation: async () => { throw new Error('NEAR AI down'); } });
    const none = await serve({});
    try {
      const a: any = await (await fetch(`${boom.base}/attestation`)).json(); expect(a.ok).toBe(false); expect(JSON.stringify(a)).toContain('NEAR AI down');
      const r = await fetch(`${none.base}/attestation`); const b: any = await r.json(); expect(r.status).toBe(200); expect(b.ok).toBe(false); expect(b.note).toContain('not configured');
    } finally { await boom.close(); await none.close(); }
  });

  it('/health stays exempt from the rate limiter and carries the attestation summary; /attestation is limited like any other route', async () => {
    const { svc: s } = svc(); await s.get();
    const { RateLimiter } = await import('../worker/ratelimit');
    const srv = await serve({ attestation: () => s.get(), health: () => ({ lastTick: 1, attestation: s.health() }), limiter: new RateLimiter({ rules: [{ name: 'tiny', match: /.*/, max: 2 }] }) });
    try {
      for (let i = 0; i < 5; i++) { const h: any = await (await fetch(`${srv.base}/health`)).json(); expect(h.ok).toBe(true); expect(h.attestation.ok).toBe(true); expect(h.attestation.ageSeconds).toBeGreaterThanOrEqual(0); }
      expect((await fetch(`${srv.base}/attestation`)).status).toBe(200); expect((await fetch(`${srv.base}/attestation`)).status).toBe(200);
      expect((await fetch(`${srv.base}/attestation`)).status).toBe(429);
    } finally { await srv.close(); }
  });
});
