// ============================ TEST-ONLY ============================
// A local stand-in for the OutLayer wallet HTTP API so the worker can be exercised end to end on the sandbox chain WITHOUT real money.
// It is NEVER imported by worker/ or src/ production code. Production code talks to OUTLAYER_BASE_URL (default https://api.outlayer.ai).
// It mimics only the documented request/response shapes (idempotent swaps/withdrawals, terminal request status); it does not prove OutLayer behaves this way.
import { createServer, Server } from 'node:http';

export interface FakeOutLayerHandle { server: Server; url: string; conf: Record<string, bigint>; pub: Record<string, bigint>; swaps: any[]; withdrawals: any[]; setPrice(p: number): void }

export async function startFakeOutLayer(port = 8899, price = 3.7): Promise<FakeOutLayerHandle> {
  const conf: Record<string, bigint> = {}, pub: Record<string, bigint> = {};
  const swaps: any[] = [], withdrawals: any[] = [];
  const byIdem = new Map<string, string>(); const reqs = new Map<string, any>(); let n = 0;
  let px = price;
  const out = (inn: bigint) => BigInt(Math.floor((Number(inn) / 1e24) * px * 1e6));
  const send = (res: any, code: number, b: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x'); let raw = ''; for await (const c of req) raw += c;
    const b = raw ? JSON.parse(raw) : {}; const idem = String(req.headers['x-idempotency-key'] ?? '');
    const p = url.pathname;
    if (!String(req.headers.authorization ?? '').startsWith('Bearer ')) return send(res, 401, { error: 'unauthorized' });
    if (p === '/wallet/v1/balance') return send(res, 200, { balance: (pub[url.searchParams.get('token') ?? ''] ?? 0n).toString(), token: url.searchParams.get('token'), account_id: 'fake' });
    if (p === '/wallet/v1/confidential/balance') return send(res, 200, { balance: (conf[url.searchParams.get('token') ?? ''] ?? 0n).toString(), account_id: 'fake' });
    if (p === '/wallet/v1/confidential/swap/quote') return send(res, 200, { amount_out: out(BigInt(b.amount_in)).toString(), time_estimate_seconds: 1 });
    if (p === '/wallet/v1/confidential/swap' || p === '/wallet/v1/confidential/withdraw' || p === '/wallet/v1/confidential/shield') {
      if (idem && byIdem.has(idem)) return send(res, 200, { request_id: byIdem.get(idem), status: 'pending_deposit' });
      const id = `fake-${++n}`; if (idem) byIdem.set(idem, id);
      if (p.endsWith('/swap')) {
        const inn = BigInt(b.amount_in), o = out(inn);
        if (b.min_amount_out && o < BigInt(b.min_amount_out)) return send(res, 400, { error: 'bad_request', message: 'quote amount_out below min_amount_out' });
        if ((conf[b.token_in] ?? 0n) < inn) return send(res, 400, { error: 'bad_request', message: 'insufficient balance' });
        conf[b.token_in] -= inn; conf[b.token_out] = (conf[b.token_out] ?? 0n) + o; swaps.push({ idem, ...b, out: o.toString() });
        reqs.set(id, { status: 'success', result: { amount_out: o.toString(), swap_details: {} } });
      } else if (p.endsWith('/withdraw')) {
        const a = BigInt(b.amount); if ((conf[b.token] ?? 0n) < a) { reqs.set(id, { status: 'failed' }); return send(res, 200, { request_id: id, status: 'pending_deposit' }); }
        conf[b.token] -= a; withdrawals.push({ idem, ...b });
        reqs.set(id, { status: 'success', result: { swap_details: { destinationChainTxHashes: [`fake-dest-tx-${id}`] } } });
      } else { const a = BigInt(b.amount); pub[b.token] = (pub[b.token] ?? 0n) - a; conf[b.token] = (conf[b.token] ?? 0n) + a; reqs.set(id, { status: 'success' }); }
      return send(res, 200, { request_id: id, status: 'pending_deposit', intent_hash: `fake-ih-${id}` });
    }
    const m = p.match(/^\/wallet\/v1\/requests\/(.+)$/);
    if (m) return reqs.has(m[1]) ? send(res, 200, reqs.get(m[1])) : send(res, 404, { error: 'not_found' });
    return send(res, 404, { error: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(port, r));
  return { server, url: `http://127.0.0.1:${port}`, conf, pub, swaps, withdrawals, setPrice: (p) => { px = p; } };
}
