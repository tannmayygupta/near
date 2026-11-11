// NEAR AI Cloud client: private (TEE) inference, attestation, signed responses.
// We use fetch (not the OpenAI SDK) on purpose: signatures cover the EXACT request/response bytes, so we must keep them.
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256Hex } from '../engine/hash';

export const NEAR_AI_BASE = 'https://cloud-api.near.ai';
export const DEFAULT_MODEL = 'z-ai/glm-5.3-flash';

export type NearAiErrorCode =
  | 'NO_KEY' | 'HTTP' | 'NONCE_MISMATCH' | 'MODEL_NOT_CONFIDENTIAL' | 'MODEL_NOT_FOUND'
  | 'BAD_RESPONSE' | 'SIGNATURE_UNAVAILABLE' | 'BAD_SIGNATURE';

export class NearAiError extends Error {
  constructor(public code: NearAiErrorCode, message: string, public status?: number) {
    super(message);
    this.name = 'NearAiError';
  }
}

export interface NearAiConfig {
  baseUrl?: string;
  apiKey?: string; // defaults to env NEAR_AI_API_KEY
  fetch?: typeof fetch;
}

export interface ModelInfo { modelId: string; verifiable: boolean; providerType?: string; attestationSupported?: boolean; aliases: string[] }

/** Only vLLM models inside NEAR's own TEEs are "confidential": incognito (OpenAI/Anthropic/...) and 3P providers are NOT. */
export const isConfidentialModel = (m: ModelInfo): boolean =>
  m.verifiable === true && m.providerType === 'vllm' && m.attestationSupported === true;

export interface AttestationReport {
  gateway_attestation: { request_nonce: string; signing_address: string; signing_algo: string; intel_quote: string; [k: string]: unknown };
  model_attestations?: Array<{ request_nonce: string; signing_address: string; signing_algo: string; intel_quote?: string; nvidia_payload?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

export interface SignatureRecord { text: string; signature: string; signing_address: string; signing_algo: string; signature_kind?: string }

export interface SignedCompletion {
  model: string;
  chatId: string;
  content: string;
  requestBody: string;
  responseBody: string;
  requestHash: string;
  responseHash: string;
  signature: SignatureRecord;
  fetchedAt: string;
}

export class NearAiClient {
  private base: string;
  private key?: string;
  private f: typeof fetch;
  constructor(cfg: NearAiConfig = {}) {
    this.base = (cfg.baseUrl ?? NEAR_AI_BASE).replace(/\/$/, '');
    this.key = cfg.apiKey ?? process.env.NEAR_AI_API_KEY;
    this.f = cfg.fetch ?? fetch;
  }

  private headers(auth: boolean): Record<string, string> {
    const h: Record<string, string> = { 'x-no-aliasing': 'true' };
    if (auth) {
      if (!this.key) throw new NearAiError('NO_KEY', 'NEAR_AI_API_KEY is not set');
      h.authorization = `Bearer ${this.key}`;
    }
    return h;
  }

  async listModels(): Promise<ModelInfo[]> {
    const r = await this.f(`${this.base}/v1/model/list`);
    if (!r.ok) throw new NearAiError('HTTP', `model list ${r.status}`, r.status);
    const j: any = await r.json();
    if (!Array.isArray(j?.models)) throw new NearAiError('BAD_RESPONSE', 'model list has no models[]');
    return j.models.map((m: any) => ({
      modelId: String(m.modelId),
      verifiable: m.metadata?.verifiable === true,
      providerType: m.metadata?.providerType,
      attestationSupported: m.metadata?.attestationSupported === true,
      aliases: Array.isArray(m.metadata?.aliases) ? m.metadata.aliases : [],
    }));
  }

  /** Resolve a name or alias to the canonical id and REFUSE anything that is not a confidential TEE model. */
  async resolveConfidentialModel(name = DEFAULT_MODEL): Promise<string> {
    const models = await this.listModels();
    const m = models.find((x) => x.modelId === name) ?? models.find((x) => x.aliases.includes(name));
    if (!m) throw new NearAiError('MODEL_NOT_FOUND', `model ${name} not in live list`);
    if (!isConfidentialModel(m)) throw new NearAiError('MODEL_NOT_CONFIDENTIAL', `${m.modelId} is not a confidential TEE model; refusing to send private text`);
    return m.modelId;
  }

  /** Attestation needs NO key. Nonce: 32 random bytes as 64 hex chars, echoed back and checked. */
  async fetchAttestation(model: string, nonce: string = randomBytes(32).toString('hex')): Promise<{ report: AttestationReport; nonce: string }> {
    if (!/^[0-9a-f]{64}$/.test(nonce)) throw new NearAiError('BAD_RESPONSE', 'nonce must be 64 lowercase hex chars');
    const q = new URLSearchParams({ model, provider: 'near', signing_algo: 'ecdsa', nonce });
    const r = await this.f(`${this.base}/v1/attestation/report?${q}`, { headers: this.headers(false) });
    if (!r.ok) throw new NearAiError('HTTP', `attestation ${r.status}`, r.status);
    const report = (await r.json()) as AttestationReport;
    checkNonceBinding(report, nonce);
    return { report, nonce };
  }

  /** Signature needs a key and EXPIRES (~60 min): call right after the completion. */
  async fetchSignature(chatId: string, model: string): Promise<SignatureRecord> {
    const q = new URLSearchParams({ signing_algo: 'ecdsa', model });
    const r = await this.f(`${this.base}/v1/signature/${encodeURIComponent(chatId)}?${q}`, { headers: this.headers(true) });
    if (!r.ok) throw new NearAiError('SIGNATURE_UNAVAILABLE', `signature ${r.status}`, r.status);
    const j: any = await r.json();
    if (!j?.text || !j?.signature || !j?.signing_address) throw new NearAiError('SIGNATURE_UNAVAILABLE', 'signature record incomplete');
    return j as SignatureRecord;
  }

  /** Chat completion that keeps the exact bytes, then immediately fetches the signature. */
  async signedCompletion(opts: { model?: string; system: string; user: string; temperature?: number; maxTokens?: number }): Promise<SignedCompletion> {
    const model = await this.resolveConfidentialModel(opts.model ?? DEFAULT_MODEL);
    const requestBody = JSON.stringify({
      model,
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens ?? 1500,
      messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }],
    });
    const r = await this.f(`${this.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...this.headers(true), 'content-type': 'application/json', 'accept-encoding': 'identity' },
      body: requestBody,
    });
    const responseBody = await r.text();
    if (!r.ok) throw new NearAiError('HTTP', `chat ${r.status}: ${responseBody.slice(0, 200)}`, r.status);
    let parsed: any;
    try { parsed = JSON.parse(responseBody); } catch { throw new NearAiError('BAD_RESPONSE', 'chat response not JSON'); }
    const chatId: string | undefined = parsed?.id;
    const content: string | undefined = parsed?.choices?.[0]?.message?.content;
    if (!chatId || typeof content !== 'string') throw new NearAiError('BAD_RESPONSE', 'missing id/content');
    const signature = await this.fetchSignature(chatId, model);
    return { model, chatId, content, requestBody, responseBody, requestHash: sha256Hex(requestBody), responseHash: sha256Hex(responseBody), signature, fetchedAt: new Date().toISOString() };
  }
}

// ---------- verification (pure functions, no network) ----------

export function checkNonceBinding(report: AttestationReport, nonce: string): void {
  if (report.gateway_attestation?.request_nonce !== nonce) throw new NearAiError('NONCE_MISMATCH', 'gateway nonce not echoed');
  for (const m of report.model_attestations ?? [])
    if (m.request_nonce !== nonce) throw new NearAiError('NONCE_MISMATCH', 'model attestation nonce not echoed');
}

/** Addresses the TEE attests it signs with (gateway + each model attestation), lowercase 0x... */
export const attestedSigners = (report: AttestationReport): string[] =>
  [report.gateway_attestation?.signing_address, ...(report.model_attestations ?? []).map((m) => m.signing_address)]
    .filter((a): a is string => typeof a === 'string').map((a) => a.toLowerCase());

export const expectedSignatureText = (model: string, requestBody: string, responseBody: string, kind: 'provider_tee' | 'gateway' = 'provider_tee'): string =>
  kind === 'gateway' ? `${sha256Hex(requestBody)}:${sha256Hex(responseBody)}` : `${model}:${sha256Hex(requestBody)}:${sha256Hex(responseBody)}`;

/** EIP-191 personal_sign recovery -> lowercase 0x address. */
export function recoverEip191(text: string, signatureHex: string): string {
  const sig = hexToBytes(signatureHex.replace(/^0x/, ''));
  if (sig.length !== 65) throw new NearAiError('BAD_SIGNATURE', 'signature must be 65 bytes');
  let v = sig[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new NearAiError('BAD_SIGNATURE', 'bad recovery byte');
  const msg = utf8ToBytes(text);
  const prefix = utf8ToBytes(`\u0019Ethereum Signed Message:\n${msg.length}`);
  const hash = keccak_256(new Uint8Array([...prefix, ...msg]));
  const pub = secp256k1.Signature.fromBytes(sig.slice(0, 64), 'compact').addRecoveryBit(v).recoverPublicKey(hash).toBytes(false);
  return '0x' + bytesToHex(keccak_256(pub.slice(1)).slice(12));
}

export interface SignatureCheck { ok: boolean; checks: Array<{ name: string; ok: boolean; detail?: string }> }

/** Full receipt check: text matches the exact bytes, signature recovers to the signer, signer is one the TEE attested. */
export function verifySignedCompletion(rec: Pick<SignedCompletion, 'model' | 'requestBody' | 'responseBody' | 'signature'>, report?: AttestationReport): SignatureCheck {
  const checks: SignatureCheck['checks'] = [];
  const kind = (rec.signature.signature_kind as any) === 'gateway' ? 'gateway' : 'provider_tee';
  const want = expectedSignatureText(rec.model, rec.requestBody, rec.responseBody, kind);
  checks.push({ name: 'signed text matches sha256(request):sha256(response)', ok: rec.signature.text === want });
  let recovered = '';
  try { recovered = recoverEip191(rec.signature.text, rec.signature.signature); } catch (e: any) { checks.push({ name: 'signature recovers', ok: false, detail: e.message }); }
  if (recovered) {
    checks.push({ name: 'recovered signer == claimed signing_address', ok: recovered === rec.signature.signing_address.toLowerCase(), detail: recovered });
    if (report) checks.push({ name: 'signer is attested by the TEE report', ok: attestedSigners(report).includes(recovered) });
  }
  return { ok: checks.every((c) => c.ok), checks };
}
