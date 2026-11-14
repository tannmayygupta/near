import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PAYOUT_RUNS, isNearAccountId, normalizeAccount, payoutRowsOf, recipientsIn, rowsFor, totalsOf, type PayoutRow } from '../app/lib/payouts';

// The /me page ("My payouts") reads the four recorded runs the dashboard serves and lists what one account received. These tests run the same
// functions on the REAL recorded files, so a change in a run file's shape (or a row dropped by mistake) fails here instead of on the page.
const BOM = new RegExp('^\\uFEFF');
const load = (file: string) => JSON.parse(readFileSync(`app/public${file}`, 'utf8').replace(BOM, ''));
const all: PayoutRow[] = PAYOUT_RUNS.flatMap((r) => payoutRowsOf(r.key, load(r.file)));
const CONTRIB = 'qtcontrib-68669.testnet', DAO = 'quietdao-83872.sputnikv2.testnet', FEE = 'qtfund-83872.testnet';

describe('my payouts: rows from the recorded runs', () => {
  it('every transfer row in every run file becomes exactly one row, with its transaction hash', () => {
    for (const r of PAYOUT_RUNS) {
      const run = load(r.file);
      const expected = (run.real?.payouts ?? run.payouts ?? []).length + (run.cancelRun?.items ?? []).length;
      const rows = payoutRowsOf(r.key, run);
      expect(rows.length, r.key).toBe(expected);
      expect(rows.length, r.key).toBeGreaterThan(0);
      for (const x of rows) { expect(x.tx, `${r.key} ${x.kind}`).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/); expect(x.status).toBe('success'); }
    }
  });

  it('a contributor is found in all four runs with the exact recorded amounts (USDT.e, 6 decimals)', () => {
    const mine = rowsFor(CONTRIB, all);
    expect(mine.map((r) => r.runKey).sort()).toEqual(['custody', 'real', 'restart', 'sealed']);
    expect(mine.every((r) => r.unit === 'USDT.e' && r.decimals === 6 && r.kind === 'payout')).toBe(true);
    expect(mine.find((r) => r.runKey === 'real')!.amount).toBe(load('/demo-run/run.json').real.payouts.find((p: any) => p.to === CONTRIB).amount);
    expect(mine.find((r) => r.runKey === 'real')!.amount).toBe('751457');
  });

  it('the fee account gets fee rows only; the DAO gets the returns, and return_sell is native NEAR with 24 decimals', () => {
    expect(rowsFor(FEE, all).every((r) => r.kind === 'fee')).toBe(true);
    const dao = rowsFor(DAO, all);
    expect(dao.some((r) => r.kind === 'return_buy' && r.unit === 'USDT.e')).toBe(true);
    const sells = dao.filter((r) => r.kind === 'return_sell');
    expect(sells.length).toBeGreaterThan(0);
    expect(sells.every((r) => r.unit === 'NEAR' && r.decimals === 24 && r.part === 'cancelled')).toBe(true);
  });

  it('sealed rows are flagged as sealed, others are not; mandate ids come from the run file', () => {
    expect(all.filter((r) => r.sealed).every((r) => r.runKey === 'sealed')).toBe(true);
    expect(all.filter((r) => r.runKey === 'sealed').every((r) => r.sealed && r.mandateId === load('/demo-run/sealed-run.json').mandateId)).toBe(true);
    expect(all.filter((r) => r.runKey === 'real' && r.part === 'completed').every((r) => r.mandateId === load('/demo-run/run.json').mandate.id)).toBe(true);
  });

  it('an account that was never paid has no rows (the page shows an explicit empty state), and a near-miss id matches nothing', () => {
    expect(rowsFor('nobody-at-all.testnet', all)).toEqual([]);
    expect(rowsFor(CONTRIB.toUpperCase(), all)).toEqual([]); // matching is exact; the page lower-cases the input first
    expect(totalsOf([])).toEqual([]);
  });

  it('totals add only successful rows and keep units apart', () => {
    const t = totalsOf(rowsFor(DAO, all));
    expect(t.find((x) => x.unit === 'NEAR')).toBeTruthy();
    const usdt = rowsFor(DAO, all).filter((r) => r.unit === 'USDT.e').reduce((s, r) => s + BigInt(r.amount), 0n).toString();
    expect(t.find((x) => x.unit === 'USDT.e')!.amount).toBe(usdt);
    const failed: PayoutRow = { ...all[0], status: 'failed', amount: '999' };
    expect(totalsOf([failed])).toEqual([]);
    const unknown: PayoutRow = { ...all[0], unit: 'raw', decimals: 0, tokenId: 'nep141:other.testnet' };
    expect(totalsOf([unknown])).toEqual([]); // a token this page cannot read is listed raw, never summed with USDT.e
  });

  it('malformed rows are skipped, never guessed', () => {
    const rows = payoutRowsOf('real', { recordedAt: 'x', real: { payouts: [{ kind: 'payout', to: 'a.testnet', amount: '1.5', tx: 't' }, { kind: 'payout', amount: '5' }, { kind: 'payout', to: 'b.testnet', amount: '5', tx: 't', status: 'success' }] } });
    expect(rows.map((r) => r.to)).toEqual(['b.testnet']);
  });

  it('every recipient list entry is a valid NEAR account id', () => {
    const ids = recipientsIn(all);
    expect(ids).toContain(CONTRIB);
    expect(ids.every(isNearAccountId)).toBe(true);
  });
});

describe('my payouts: account id input', () => {
  it('accepts named, sub-account and 64-hex implicit ids', () => {
    for (const ok of ['alice.testnet', 'quietdao-83872.sputnikv2.testnet', 'a_b-c.d.testnet', 'ab', '98b125dbd9790b6fd836825fb3b94d0f23df6e931fad5ad62fd74f14739f89f7']) expect(isNearAccountId(ok), ok).toBe(true);
  });
  it('rejects empty, too short/long, uppercase, spaces and stray separators', () => {
    for (const bad of ['', 'a', 'Alice.testnet', 'al ice.testnet', '.testnet', 'alice..testnet', 'alice.', '-alice.testnet', 'a'.repeat(65), 'alice@testnet', 'http://x']) expect(isNearAccountId(bad), bad).toBe(false);
  });
  it('normalizeAccount trims and lower-cases', () => { expect(normalizeAccount('  QTContrib-68669.TESTNET ')).toBe('qtcontrib-68669.testnet'); });
});
