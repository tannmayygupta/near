// Live attestation check for the hosted worker (GET /attestation, summarised in GET /health).
// It runs the same checks the independent verifier runs on a proof bundle (src/verify, src/near/ai.ts), but LIVE against NEAR AI Cloud:
//   1. a fresh 256-bit nonce   2. the model is a confidential TEE model   3. an attestation report is fetched for that nonce (no key needed)
//   4. the nonce is echoed by the gateway and every model attestation   5. one cheap signed completion (needs NEAR_AI_API_KEY)
//   6. the signed text matches sha256(request):sha256(response)   7. the signature recovers to the claimed signing address
//   8. that signing address is listed in the attestation report
// NOT checked here (and not claimed): the Intel TDX / NVIDIA quote itself (docs/CLAIMS.md, gate U5).
// The result is cached for up to an hour, refreshed in the background, and the service NEVER throws to its caller: a failure is an ok:false answer with the reason.
import { randomBytes } from 'node:crypto';
import { NearAiError, checkNonceBinding, verifySignedCompletion, type AttestationReport, type SignedCompletion } from '../src/near/ai';
import { envRedactor } from './redact';

/** The slice of NearAiClient this service uses (tests inject fakes). */
export interface AttestationClient {
  resolveConfidentialModel(name?: string): Promise<string>;
  fetchAttestation(model: string, nonce?: string): Promise<{ report: AttestationReport; nonce: string }>;
  signedCompletion(o: { model?: string; system: string; user: string; temperature?: number; maxTokens?: number }): Promise<SignedCompletion>;
}
export interface AttestationCheck { name: string; ok: boolean; detail: string }
export interface AttestationSnapshot {
  ok: boolean; checkedAt: string; ageSeconds: number; nonce: string | null; model: string | null; signingAddress: string | null;
  checks: AttestationCheck[]; note: string;
}
export interface AttestationHealth { ok: boolean | null; ageSeconds: number | null; checkedAt: string | null }
export interface AttestationOptions {
  client: AttestationClient;
  /** whether a NEAR AI key is configured: the signed-completion checks need one (the attestation report itself does not) */
  hasKey: boolean;
  /** model to attest and to sign one completion with (default: the model the private parser uses) */
  model?: string;
  nowMs?: () => number;
  nonce?: () => string;
  /** a good result is served for this long (default 1 h) and refreshed in the background after 75% of it */
  okTtlMs?: number;
  /** a failed result is served for this long, then the next request retries (default 60 s) */
  failTtlMs?: number;
  /** hard cap for one whole check, so a request never hangs on NEAR AI (default 90 s) */
  runTimeoutMs?: number;
  redact?: (text: string) => string;
  log?: (kind: string, fields: Record<string, unknown>) => void;
}

export const ATTESTATION_NOTE = 'Checked: fresh nonce echoed by the gateway and model attestations, one signed completion whose signature recovers to an address the attestation report lists. NOT checked here: the Intel TDX / NVIDIA quote itself (docs/CLAIMS.md).';
const SYSTEM = 'You are a health probe. Reply with the single word OK.';
const RENAME: Record<string, string> = { 'signer is attested by the TEE report': 'signing address is listed in the attestation report' };

export class AttestationService {
  private cache: { at: number; ok: boolean; res: Omit<AttestationSnapshot, 'ageSeconds' | 'checkedAt'> } | null = null;
  private inflight: Promise<void> | null = null;
  private lastNonce = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private o: AttestationOptions) {}
  private get now() { return this.o.nowMs?.() ?? Date.now(); }
  private get redact() { return this.o.redact ?? envRedactor(); }
  private get okTtl() { return this.o.okTtlMs ?? 3_600_000; }
  private get failTtl() { return this.o.failTtlMs ?? 60_000; }
  private errText(e: unknown) { return this.redact(e instanceof NearAiError ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e)).replace(/\s+/g, ' ').slice(0, 240); }

  /** One full check. Never throws. */
  async check(): Promise<Omit<AttestationSnapshot, 'ageSeconds' | 'checkedAt'>> {
    const checks: AttestationCheck[] = []; const add = (name: string, ok: boolean, detail = '') => { checks.push({ name, ok, detail }); };
    const nonce = this.o.nonce?.() ?? randomBytes(32).toString('hex');
    let model: string | null = null; let signingAddress: string | null = null;
    const done = () => ({ ok: checks.length > 0 && checks.every((c) => c.ok), nonce, model, signingAddress, checks, note: ATTESTATION_NOTE });
    try {
      add('fresh 256-bit nonce for this check', /^[0-9a-f]{64}$/.test(nonce) && nonce !== this.lastNonce, nonce.slice(0, 16) + '...');
      this.lastNonce = nonce;
      try { model = await this.o.client.resolveConfidentialModel(this.o.model); add('model is a confidential TEE model', true, model); }
      catch (e) { add('model is a confidential TEE model', false, this.errText(e)); return done(); }

      let report: AttestationReport;
      try {
        const r = await this.o.client.fetchAttestation(model, nonce); report = r.report;
        const n = report.model_attestations?.length ?? 0;
        add('attestation report fetched for this nonce (no key needed)', true, `gateway signer ${String(report.gateway_attestation?.signing_address ?? '?').slice(0, 12)}..., ${n} model attestation(s)`);
      } catch (e) {
        if (e instanceof NearAiError && e.code === 'NONCE_MISMATCH') { add('attestation report fetched for this nonce (no key needed)', true, 'received'); add('nonce echoed by the gateway and every model attestation', false, this.errText(e)); }
        else add('attestation report fetched for this nonce (no key needed)', false, this.errText(e));
        return done();
      }
      try { checkNonceBinding(report, nonce); add('nonce echoed by the gateway and every model attestation', true, 'echoed'); }
      catch (e) { add('nonce echoed by the gateway and every model attestation', false, this.errText(e)); return done(); }

      if (!this.o.hasKey) { add('one signed completion (signature check)', false, 'NEAR_AI_API_KEY is not set on this worker, so the signature check was not run'); return done(); }
      let c: SignedCompletion;
      try { c = await this.o.client.signedCompletion({ model, system: SYSTEM, user: 'ping', maxTokens: 512 }); add('one signed completion received with its signature', true, `chat ${c.chatId.slice(0, 18)}`); }
      catch (e) { add('one signed completion received with its signature', false, this.errText(e)); return done(); }
      signingAddress = c.signature.signing_address?.toLowerCase() ?? null;
      for (const k of verifySignedCompletion(c, report).checks) add(RENAME[k.name] ?? k.name, k.ok, k.detail ?? '');
    } catch (e) { add('attestation check ran to completion', false, this.errText(e)); }
    return done();
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`attestation check timed out after ${ms / 1000}s`)), ms);
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  private async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    const p = (async () => {
      let res: Omit<AttestationSnapshot, 'ageSeconds' | 'checkedAt'>;
      try { res = await this.withTimeout(this.check(), this.o.runTimeoutMs ?? 90_000); }
      catch (e) { res = { ok: false, nonce: null, model: this.o.model ?? null, signingAddress: null, checks: [{ name: 'attestation check ran to completion', ok: false, detail: this.errText(e) }], note: ATTESTATION_NOTE }; }
      this.cache = { at: this.now, ok: res.ok, res };
      this.o.log?.('attestation_checked', { ok: res.ok, model: res.model, failed: res.checks.filter((c) => !c.ok).map((c) => c.name) });
    })().finally(() => { this.inflight = null; });
    this.inflight = p; return p;
  }

  private stale(): boolean { return !this.cache || this.now - this.cache.at >= (this.cache.ok ? this.okTtl : this.failTtl); }
  private snap(): AttestationSnapshot | null {
    if (!this.cache) return null;
    return { ...this.cache.res, checkedAt: new Date(this.cache.at).toISOString(), ageSeconds: Math.max(0, Math.round((this.now - this.cache.at) / 1000)) };
  }

  /** For GET /attestation: the cached result when fresh, otherwise one (shared) live check. Never throws. */
  async get(): Promise<AttestationSnapshot> {
    if (this.stale()) { try { await this.refresh(); } catch { /* refresh() never rejects; defensive */ } }
    return this.snap() ?? { ok: false, checkedAt: new Date(this.now).toISOString(), ageSeconds: 0, nonce: null, model: this.o.model ?? null, signingAddress: null, checks: [], note: ATTESTATION_NOTE };
  }

  /** For GET /health: whatever is cached right now (never triggers a check). */
  health(): AttestationHealth {
    const s = this.snap();
    return s ? { ok: s.ok, ageSeconds: s.ageSeconds, checkedAt: s.checkedAt } : { ok: null, ageSeconds: null, checkedAt: null };
  }

  /** Check once now (in the background), then keep the result fresh: refresh after 75% of the good-result TTL, retry a failure after its short TTL. */
  start(pollMs = 30_000): () => void {
    void this.refresh();
    this.timer = setInterval(() => { if (this.cache && this.now - this.cache.at >= (this.cache.ok ? this.okTtl * 0.75 : this.failTtl)) void this.refresh(); }, pollMs);
    this.timer.unref?.();
    return () => { if (this.timer) clearInterval(this.timer); };
  }
}
