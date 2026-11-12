import { describe, it, expect } from 'vitest';
import { commit } from '../src/engine/hash';
import { buildReport } from '../src/engine/settlement';
import { verifyBundle, ProofBundle } from '../src/verify';
import type { SealedEvidence } from '../src/verify/sealed';

const WNEAR = 'nep141:wrap.near';
const USDC_ID = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const NOW = 1_800_000_000;
const DAO = 'club.sputnik-dao.near', ALICE = 'alice.near', BOB = 'bob.near', FEE = 'ops.near';
const SALT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const terms = {
  dao: DAO, treasurer: 'tre.near', sellToken: WNEAR, buyToken: USDC_ID, maxSellAmount: '5000000000000000000000000', minPrice: '3.25',
  startTs: NOW, endTs: NOW + 3600, chunkMin: '1000000000000000000000000', chunkMax: '2000000000000000000000000', intervalMinS: 60, intervalMaxS: 120,
  payouts: [{ label: 'alice', chain: 'near', address: ALICE, token: USDC_ID, percent: 40 }, { label: 'bob', chain: 'near', address: BOB, token: USDC_ID, percent: 10 }],
  feeBps: 50, feeRecipient: FEE, returnTo: DAO, sealed: true,
};
const fills = [
  { index: 0, ts: NOW + 100, amountIn: '2000000000000000000000000', amountOut: '7400000', requestId: 'r0', source: 'chain' as const },
  { index: 1, ts: NOW + 200, amountIn: '1000000000000000000000000', amountOut: '3600000', requestId: 'r1', source: 'chain' as const },
];
const mkReport = (over: Partial<Parameters<typeof buildReport>[0]> = {}) => buildReport({
  mandateId: 3, terms: terms as any, fills, samples: [{ ts: NOW + 50, price: 3.7, source: 'api', origin: 't' }], generatedAt: '2026-11-13T00:00:00.000Z',
  feeAmount: '55000', feeSource: 'chain', violations: [],
  payouts: [{ label: 'alice', chain: 'near', address: ALICE, token: USDC_ID, amount: '4400000', status: 'success', source: 'chain', requestId: 'p0' }, { label: 'bob', chain: 'near', address: BOB, token: USDC_ID, amount: '1100000', status: 'success', source: 'chain', requestId: 'p1' }],
  leftovers: [{ token: WNEAR, amount: '2000000000000000000000000', returnedTo: DAO, source: 'chain' }], ...over,
});
const evidence = (over: Partial<SealedEvidence['onChain']> = {}, pre: Partial<SealedEvidence['publicBefore']> = {}, reveal: { salt: string; terms: any } = { salt: SALT, terms }): SealedEvidence => ({
  onChain: { terms_hash: commit(terms, SALT), terms_json: null, revealed_terms: JSON.stringify(reveal), sell_token: WNEAR, max_sell: terms.maxSellAmount, start_ns: terms.startTs * 1e9, end_ns: terms.endTs * 1e9, ...over },
  publicBefore: { terms_json: null, revealed_terms: null, text: JSON.stringify({ id: 3, terms_hash: commit(terms, SALT), terms_json: null, description: 'sealed mandate: budget 5 wNEAR' }), ...pre },
  forbidden: [ALICE, BOB, FEE, '"minPrice"', '"payouts"', '"minPrice":"3.25"'],
  decimals: { sell: 24, buy: 6 },
});
const verify = (sealed: SealedEvidence, report = mkReport()) => verifyBundle({ report, sealed } as ProofBundle);
const failing = (r: ReturnType<typeof verify>) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe('sealed mandate verification (commit-reveal)', () => {
  it('passes a correct sealed run end to end', () => {
    const r = verify(evidence());
    expect(failing(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks.filter((c) => c.name.startsWith('sealed:')).length).toBeGreaterThanOrEqual(8);
  });
  it('fails when the revealed terms were altered after the commitment (floor changed)', () => {
    const r = verify(evidence({}, {}, { salt: SALT, terms: { ...terms, minPrice: '1.0' } }));
    expect(failing(r)).toContain('sealed: sha256(salt | revealed terms) equals the commitment that was public from the start');
  });
  it('fails when the salt was altered', () => {
    const r = verify(evidence({}, {}, { salt: SALT.replace('a1', 'ff'), terms }));
    expect(failing(r)).toContain('sealed: sha256(salt | revealed terms) equals the commitment that was public from the start');
  });
  it('fails when the salt is too short to resist brute force', () => {
    const short = 'abc';
    const r = verify({ ...evidence(), onChain: { ...evidence().onChain, terms_hash: commit(terms, short), revealed_terms: JSON.stringify({ salt: short, terms }) } });
    expect(failing(r)).toContain('sealed: the commitment had a real salt (>= 16 chars), so low-entropy terms cannot be brute-forced');
  });
  it('fails when terms were public before completion', () => {
    expect(failing(verify(evidence({}, { terms_json: JSON.stringify(terms) })))).toContain('sealed: while the mandate ran the public chain view carried NO terms');
  });
  it('fails when a secret term value leaked into the public pre-reveal view', () => {
    const r = verify(evidence({}, { text: `proposal: pay ${ALICE} at "minPrice":"3.25"` }));
    expect(failing(r)).toContain('sealed: no secret term value (recipients, floor, field names) appears in the public pre-reveal view');
  });
  it('fails when no reveal was published on chain', () => {
    expect(failing(verify(evidence({ revealed_terms: null })))).toContain('sealed: the reveal is published on chain after settlement');
  });
  it('fails when revealed terms disagree with the public budget', () => {
    expect(failing(verify(evidence({ max_sell: '9000000000000000000000000' })))).toContain('sealed: revealed terms match the public on-chain budget (token, max amount, window)');
  });
  it('fails when a fill is below the REVEALED floor (even though the hash is intact)', () => {
    const r = verify(evidence(), mkReport({ fills: [{ ...fills[0], amountOut: '1000000' }] }));
    expect(failing(r)).toContain('sealed: every fill respected the REVEALED price floor');
  });
  it('fails when more than the revealed budget was sold', () => {
    const r = verify(evidence(), mkReport({ fills: [{ ...fills[0], amountIn: '9000000000000000000000000', amountOut: '99000000' }] }));
    expect(failing(r)).toContain('sealed: total sold stayed within the revealed budget');
  });
  it('fails when a payout went to an address that the reveal does not contain', () => {
    const r = verify(evidence(), mkReport({ payouts: [{ label: 'x', chain: 'near', address: 'mallory.near', token: USDC_ID, amount: '1', status: 'success', source: 'chain', requestId: 'p' }] }));
    expect(failing(r)).toContain('sealed: every payout and return went to a revealed recipient (payout list, fee recipient or DAO)');
  });
});
