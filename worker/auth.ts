// NEP-413 signed-message authentication for council-only endpoints (sealed terms).
// Header `x-near-auth` = base64(JSON {accountId, publicKey, signature(base64), message, nonce(base64, 32 bytes), recipient}).
// Checks: signature valid over the NEP-413 hash, key belongs to the account (view_access_key), message fresh (<=5 min) and bound to the action.
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { PublicKey } from 'near-api-js';
import { providerFor } from '../src/near/chain';

export interface AuthHeader { accountId: string; publicKey: string; signature: string; message: string; nonce: string; recipient: string }

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const bstr = (s: string) => { const d = Buffer.from(s, 'utf8'); return Buffer.concat([u32(d.length), d]); };

/** sha256( u32(2^31+413) ++ borsh({message, nonce[32], recipient, callbackUrl: None}) ) */
export function nep413Hash(message: string, nonce: Buffer, recipient: string): Buffer {
  if (nonce.length !== 32) throw new Error('nonce must be 32 bytes');
  const payload = Buffer.concat([bstr(message), nonce, bstr(recipient), Buffer.from([0])]);
  return createHash('sha256').update(Buffer.concat([u32(2147484061), payload])).digest();
}

export function verifySignature(h: AuthHeader): boolean {
  const pk = PublicKey.fromString(h.publicKey);
  if (pk.keyType !== 0) throw new Error('only ed25519 keys are supported');
  return ed25519.verify(Buffer.from(h.signature, 'base64'), nep413Hash(h.message, Buffer.from(h.nonce, 'base64'), h.recipient), pk.data);
}

export interface AuthOpts { rpc: string; recipient: string; nowMs?: () => number; maxAgeMs?: number; isCouncil: (accountId: string) => Promise<boolean> }

/** Returns the authenticated account id, or throws Error with a short reason. `action` must appear in the signed message. */
export async function authenticate(header: string | undefined, action: string, o: AuthOpts): Promise<string> {
  if (!header) throw new Error('missing x-near-auth');
  let h: AuthHeader;
  try { h = JSON.parse(Buffer.from(header, 'base64').toString('utf8')); } catch { throw new Error('malformed x-near-auth'); }
  if (h.recipient !== o.recipient) throw new Error('wrong recipient');
  if (!h.message.includes(action)) throw new Error('message not bound to this action');
  const ts = Number(h.message.split(':').pop());
  const now = (o.nowMs ?? Date.now)();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > (o.maxAgeMs ?? 5 * 60_000)) throw new Error('stale or missing timestamp');
  if (!verifySignature(h)) throw new Error('bad signature');
  try { await providerFor(o.rpc).viewAccessKey({ accountId: h.accountId, publicKey: h.publicKey, blockQuery: { finality: 'final' } } as any); }
  catch { throw new Error('key is not an access key of that account'); }
  if (!(await o.isCouncil(h.accountId))) throw new Error('not a council member');
  return h.accountId;
}
