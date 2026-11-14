import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Regression test for a real defect found in the release gate: a shell-quoting slip turned `${TAG}-scoped-key.json` into `-scoped-key.json` in setup.ts,
// so setup would have written a file that the e2e script (which reads `${TAG}-scoped-key.json`) never finds. The two scripts must agree on every secret file name.
const read = (p: string) => readFileSync(p, 'utf8');
const SETUP = read('scripts/mainnet/setup.ts'), E2E = read('scripts/mainnet/e2e-mainnet.ts'), LIB = read('scripts/testnet/lib.ts');
const names = (src: string) => [...src.matchAll(/secretPath\((?:`([^`]*)`|'([^']*)')\)/g)].map((m) => m[1] ?? m[2]);

describe('secret file names are consistent across the mainnet scripts', () => {
  it('no secret file name starts with "-" (a lost ${TAG} prefix)', () => {
    for (const [file, src] of [['setup.ts', SETUP], ['e2e-mainnet.ts', E2E], ['lib.ts', LIB]] as const) for (const n of names(src)) expect(n.startsWith('-'), `${file}: ${n}`).toBe(false);
  });
  it('every name built from the tag really interpolates it', () => {
    for (const src of [SETUP, E2E, LIB]) for (const n of names(src)) if (!/^[a-z]+-[a-z-]+\.json$/.test(n)) expect(n, n).toMatch(/\$\{TAG\}/);
  });
  it('setup.ts writes the agent key file under the exact name e2e-mainnet.ts reads', () => {
    const w = names(SETUP).find((n) => n.includes('scoped-key')), r = names(E2E).find((n) => n.includes('scoped-key'));
    expect(w).toBeDefined(); expect(w).toBe(r);
  });
  it('the owner file and the config file use the tag too', () => {
    expect(names(SETUP)).toContain('${TAG}-owner.json'); expect(names(LIB)).toContain('${TAG}-config.json');
  });
});
