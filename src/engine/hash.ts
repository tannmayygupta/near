// Canonical JSON + sha256 + commit/reveal helpers (used by parser, report, verifier).
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { randomBytes } from 'node:crypto';

export const sha256Hex = (data: string | Uint8Array): string =>
  bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));

/** Deterministic JSON: object keys sorted recursively, no whitespace, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export const hashJson = (value: unknown): string => sha256Hex(canonicalJson(value));

export const randomSalt = (bytes = 16): string => randomBytes(bytes).toString('hex');

/** commit = sha256(salt | canonicalJson(terms)). Salt stops brute-forcing low-entropy terms. */
export const commit = (terms: unknown, salt: string): string => sha256Hex(`${salt}|${canonicalJson(terms)}`);

export const verifyCommit = (terms: unknown, salt: string, expected: string): boolean =>
  commit(terms, salt) === expected.toLowerCase();
