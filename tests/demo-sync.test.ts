import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

// The dashboard serves copies of the recorded runs from app/public/demo-run. A stale copy made /recompute compare an old run with a new proof bundle
// (found 2026-11-14). The copies must be byte-identical to the recorded originals in data/demo-run.
const BOM = new RegExp('^\\uFEFF');
describe('dashboard copies of the recorded runs', () => {
  for (const f of ['run.json', 'custody-run.json', 'sealed-run.json', 'restart-run.json', 'proof-bundle.json', 'custody-proof-bundle.json', 'sealed-proof-bundle.json']) {
    it(`app/public/demo-run/${f} is identical to data/demo-run/${f}`, () => {
      expect(existsSync(`data/demo-run/${f}`)).toBe(true); expect(existsSync(`app/public/demo-run/${f}`)).toBe(true);
      expect(readFileSync(`app/public/demo-run/${f}`, 'utf8')).toBe(readFileSync(`data/demo-run/${f}`, 'utf8'));
    });
  }
  it('every recorded run names the SAME mandate contract as data/testnet-public.json (no run recorded against another deployment)', () => {
    const pub = JSON.parse(readFileSync('data/testnet-public.json', 'utf8').replace(BOM, ''));
    for (const f of ['run.json', 'custody-run.json', 'sealed-run.json', 'restart-run.json']) {
      const r = JSON.parse(readFileSync(`data/demo-run/${f}`, 'utf8').replace(BOM, ''));
      expect(r.ids?.mandateContract, f).toBe(pub.mandateContract);
    }
  });
});
