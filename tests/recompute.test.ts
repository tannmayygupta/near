import { describe, expect, it } from 'vitest';
import { recomputeRun, sha256Hex, termsOf, type Chain, type ChainMandate, type ParsedTx, type RunFile } from '../app/lib/recompute';
import { canonical } from '../app/lib/canon';

const CONTRACT = 'qt.testnet', AGENT = 'agent.testnet';
const A = '10000000000000000000000', B = '20000000000000000000000', SOLD = '30000000000000000000000'; // 0.01 + 0.02 NEAR (24 decimals)
const terms = { dao: 'dao.testnet', minPrice: '2', maxSellAmount: SOLD, returnTo: 'dao.testnet' };
async function fixture() {
  const report = { mandateId: 3, totalSold: SOLD, fills: [1, 2] };
  const reportHash = await sha256Hex(canonical(report));
  const termsHash = await sha256Hex(canonical(terms));
  const mandate: ChainMandate = { id: 3, status: 'Completed', sold: SOLD, max_sell: SOLD, chunks: 2, terms_hash: termsHash, terms_json: JSON.stringify(terms), report_hash: reportHash, revealed_terms: null };
  const run: RunFile = {
    ids: { mandateContract: CONTRACT, agent: AGENT }, mandate: { id: 3 },
    txs: [{ label: 'agent: record_chunk #3.0', txHash: 'h0' }, { label: 'agent: record_chunk #3.1', txHash: 'h1' }, { label: 'agent: complete #3 (anchors report hash)', txHash: 'hc' }],
    // price = (out / 1e6) / (in / 1e24): 0.03 USDT for 0.01 NEAR = 3.0, and 0.08 for 0.02 = 4.0 (both above the floor of 2)
    real: { swaps: [{ index: 0, tx: 's0', in: A, out: '30000' }, { index: 1, tx: 's1', in: B, out: '80000' }] },
  };
  const tx = (method: string, args: object, events: object[] = []): ParsedTx => ({ signer: AGENT, receiver: CONTRACT, method, args: args as Record<string, unknown>, success: true, events: events as any });
  const txs: Record<string, ParsedTx> = { h0: tx('record_chunk', { index: 0, sold_amount: A }), h1: tx('record_chunk', { index: 1, sold_amount: B }), hc: tx('complete', { report_hash: reportHash }, [{ event: 'mandate_completed', data: { id: 3, report_hash: reportHash, violations: 0, trust_after: 1, revealed: false } }]) }; // the REAL on-chain shape: data is an object
  const chain: Chain = { mandate: async () => ({ ...mandate }), tx: async (h) => txs[h] ?? null };
  return { run, report, reportHash, mandate, chain, txs };
}
const ok = (c: { ok: boolean }[]) => c.every((x) => x.ok);

describe('in-browser recompute', () => {
  it('passes on a consistent run and recomputes hashes, sums, floors and the completion event', async () => {
    const f = await fixture();
    const res = await recomputeRun(f.run, { report: { ...f.report, reportHash: f.reportHash } }, f.chain);
    expect(ok(res)).toBe(true);
    for (const re of [/terms_hash/, /sum of the recorded chunk amounts/, /contiguous/, /price floor/, /swap amounts add up/, /completion transaction anchored/, /NEP-297 event/, /sha256\(canonical report\)/]) expect(res.some((c) => re.test(c.name) && c.ok)).toBe(true);
  });  it('reads the completion event in both shapes (object as emitted on chain, array as NEP-297 also allows) and fails when the event carries a different hash', async () => {
    const f = await fixture(); const arr = { ...f.txs, hc: { ...f.txs.hc!, events: [{ event: 'mandate_completed', data: [{ report_hash: f.reportHash }] }] as any } };
    expect(ok(await recomputeRun(f.run, null, { mandate: f.chain.mandate, tx: async (h) => arr[h] ?? null }))).toBe(true);
    const bad = { ...f.txs, hc: { ...f.txs.hc!, events: [{ event: 'mandate_completed', data: { report_hash: 'd'.repeat(64) } }] as any } };
    expect((await recomputeRun(f.run, null, { mandate: f.chain.mandate, tx: async (h) => bad[h] ?? null })).find((c) => /NEP-297 event/.test(c.name))!.ok).toBe(false);
  });
  it('FAILS when the chain says more was sold than the transactions add up to', async () => {
    const f = await fixture(); const chain: Chain = { mandate: async () => ({ ...f.mandate, sold: '301' }), tx: f.chain.tx };
    const res = await recomputeRun(f.run, null, chain); expect(res.find((c) => /sum of the recorded chunk amounts/.test(c.name))!.ok).toBe(false);
  });
  it('FAILS on a tampered terms hash, a tampered report, and a completion that anchored a different hash', async () => {
    const f = await fixture();
    const bad1 = await recomputeRun(f.run, null, { mandate: async () => ({ ...f.mandate, terms_hash: 'a'.repeat(64) }), tx: f.chain.tx }); expect(bad1.find((c) => /terms_hash/.test(c.name))!.ok).toBe(false);
    const bad2 = await recomputeRun(f.run, { report: { ...f.report, totalSold: '999', reportHash: f.reportHash } }, f.chain); expect(bad2.find((c) => /sha256\(canonical report\)/.test(c.name))!.ok).toBe(false);
    const txs = { ...f.txs, hc: { ...f.txs.hc!, args: { report_hash: 'b'.repeat(64) }, events: [] } };
    const bad3 = await recomputeRun(f.run, null, { mandate: f.chain.mandate, tx: async (h) => txs[h] ?? null }); expect(bad3.find((c) => /completion transaction anchored/.test(c.name))!.ok).toBe(false);
  });
  it('FAILS when a chunk transaction was signed by someone other than the agent, called another contract, or failed', async () => {
    const f = await fixture();
    for (const patch of [{ signer: 'mallory.testnet' }, { receiver: 'other.testnet' }, { success: false }, { method: 'create_mandate' }]) {
      const txs = { ...f.txs, h0: { ...f.txs.h0!, ...patch } };
      const res = await recomputeRun(f.run, null, { mandate: f.chain.mandate, tx: async (h) => txs[h] ?? null });
      expect(ok(res)).toBe(false);
    }
  });
  it('FAILS when a swap executed below the mandate price floor', async () => {
    const f = await fixture();
    const slow = { ...f.run, real: { swaps: [{ index: 0, tx: 's0', in: A, out: '10000' }, { index: 1, tx: 's1', in: B, out: '90000' }] } }; // prices 1.0 and 4.5; floor 2
    const res = await recomputeRun(slow, null, f.chain); expect(res.find((c) => /price floor/.test(c.name))!.ok).toBe(false);
  });
  it('a sealed mandate: commitment is sha256(salt | terms) once revealed; before that it is reported as sealed, not as a pass of something it did not check', async () => {
    const salt = 'abc'; const h = await sha256Hex(`${salt}|${canonical(terms)}`);
    const revealed: ChainMandate = { id: 3, status: 'Completed', sold: '0', max_sell: '300', chunks: 0, terms_hash: h, terms_json: null, revealed_terms: JSON.stringify({ salt, terms }), report_hash: null };
    expect(termsOf(revealed).how).toBe('revealed');
    const run: RunFile = { ids: { mandateContract: CONTRACT, agent: AGENT }, mandate: { id: 3 }, txs: [] };
    const res = await recomputeRun(run, null, { mandate: async () => revealed, tx: async () => null });
    expect(res.find((c) => /sealed commitment/.test(c.name))!.ok).toBe(true);
    const bad = await recomputeRun(run, null, { mandate: async () => ({ ...revealed, terms_hash: 'c'.repeat(64) }), tx: async () => null });
    expect(bad.find((c) => /sealed commitment/.test(c.name))!.ok).toBe(false);
    const pending = await recomputeRun(run, null, { mandate: async () => ({ ...revealed, revealed_terms: null }), tx: async () => null });
    expect(pending.find((c) => /terms commitment/.test(c.name))!.recomputed).toMatch(/sealed/);
  });
  it('a missing mandate or missing ids is a failure, never a silent pass', async () => {
    const f = await fixture();
    expect(ok(await recomputeRun(f.run, null, { mandate: async () => null, tx: async () => null }))).toBe(false);
    expect(ok(await recomputeRun({}, null, f.chain))).toBe(false);
  });
});
