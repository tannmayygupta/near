// Verifier: runs every independent check we can do offline on a proof bundle. Used by the CLI and the dashboard Verify page.
import { verifyCommit } from '../engine/hash';
import { Report, verifyReportHash } from '../engine/settlement';
import { AttestationReport, SignedCompletion, checkNonceBinding, verifySignedCompletion } from '../near/ai';

export interface ProofBundle {
  attestation?: { report: AttestationReport; nonce: string };
  completions?: Array<Pick<SignedCompletion, 'model' | 'requestBody' | 'responseBody' | 'signature'> & { label?: string }>;
  commit?: { terms: unknown; salt: string; hash: string; onChainHash?: string };
  report?: Report;
  /** request bodies revealed after a sealed mandate: each must hash to a signed request_hash */
  reveal?: { requestBodies: string[]; signedRequestHashes: string[] };
}
export interface Check { name: string; ok: boolean; detail?: string }

import { sha256Hex } from '../engine/hash';

export function verifyBundle(b: ProofBundle): { ok: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const run = (name: string, fn: () => boolean | string) => {
    try { const r = fn(); checks.push(typeof r === 'string' ? { name, ok: false, detail: r } : { name, ok: r }); }
    catch (e: any) { checks.push({ name, ok: false, detail: e.message }); }
  };
  if (b.attestation) run('attestation nonce echoed (gateway + models)', () => { checkNonceBinding(b.attestation!.report, b.attestation!.nonce); return true; });
  for (const [i, c] of (b.completions ?? []).entries()) {
    const r = verifySignedCompletion(c, b.attestation?.report);
    for (const k of r.checks) checks.push({ name: `completion ${c.label ?? i}: ${k.name}`, ok: k.ok, detail: k.detail });
  }
  if (b.commit) {
    run('revealed terms + salt match the commitment', () => verifyCommit(b.commit!.terms, b.commit!.salt, b.commit!.hash) || 'hash mismatch');
    if (b.commit.onChainHash) run('commitment equals the on-chain hash', () => b.commit!.hash.toLowerCase() === b.commit!.onChainHash!.toLowerCase() || 'differs from chain');
  }
  if (b.report) {
    run('settlement report hash is intact', () => verifyReportHash(b.report!) || 'report was modified');
    run('every fill respected the price floor', () => b.report!.floorRespected || 'a fill was below the floor');
    run('no violations recorded', () => b.report!.violations.length === 0 || `${b.report!.violations.length} violation(s)`);
  }
  if (b.reveal) {
    const hashes = new Set(b.reveal.signedRequestHashes);
    for (const [i, body] of b.reveal.requestBodies.entries())
      run(`revealed request #${i} hashes to a TEE-signed request hash`, () => hashes.has(sha256Hex(body)) || 'no signed hash matches');
  }
  return { ok: checks.length > 0 && checks.every((c) => c.ok), checks };
}
