import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalJson, commit, verifyCommit, hashJson, sha256Hex } from '../src/engine/hash';
import { recoverEip191, verifySignedCompletion, expectedSignatureText, checkNonceBinding, isConfidentialModel, NearAiClient, NearAiError } from '../src/near/ai';

function signEip191(text: string, priv: Uint8Array) {
  const msg = utf8ToBytes(text);
  const hash = keccak_256(new Uint8Array([...utf8ToBytes(`\u0019Ethereum Signed Message:\n${msg.length}`), ...msg]));
  const rec = secp256k1.sign(hash, priv, { prehash: false, format: 'recovered' }) as Uint8Array; // [recovery, r, s]
  const sig = new Uint8Array([...rec.slice(1), rec[0] + 27]);
  const pub = secp256k1.getPublicKey(priv, false);
  return { sig: '0x' + bytesToHex(sig), address: '0x' + bytesToHex(keccak_256(pub.slice(1)).slice(12)) };
}

describe('hash', () => {
  it('canonical json is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [2, { z: 1, y: 2 }] })).toBe(canonicalJson({ a: [2, { y: 2, z: 1 }], b: 1 }));
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
  });
  it('commit/reveal binds terms and salt', () => {
    const terms = { sell: '100', floor: '0.8' };
    const c = commit(terms, 'salt1');
    expect(verifyCommit(terms, 'salt1', c)).toBe(true);
    expect(verifyCommit({ ...terms, floor: '0.7' }, 'salt1', c)).toBe(false);
    expect(verifyCommit(terms, 'salt2', c)).toBe(false);
  });
});

describe('near ai verification', () => {
  const priv = secp256k1.utils.randomSecretKey();
  const model = 'z-ai/glm-5.3-flash';
  const req = JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] });
  const res = JSON.stringify({ id: 'chatcmpl-1', choices: [{ message: { content: 'ok' } }] });
  const text = expectedSignatureText(model, req, res);
  const { sig, address } = signEip191(text, priv);
  const record = { text, signature: sig, signing_address: address, signing_algo: 'ecdsa', signature_kind: 'provider_tee' };
  const report: any = { gateway_attestation: { request_nonce: 'a'.repeat(64), signing_address: '0x' + '1'.repeat(40), signing_algo: 'ecdsa', intel_quote: '00' }, model_attestations: [{ request_nonce: 'a'.repeat(64), signing_address: address, signing_algo: 'ecdsa' }] };

  it('recovers the signer', () => expect(recoverEip191(text, sig)).toBe(address));
  it('accepts a genuine receipt', () => {
    const r = verifySignedCompletion({ model, requestBody: req, responseBody: res, signature: record }, report);
    expect(r.ok).toBe(true);
  });
  it('rejects tampered response bytes', () => {
    const r = verifySignedCompletion({ model, requestBody: req, responseBody: res + ' ', signature: record }, report);
    expect(r.ok).toBe(false);
  });
  it('rejects a signer the TEE did not attest', () => {
    const other = { ...report, model_attestations: [{ ...report.model_attestations[0], signing_address: '0x' + '2'.repeat(40) }] };
    expect(verifySignedCompletion({ model, requestBody: req, responseBody: res, signature: record }, other).ok).toBe(false);
  });
  it('rejects a swapped signature', () => {
    const { sig: other } = signEip191(text, secp256k1.utils.randomSecretKey());
    expect(verifySignedCompletion({ model, requestBody: req, responseBody: res, signature: { ...record, signature: other } }, report).ok).toBe(false);
  });
  it('nonce binding', () => {
    expect(() => checkNonceBinding(report, 'a'.repeat(64))).not.toThrow();
    expect(() => checkNonceBinding(report, 'b'.repeat(64))).toThrow(NearAiError);
  });
  it('only vllm+verifiable+attested models are confidential', () => {
    expect(isConfidentialModel({ modelId: 'a', verifiable: true, providerType: 'vllm', attestationSupported: true, aliases: [] })).toBe(true);
    expect(isConfidentialModel({ modelId: 'b', verifiable: false, providerType: 'external', attestationSupported: false, aliases: [] })).toBe(false);
    expect(isConfidentialModel({ modelId: 'c', verifiable: true, providerType: 'chutes', attestationSupported: true, aliases: [] })).toBe(false);
  });
  it('refuses a non-confidential model before sending any text', async () => {
    const fake = (async (url: string) => {
      if (String(url).endsWith('/v1/model/list')) return new Response(JSON.stringify({ models: [{ modelId: 'openai/gpt-5', metadata: { verifiable: false, providerType: 'external', aliases: [] } }] }));
      throw new Error('should not be called');
    }) as any;
    const c = new NearAiClient({ fetch: fake, apiKey: 'k' });
    await expect(c.signedCompletion({ model: 'openai/gpt-5', system: 's', user: 'secret' })).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIDENTIAL' });
  });
  it('sha256 sanity', () => expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'));
});
