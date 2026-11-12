import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { assertKvArgs, postArgs, postId, reputationArgs, readKv, readKey, waitIndexed, writeKv, SOCIAL, REPUTATION_NS, profileArgs } from '../src/near/social';
import { SocialPublisher, announceText, completeText, nearblocksAnchorFinder } from '../worker/social-publisher';
import type { OnChainMandate } from '../src/near/mandate';

const WNEAR = 'nep141:wrap.near';
const mk = (o: Partial<OnChainMandate>): OnChainMandate => ({
  id: 0, treasurer: 'alice.testnet', terms_hash: 'a'.repeat(64), terms_json: '{}', sell_token: WNEAR, max_sell: '5000000000000000000000000',
  start_ns: 1_700_000_000_000_000_000, end_ns: 1_700_000_900_000_000_000, tier: 'small', status: 'Approved', sold: '0', chunks: 0, created_ns: 0,
  report_hash: null, revealed_terms: null, ...o,
});

describe('social-kv args', () => {
  it('builds standard post + reputation keys', () => {
    expect(postArgs('1700000000000001', 'hi')).toEqual({ 'post/1700000000000001': { text: 'hi' } });
    expect(Object.keys(reputationArgs({ treasurer: 'alice.testnet', settled: 1, mandates: [] }))[0]).toBe(`${REPUTATION_NS}/alice.testnet`);
    expect(profileArgs({ name: 'n', website: 'https://x.y' })).toEqual({ 'profile/name': 'n', 'profile/links/website': 'https://x.y' });
  });
  it('post ids are deterministic, valid integers, below 2^53', () => {
    expect(postId(3, 'announce')).toBe('1700000000000031');
    expect(postId(3, 'complete')).toBe('1700000000000032');
    expect(Number(postId(900, 'complete'))).toBeLessThan(9007199254740991);
  });
  it('rejects invalid kv args', () => {
    expect(() => assertKvArgs({})).toThrow();
    expect(() => assertKvArgs({ 'kéy': 1 })).toThrow(/ASCII/);
    expect(() => assertKvArgs({ ['k'.repeat(1025)]: 1 })).toThrow(/too long/);
    expect(() => assertKvArgs({ k: 'x'.repeat(262_145) })).toThrow(/too large/);
  });
});

describe('kv io', () => {
  it('writeKv sends to the network receiver and returns an explorer link', async () => {
    let seen: any;
    const w = await writeKv('testnet', async (r, a) => { seen = { r, a }; return 'TX1'; }, postArgs('1700000000000001', 'x'));
    expect(seen.r).toBe('social.testnet');
    expect(w.explorer).toBe(`${SOCIAL.testnet.explorerTx}TX1`);
    expect((await writeKv('mainnet', async (r) => { seen = { r }; return 'T'; }, postArgs('1', 'x'))).txHash).toBe('T');
    expect(seen.r).toBe('social');
  });
  it('readKv / readKey / waitIndexed use FastData endpoints', async () => {
    const calls: string[] = [];
    const f = (async (url: string, init: any) => { calls.push(`${url} ${init?.body}`); return { ok: true, json: async () => ({ entries: [{ key: 'post/1', value: { text: 'a' } }] }) }; }) as any;
    expect((await readKv('testnet', 'alice.testnet', 'post/', f)).length).toBe(1);
    expect(calls[0]).toContain('kv.test.fastnear.com/v0/latest/social.testnet/alice.testnet');
    expect((await readKey('testnet', 'alice.testnet', 'post/1', f))?.key).toBe('post/1');
    expect(await readKey('testnet', 'alice.testnet', 'post/2', f)).toBeNull();
    let n = 0;
    const slow = (async () => ({ ok: true, json: async () => ({ entries: ++n < 3 ? [] : [{ key: 'post/9', value: {} }] }) })) as any;
    expect((await waitIndexed('testnet', 'a.testnet', 'post/9', { f: slow, sleep: async () => {}, tries: 5 }))?.key).toBe('post/9');
  });
});

describe('publisher', () => {
  const mkPub = (ms: OnChainMandate[], trust = 1, anchor?: string) => {
    const sent: Array<Record<string, any>> = [];
    const db = new DatabaseSync(':memory:');
    const pub = new SocialPublisher({
      net: 'testnet', account: 'qtagent.testnet', dao: 'dao.testnet', contract: 'mandate.testnet',
      chain: { listMandates: async () => ms, getTrust: async () => trust },
      send: async (_r, a) => { sent.push(a); return `TX${sent.length}`; }, db, log: () => {},
      findAnchorTx: async () => anchor,
    });
    return { pub, sent, db };
  };
  it('announces approved mandates once, completes + reputation once, never for cancelled', async () => {
    const ms = [mk({ id: 0 }), mk({ id: 1, status: 'Completed', report_hash: 'b'.repeat(64), sold: '5000000000000000000000000', chunks: 4 }), mk({ id: 2, status: 'Cancelled' })];
    const { pub, sent } = mkPub(ms, 1, 'ANCHORTX');
    const n = await pub.tick();
    const keys = sent.flatMap((a) => Object.keys(a));
    expect(keys).toContain('profile/name');
    expect(keys).toContain(`post/${postId(0, 'announce')}`);
    expect(keys).toContain(`post/${postId(1, 'announce')}`);
    expect(keys).toContain(`post/${postId(1, 'complete')}`);
    expect(keys).not.toContain(`post/${postId(2, 'announce')}`);
    expect(keys).toContain(`${REPUTATION_NS}/alice.testnet`);
    expect(JSON.stringify(sent)).toContain('ANCHORTX');
    expect(n).toBe(5);
    const again = await pub.tick(); // idempotent: restart-safe
    expect(again).toBe(0);
    expect(pub.records().every((r) => r.kv_tx.startsWith('TX'))).toBe(true);
  });
  it('reputation only counts settled mandates with report hashes and updates when the score changes', async () => {
    const ms = [mk({ id: 1, status: 'Completed', report_hash: 'b'.repeat(64) })];
    const { pub, sent } = mkPub(ms, 1);
    await pub.tick();
    const rep = sent.map((a) => a[`${REPUTATION_NS}/alice.testnet`]).find(Boolean);
    expect(rep.settled).toBe(1);
    expect(rep.mandates).toHaveLength(1);
    expect(rep.mandates[0].reportHash).toBe('b'.repeat(64));
  });
  it('sealed mandates never leak terms in the announcement', () => {
    const t = announceText(mk({ terms_json: null }), { dao: 'd.testnet', contract: 'c.testnet', link: (x) => x });
    expect(t).toContain('SEALED');
    expect(t).toContain('a'.repeat(64));
    expect(completeText(mk({ status: 'Completed', report_hash: 'c'.repeat(64) }), { dao: 'd', contract: 'c', link: (x) => x })).toContain('zero-violation');
  });
  it('anchor finder matches report hash and mandate id via decoded args', async () => {
    const find = nearblocksAnchorFinder({
      api: 'https://nb', rpc: 'r', contract: 'c',
      fetchImpl: (async () => ({ ok: true, json: async () => ({ data: [{ transaction_hash: 'T1', signer_account_id: 's', actions: [{ method: 'complete' }] }, { transaction_hash: 'T2', signer_account_id: 's', actions: [{ method: 'complete' }] }] }) })) as any,
      decode: async (h) => ({ args: h === 'T2' ? { id: 1, report_hash: 'b'.repeat(64) } : { id: 0, report_hash: 'z'.repeat(64) } }),
    });
    expect(await find(mk({ id: 1, report_hash: 'b'.repeat(64) }))).toBe('T2');
    expect(await find(mk({ id: 9, report_hash: 'q'.repeat(64) }))).toBeUndefined();
  });
});
