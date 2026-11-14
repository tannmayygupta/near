// Read-only HTTP API for the dashboard (paths match app/lib/data.ts) + redteam POSTs + council-only sealed terms.
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { RateLimiter, clientIp } from './ratelimit';
import { BOUNDS, MandateTerms } from '../src/engine/schema';
import { commit, hashJson } from '../src/engine/hash';
import { verifyReportHash } from '../src/engine/settlement';
import type { OnChainMandate } from '../src/near/mandate';
import { State } from './state';
import { authenticate } from './auth';
import { envRedactor } from './redact';
import { RedteamDeps, RedteamGate } from './redteam';
import type { WindowBudget } from './ratelimit';
import type { ChainPort, OutLayerPort } from './ports';

export interface ApiDeps {
  state: State; chain: ChainPort; outlayer: OutLayerPort; redteam: RedteamDeps;
  cfg: { dao: string; rpc: string; corsOrigin: string; authRecipient: string };
  /** per-process rate limiter (default: tiered, see worker/ratelimit.ts) */
  limiter?: RateLimiter;
  /** what `/api/redteam/*` runs (default: a RedteamGate over `redteam`: cached, globally budgeted, secret-scrubbed) */
  redteamGate?: RedteamGate;
  /** GLOBAL budget for `/api/parse` (it spends NEAR AI credits); absent = unlimited (tests, local runs) */
  parseBudget?: WindowBudget;
  /** GET /attestation: the live NEAR AI attestation check (worker/attestation.ts). Must never throw; absent = reported as not configured */
  attestation?: () => Promise<unknown>;
  parse?: (intent: string) => Promise<unknown>;
  isCouncil: (account: string) => Promise<boolean>;
  nowS: () => number;
  health: () => Record<string, unknown>;
}

const dec = (v: bigint, d: number, places = 8) => { const s = v.toString().padStart(d + 1, '0'); const i = s.slice(0, -d) || '0'; const f = s.slice(-d).slice(0, places).replace(/0+$/, ''); return f ? `${i}.${f}` : i; };
const priceOf = (inn: string, out: string, sd: number, bd: number) => (BigInt(inn) === 0n ? null : (Number(BigInt(out)) / 10 ** bd / (Number(BigInt(inn)) / 10 ** sd)).toString());

export async function termsFor(state: State, m: OnChainMandate): Promise<MandateTerms | null> {
  try {
    if (m.terms_json) return MandateTerms.parse(JSON.parse(m.terms_json));
    const s = state.loadTerms(m.terms_hash); return s ? MandateTerms.parse(JSON.parse(s).terms) : null;
  } catch { return null; }
}

export function createApi(d: ApiDeps) {
  const limiter = d.limiter ?? new RateLimiter();
  const gate = d.redteamGate ?? new RedteamGate(d.redteam);
  const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', ...cors() }); res.end(JSON.stringify(body)); };
  const cors = () => ({ 'access-control-allow-origin': d.cfg.corsOrigin, 'access-control-allow-headers': 'content-type, x-near-auth', 'access-control-allow-methods': 'GET, POST, OPTIONS' });
  const body = async (req: IncomingMessage) => { let s = ''; for await (const c of req) { s += c; if (s.length > 64_000) throw new Error('body too large'); } return s ? JSON.parse(s) : {}; };
  const sym = (t: string) => BOUNDS.allowedTokens[t]?.symbol ?? t;

  async function chunks(id: number) {
    const m = await d.chain.getMandate(id); const terms = m ? await termsFor(d.state, m) : null;
    const sd = terms ? BOUNDS.allowedTokens[terms.sellToken].decimals : 24, bd = terms ? BOUNDS.allowedTokens[terms.buyToken].decimals : 6;
    const samples = d.state.samples(id);
    return d.state.chunks(id).map((c) => {
      const bench = samples.length ? samples.reduce((a, b) => (Math.abs(b.ts - c.ts) < Math.abs(a.ts - c.ts) ? b : a)).price.toString() : null;
      return { index: c.idx, ts: new Date(c.ts * 1000).toISOString(), sellAmount: c.size, buyAmount: c.amount_out, price: c.amount_out ? priceOf(c.size, c.amount_out, sd, bd) : null,
        benchmarkPrice: bench, status: c.status === 'planned' || c.status === 'submitted' ? 'pending' : c.status, requestId: c.request_id, intentHash: c.intent_hash, note: c.note ?? undefined };
    });
  }

  async function balances() {
    const out: Array<{ token: string; symbol: string; amount: string; where: string }> = [];
    for (const token of Object.keys(BOUNDS.allowedTokens)) {
      const dcm = BOUNDS.allowedTokens[token].decimals;
      const pub = await d.outlayer.intentsBalance(token).catch(() => null);
      if (pub) out.push({ token, symbol: sym(token), amount: pub.balance, where: 'intents' });
      const conf = await d.outlayer.confidentialBalance(token).catch(() => null);
      if (conf) out.push({ token, symbol: sym(token), amount: conf.balance ?? conf.balances?.find((b) => b.token === token)?.balance ?? '0', where: 'confidential' });
      void dcm;
    }
    return out;
  }

  function ledger() {
    const rows: any[] = [];
    for (const e of d.state.allEvents()) {
      const det = JSON.parse(e.detail || '{}');
      if (e.kind === 'chunk_success') rows.push({ ts: new Date(e.ts * 1000).toISOString(), kind: 'sale', label: `mandate ${e.mandate_id} chunk ${det.idx}`, token: 'sell', amount: det.in, chain: 'near', ref: null, status: 'success' });
      if (e.kind === 'item_paid') rows.push({ ts: new Date(e.ts * 1000).toISOString(), kind: det.key === 'fee' ? 'fee' : String(det.key).startsWith('payout') ? 'payout' : 'return', label: `mandate ${e.mandate_id} ${det.key}`, token: '', amount: '', chain: '', ref: null, status: 'success' });
    }
    for (const m of new Set(d.state.allEvents().map((e) => e.mandate_id))) {
      for (const it of d.state.items(m)) rows.push({ ts: new Date().toISOString(), kind: it.kind === 'fee' ? 'fee' : it.kind === 'payout' ? 'payout' : 'return', label: it.label, token: sym(it.token), amount: it.amount, chain: it.chain, ref: it.dest_tx ?? it.request_id, status: it.status });
    }
    return rows.filter((r) => r.token !== '' || r.kind === 'sale');
  }

  async function report(id: number) {
    const r = d.state.report(id); if (!r) return null;
    const returned = d.state.items(id).filter((i) => i.kind.startsWith('return') && i.status === 'success').reduce((s, i) => s + BigInt(i.amount), 0n).toString();
    return { mandateId: id, generatedAt: r.generatedAt, totalSold: r.totals.soldSell.value, totalBought: r.totals.proceedsBuy.value, avgPrice: r.totals.avgPrice.value?.toString() ?? null,
      benchmarkPrice: r.totals.benchmarkTwap.value?.toString() ?? null, benchmarkSource: r.benchmarkSamples[0]?.origin ?? 'none', slippageBps: null, feesPaid: r.totals.feePaid.value,
      returned, violations: r.violations.length, summary: r.aiSummary?.text ?? null,
      summarySignature: r.aiSummary ? { text: `${r.aiSummary.requestHash}:${r.aiSummary.responseHash}`, signature: r.aiSummary.signature ?? '', signingAddress: r.aiSummary.signer, signingAlgo: r.aiSummary.signingAlgo ?? 'ecdsa' } : null,
      reportHash: r.reportHash, anchored: !!r.anchored, floorRespected: r.floorRespected };
  }

  async function verify(id: number) {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
    const m = await d.chain.getMandate(id);
    if (!m) return [{ name: 'mandate exists on chain', ok: false, detail: `no mandate ${id}` }];
    const r = d.state.report(id); const cs = d.state.chunks(id);
    const terms = await termsFor(d.state, m);
    checks.push({ name: 'terms match on-chain hash', ok: !!terms && (m.terms_json ? hashJson(terms) === m.terms_hash : true), detail: terms ? (m.terms_json ? 'sha256(canonical terms) == terms_hash' : 'sealed: hash verifiable after reveal') : 'terms unavailable' });
    const okChunks = cs.filter((c) => c.status === 'success');
    checks.push({ name: 'recorded chunk count == successful swaps', ok: m.chunks === okChunks.length, detail: `chain ${m.chunks} / worker ${okChunks.length}` });
    checks.push({ name: 'recorded sold == sum of swaps', ok: BigInt(m.sold) === okChunks.reduce((s, c) => s + BigInt(c.size), 0n), detail: `chain ${m.sold}` });
    checks.push({ name: 'sold <= budget', ok: BigInt(m.sold) <= BigInt(m.max_sell), detail: `${m.sold} / ${m.max_sell}` });
    if (r) {
      const { anchored, ...rep } = r;
      checks.push({ name: 'report hash is self-consistent', ok: verifyReportHash(rep), detail: String(rep.reportHash).slice(0, 16) + '...' });
      checks.push({ name: 'report floor respected', ok: !!rep.floorRespected, detail: 'every fill >= floor price' });
      checks.push({ name: 'report anchored on-chain', ok: anchored ? m.report_hash === rep.reportHash : m.status === 'Cancelled', detail: anchored ? `chain ${m.report_hash?.slice(0, 16)}...` : m.status === 'Cancelled' ? 'cancelled mandates are not anchored (contract limitation)' : 'not anchored yet' });
      checks.push({ name: 'zero violations', ok: rep.violations.length === 0, detail: `${rep.violations.length} violation(s)` });
    } else checks.push({ name: 'report exists', ok: false, detail: 'mandate not settled yet' });
    if (m.revealed_terms) { try { const o = JSON.parse(m.revealed_terms); checks.push({ name: 'sealed reveal matches commitment', ok: commit(o.terms, o.salt) === m.terms_hash, detail: 'sha256(salt|terms) == terms_hash' }); } catch { checks.push({ name: 'sealed reveal matches commitment', ok: false, detail: 'unparseable reveal' }); } }
    return checks;
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x'); const p = url.pathname; const method = req.method ?? 'GET';
    if (method === 'OPTIONS') { res.writeHead(204, cors()); return res.end(); }
    if (p !== '/health') { // tiered rate limit; X-Forwarded-For is trusted only from a loopback peer (the tunnel)
      const lim = limiter.check(clientIp(req.socket?.remoteAddress, req.headers?.['x-forwarded-for'] as string | undefined), p);
      if (!lim.ok) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(lim.retryAfterS), ...cors() }); return res.end(JSON.stringify({ error: 'rate limited', rule: lim.rule, retryAfterS: lim.retryAfterS })); }
    }
    try {
      if (p === '/health') return json(res, 200, { ok: true, ...d.health() });
      let m: RegExpMatchArray | null;
      if (method === 'GET') {
        if (p === '/attestation') { // always 200: the body says ok:true/false and why (NEAR AI unreachable, key missing, ...)
          try { return json(res, 200, d.attestation ? await d.attestation() : { ok: false, checkedAt: null, ageSeconds: null, nonce: null, model: null, signingAddress: null, checks: [], note: 'attestation check not configured on this worker' }); }
          catch (e) { return json(res, 200, { ok: false, checkedAt: null, ageSeconds: null, nonce: null, model: null, signingAddress: null, checks: [{ name: 'attestation check ran', ok: false, detail: String((e as Error)?.message ?? e).slice(0, 200) }] }); }
        }
        if (p === '/api/mandates') return json(res, 200, await d.chain.listMandates());
        if ((m = p.match(/^\/api\/mandates\/(\d+)\/chunks$/))) return json(res, 200, await chunks(Number(m[1])));
        if ((m = p.match(/^\/api\/mandates\/(\d+)\/events$/))) return json(res, 200, d.state.events(Number(m[1])).map((e) => ({ ...e, detail: JSON.parse(e.detail) })));
        if ((m = p.match(/^\/api\/mandates\/(\d+)\/status$/))) { const id = Number(m[1]); return json(res, 200, { runtime: d.state.runtime(id), items: d.state.items(id), violations: d.state.violations(id) }); }
        if ((m = p.match(/^\/api\/mandates\/(\d+)\/terms$/))) {
          const mm = await d.chain.getMandate(Number(m[1])); if (!mm) return json(res, 404, { error: 'no such mandate' });
          if (mm.terms_json) return json(res, 200, JSON.parse(mm.terms_json));
          try { await authenticate(req.headers['x-near-auth'] as string | undefined, `terms:${mm.id}`, { rpc: d.cfg.rpc, recipient: d.cfg.authRecipient, isCouncil: d.isCouncil }); }
          catch (e) { return json(res, 401, { error: `council authentication required: ${(e as Error).message}` }); }
          const t = await termsFor(d.state, mm); return t ? json(res, 200, t) : json(res, 404, { error: 'sealed terms not delivered to the worker' });
        }
        if (p === '/api/balances') return json(res, 200, await balances());
        if (p === '/api/ledger') return json(res, 200, ledger());
        if ((m = p.match(/^\/api\/report\/(\d+)$/))) { const r = await report(Number(m[1])); return r ? json(res, 200, r) : json(res, 404, { error: 'no report yet' }); }
        if ((m = p.match(/^\/api\/verify\/(\d+)$/))) return json(res, 200, await verify(Number(m[1])));
      }
      if (method === 'POST') {
        const b = await body(req);
        if (p === '/api/parse') { if (!d.parse) return json(res, 503, { error: 'parser not configured (NEAR_AI_API_KEY missing)' });
          const budget = d.parseBudget?.take();
          if (budget && !budget.ok) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(budget.retryAfterS), ...cors() }); return res.end(JSON.stringify({ error: 'the private AI parsing budget of this worker is used up for now (shared by all visitors; it spends the operator\'s NEAR AI credits)', rule: 'parse-global', retryAfterS: budget.retryAfterS })); }
          try { return json(res, 200, await d.parse(String(b.intent ?? ''))); }
          catch (e) { // a rejected/unparseable intent is the caller's problem (422), not a server crash
            const err = e as { name?: string; code?: string; message?: string; attempts?: number };
            if (err.name === 'ParseError') return json(res, 422, { error: err.message, code: err.code, attempts: err.attempts });
            return json(res, 502, { error: `private AI request failed: ${err.message}` });
          }
        }
        if ((m = p.match(/^\/api\/redteam\/([a-z_]+)$/))) return json(res, 200, await gate.run(m[1], b.mandateId));
        if (p === '/api/sealed-terms') {
          try { await authenticate(req.headers['x-near-auth'] as string | undefined, 'sealed-terms', { rpc: d.cfg.rpc, recipient: d.cfg.authRecipient, isCouncil: d.isCouncil }); }
          catch (e) { return json(res, 401, { error: `council authentication required: ${(e as Error).message}` }); }
          const terms = MandateTerms.parse(b.terms); const salt = String(b.salt ?? '');
          if (salt.length < 16) return json(res, 400, { error: 'salt must be at least 16 chars' });
          const hash = commit(terms, salt); d.state.saveTerms(hash, JSON.stringify({ salt, terms }), true);
          return json(res, 200, { termsHash: hash });
        }
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) { return json(res, 500, { error: envRedactor()(String((e as Error)?.message ?? e)).slice(0, 400) }); }
  };
  return { handler, listen(port: number): Promise<Server> { const s = createServer(handler); return new Promise((r) => s.listen(port, () => r(s))); } };
}

