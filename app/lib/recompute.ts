// "Check it yourself": recompute a recorded run IN THE BROWSER from public chain data. Nothing here trusts the worker or this site's JSON on its own:
// the mandate is read from the contract, every chunk and the completion are fetched as transactions from public RPC, and the numbers are re-derived.
// Pure logic over an injected `Chain`, so the same code is unit-tested (tests/recompute.test.ts) and runs live on /recompute.
import { canonical } from './canon';

export interface Check { name: string; ok: boolean; logged: string; recomputed: string }
export interface ParsedTx { signer: string; receiver: string; method: string; args: Record<string, unknown>; success: boolean; events: Array<Record<string, any>> }
export interface ChainMandate { id: number; status: string; sold: string; max_sell: string; chunks: number; terms_hash: string; terms_json: string | null; report_hash: string | null; revealed_terms: string | null }
export interface Chain { mandate(contract: string, id: number): Promise<ChainMandate | null>; tx(hash: string, signer: string): Promise<ParsedTx | null> }

export interface RunFile {
  ids?: { mandateContract?: string; agent?: string };
  mandate?: { id: number }; mandateId?: number;
  txs?: Array<{ label: string; txHash: string }>;
  real?: { swaps: Array<{ index: number; tx: string; in: string; out: string }> };
  swaps?: Array<{ index: number; tx: string; in: string; out: string }>;
}
export interface BundleFile { report?: Record<string, any> }

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** near-sdk writes a named-field event variant as data: {…} (an object); NEP-297 allows data: [{…}] too. Accept both (the real chain showed the object form). */
export const eventData = (e: { data?: unknown }): Record<string, any> | undefined => (Array.isArray(e.data) ? e.data[0] : (e.data as Record<string, any> | undefined));

const SELL_DEC = 24, BUY_DEC = 6;
const priceOf = (inn: string, out: string) => (Number(BigInt(out)) / 10 ** BUY_DEC) / (Number(BigInt(inn)) / 10 ** SELL_DEC);
const short = (s: string | null | undefined, n = 12) => (s ? s.slice(0, n) + (s.length > n ? '…' : '') : '-');

/** The terms of a mandate as the chain shows them: public terms, or (sealed mandates) the terms revealed at settlement. */
export function termsOf(m: ChainMandate): { terms: Record<string, any> | null; salt: string | null; how: 'public' | 'revealed' | 'sealed' } {
  if (m.terms_json) { try { return { terms: JSON.parse(m.terms_json), salt: null, how: 'public' }; } catch { return { terms: null, salt: null, how: 'public' }; } }
  if (m.revealed_terms) { try { const o = JSON.parse(m.revealed_terms); return { terms: o.terms, salt: o.salt, how: 'revealed' }; } catch { /* fallthrough */ } }
  return { terms: null, salt: null, how: 'sealed' };
}

export async function recomputeRun(run: RunFile, bundle: BundleFile | null, chain: Chain): Promise<Check[]> {
  const out: Check[] = []; const add = (name: string, ok: boolean, logged: string, recomputed: string) => out.push({ name, ok, logged, recomputed });
  const contract = run.ids?.mandateContract ?? ''; const agent = run.ids?.agent ?? ''; const id = run.mandate?.id ?? run.mandateId;
  if (!contract || id === undefined) { add('the run names its contract and mandate', false, 'missing', 'missing'); return out; }
  const m = await chain.mandate(contract, id);
  if (!m) { add(`mandate #${id} exists on ${contract}`, false, 'not found', 'not found'); return out; }
  add(`mandate #${id} is read live from the contract`, true, `status ${m.status}, ${m.chunks} chunks`, 'chain view');

  // 1. the commitment: sha256 of the terms (public) or sha256(salt|terms) (sealed, revealed at settlement)
  const t = termsOf(m);
  if (t.terms) {
    const h = t.how === 'revealed' ? await sha256Hex(`${t.salt}|${canonical(t.terms)}`) : await sha256Hex(canonical(t.terms));
    add(t.how === 'revealed' ? 'sealed commitment: sha256(salt | revealed terms) equals the terms_hash that was public from the start' : 'sha256(canonical terms) equals the on-chain terms_hash', h === m.terms_hash, short(m.terms_hash, 16), short(h, 16));
  } else add('terms commitment', true, 'sealed: terms not on chain yet', 'n/a (sealed until settlement)');

  // 2. every chunk the agent recorded, as a transaction
  const chunkTxs = (run.txs ?? []).map((x) => ({ ...x, mm: x.label.match(/record_chunk #(\d+)\.(\d+)/) })).filter((x) => x.mm && Number(x.mm[1]) === id);
  let sumTx = 0n; let allOk = true; const idx: number[] = [];
  for (const c of chunkTxs) {
    const p = await chain.tx(c.txHash, agent);
    const a = p?.args as { index?: number; sold_amount?: string } | undefined;
    const good = !!p && p.success && p.method === 'record_chunk' && p.receiver === contract && p.signer === agent && a?.index === Number(c.mm![2]);
    if (!good) allOk = false; else { sumTx += BigInt(a!.sold_amount ?? '0'); idx.push(a!.index!); }
  }
  if (chunkTxs.length) {
    add(`${chunkTxs.length} record_chunk transactions: each succeeded, called ${short(contract, 18)}, was signed by the agent key`, allOk, `${chunkTxs.length} listed`, allOk ? `${idx.length} verified` : 'a transaction failed or differs');
    add('chunk indexes are contiguous 0..n-1', idx.every((v, i) => v === i) && idx.length === m.chunks, `${m.chunks} chunks on chain`, `${idx.length} indexes`);
    add('sum of the recorded chunk amounts equals the contract\'s `sold`', sumTx === BigInt(m.sold), m.sold, sumTx.toString());
  } else add('record_chunk transactions listed in this run', true, 'none listed', 'skipped (this run file does not list them)');
  add('sold never exceeds the DAO-approved budget', BigInt(m.sold) <= BigInt(m.max_sell), `${m.sold} / ${m.max_sell}`, BigInt(m.sold) <= BigInt(m.max_sell) ? 'within budget' : 'OVER BUDGET');

  // 3. every swap price against the mandate's own floor
  const swaps = run.real?.swaps ?? run.swaps ?? [];
  const floor = t.terms?.minPrice !== undefined ? Number(t.terms.minPrice) : null;
  if (swaps.length && floor !== null) {
    const worst = Math.min(...swaps.map((s) => priceOf(s.in, s.out)));
    add('every swap executed at or above the mandate\'s price floor', worst >= floor, `floor ${floor}`, `worst fill ${worst.toFixed(4)}`);
    add('swap amounts add up to the chunks the contract recorded', swaps.reduce((s, x) => s + BigInt(x.in), 0n) === BigInt(m.sold), m.sold, swaps.reduce((s, x) => s + BigInt(x.in), 0n).toString());
  } else add('price floor check', true, floor === null ? 'terms sealed' : 'no swaps', 'skipped');

  // 4. the completion transaction and the report hash
  const comp = (run.txs ?? []).find((x) => new RegExp(`complete #${id}\\b`).test(x.label));
  if (comp && m.report_hash) {
    const p = await chain.tx(comp.txHash, agent); const a = p?.args as { report_hash?: string } | undefined;
    add('the completion transaction anchored this report hash on chain', !!p && p.success && p.method === 'complete' && a?.report_hash === m.report_hash, short(m.report_hash, 16), short(a?.report_hash, 16));
    const ev = p?.events.find((e) => e.event === 'mandate_completed');
    if (ev) { const d = eventData(ev); add('NEP-297 event `mandate_completed` in the transaction logs carries the same report hash', d?.report_hash === m.report_hash, short(m.report_hash, 16), short(d?.report_hash, 16)); }
  }
  const rep = bundle?.report;
  if (rep && m.report_hash) {
    const { reportHash, ...body } = rep;
    const h = await sha256Hex(canonical(body));
    add('sha256(canonical report) equals the hash anchored on the contract', h === m.report_hash && reportHash === m.report_hash, short(m.report_hash, 16), short(h, 16));
  } else if (m.report_hash) add('report hash recomputation', true, 'no AI bundle for this run', 'skipped');
  return out;
}

// ---- live chain over public RPC (browser) ----
export function rpcChain(urls: string[], fetchFn: typeof fetch = fetch): Chain {
  const call = async (method: string, params: unknown) => {
    let last = 'no rpc';
    for (const u of urls) {
      try {
        const r = await fetchFn(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'qt', method, params }), signal: AbortSignal.timeout(15000) });
        if (!r.ok) { last = `HTTP ${r.status}`; continue; }
        const j = await r.json(); if (j.error) { last = JSON.stringify(j.error).slice(0, 120); if (/UNKNOWN_TRANSACTION|DOES_NOT_EXIST/.test(last)) return null; continue; }
        return j.result;
      } catch (e) { last = (e as Error).message; }
    }
    throw new Error(`public RPC unavailable: ${last}`);
  };
  return {
    async mandate(contract, id) {
      const r = await call('query', { request_type: 'call_function', finality: 'final', account_id: contract, method_name: 'get_mandate', args_base64: btoa(JSON.stringify({ id })) });
      if (!r) return null; const m = JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))); return m;
    },
    async tx(hash, signer) {
      const o = await call('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: signer, wait_until: 'FINAL' }); if (!o) return null;
      const fc = o.transaction?.actions?.[0]?.FunctionCall; let args: Record<string, unknown> = {};
      try { args = fc ? JSON.parse(atob(fc.args)) : {}; } catch { /* non-JSON args */ }
      const logs: string[] = (o.receipts_outcome ?? []).flatMap((r: any) => r.outcome?.logs ?? []);
      const events = logs.filter((l) => l.startsWith('EVENT_JSON:')).flatMap((l) => { try { return [JSON.parse(l.slice('EVENT_JSON:'.length))]; } catch { return []; } });
      const failed = o.status?.Failure !== undefined || (o.receipts_outcome ?? []).some((r: any) => r.outcome?.status?.Failure !== undefined);
      return { signer: o.transaction?.signer_id, receiver: o.transaction?.receiver_id, method: fc?.method_name ?? '', args, success: !failed, events };
    },
  };
}
