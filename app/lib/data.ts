// Typed data layer. THREE sources only: (a) worker read-only API, (b) NEAR RPC views, (c) a committed recorded run.
// No mocked numbers: every function returns Result<T>; failure is an explicit error the UI must render.
//
// Worker API contract (implemented by the worker lane; paths relative to NEXT_PUBLIC_WORKER_API):
//   GET  /api/mandates                       -> OnchainMandate[] (cached chain view)  [optional; chain view is primary]
//   GET  /api/mandates/:id/chunks            -> Chunk[]
//   GET  /api/balances                       -> Balances
//   GET  /api/ledger                         -> LedgerRow[]
//   GET  /api/report/:id                     -> Report
//   GET  /api/verify/:id                     -> VerifyCheck[]
//   POST /api/parse        {intent}          -> ParseResult
//   POST /api/redteam/:attack {mandateId?}   -> RedteamResult
import type {
  Balances, Chunk, DaoProposal, LedgerRow, OnchainMandate, ParseResult, RedteamResult, Report, Result, Source, VerifyCheck,
} from './types';

export const ENV = {
  worker: (process.env.NEXT_PUBLIC_WORKER_API ?? '').replace(/\/$/, ''),
  network: (process.env.NEXT_PUBLIC_NEAR_NETWORK ?? 'testnet') as 'testnet' | 'mainnet',
  dao: process.env.NEXT_PUBLIC_DAO ?? process.env.NEXT_PUBLIC_DAO_ACCOUNT ?? '',
  mandate: process.env.NEXT_PUBLIC_MANDATE_CONTRACT ?? '',
  agent: process.env.NEXT_PUBLIC_AGENT_ACCOUNT ?? '',
};

// NEXT_PUBLIC_NEAR_RPC overrides the RPC of the configured network (e.g. https://rpc.testnet.near.org)
const RPC_OVERRIDE = process.env.NEXT_PUBLIC_NEAR_RPC;
export const RPC = {
  testnet: (ENV.network === 'testnet' && RPC_OVERRIDE) || 'https://test.rpc.fastnear.com',
  mainnet: (ENV.network === 'mainnet' && RPC_OVERRIDE) || 'https://rpc.mainnet.fastnear.com',
};
const rpcUrl = () => RPC[ENV.network];

const fail = <T,>(error: string): Result<T> => ({ ok: false, error });
const ok = <T,>(data: T, source: Source): Result<T> => ({ ok: true, data, source });

async function getJson<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const r = await fetch(url, { ...init, cache: 'no-store' });
    const text = await r.text();
    if (!r.ok) return { ok: false, error: `HTTP ${r.status} from ${url}: ${text.slice(0, 200)}` };
    return { ok: true, data: JSON.parse(text) as T };
  } catch (e) {
    return { ok: false, error: `${(e as Error).message} (${url})` };
  }
}

// ---------- (a) worker API ----------
async function worker<T>(path: string, init?: RequestInit): Promise<Result<T>> {
  if (!ENV.worker) return fail('Worker API not configured (set NEXT_PUBLIC_WORKER_API).');
  const r = await getJson<T>(`${ENV.worker}${path}`, init);
  return r.ok ? ok(r.data, 'api') : fail(r.error);
}

export const getChunks = (id: number) => worker<Chunk[]>(`/api/mandates/${id}/chunks`);
export const getBalances = () => worker<Balances>('/api/balances');
export const getLedger = () => worker<LedgerRow[]>('/api/ledger');
export const getReport = (id: number) => worker<Report>(`/api/report/${id}`);
export const getVerifyChecks = (id: number) => worker<VerifyCheck[]>(`/api/verify/${id}`);
/** Parse an intent via the worker; surfaces the worker's own message (HTTP 422/500 bodies are JSON {error, hint?}). */
export async function parseIntent(intent: string): Promise<Result<ParseResult>> {
  if (!ENV.worker) return fail('Worker API not configured (set NEXT_PUBLIC_WORKER_API).');
  try {
    const r = await fetch(`${ENV.worker}/api/parse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intent }), cache: 'no-store' });
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 400);
      try { const j = JSON.parse(text); msg = [j.error, j.hint].filter(Boolean).join(' - ') || msg; } catch { /* keep raw */ }
      return fail(`The worker could not turn this into a mandate (HTTP ${r.status}): ${msg}`);
    }
    return ok(JSON.parse(text) as ParseResult, 'api');
  } catch (e) {
    return fail(`Could not reach the worker: ${(e as Error).message}`);
  }
}
export const runRedteam = (attack: string, mandateId?: number) =>
  worker<RedteamResult>(`/api/redteam/${attack}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mandateId }) });

// ---------- (b) NEAR RPC ----------
export async function rpcView<T>(account: string, method: string, args: object = {}, network = ENV.network): Promise<Result<T>> {
  if (!account) return fail(`No account configured for view ${method}.`);
  const body = {
    jsonrpc: '2.0', id: 'qt', method: 'query',
    params: { request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: btoa(JSON.stringify(args)) },
  };
  const r = await getJson<{ result?: { result: number[] }; error?: { data?: string; message?: string } }>(RPC[network], {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) return fail(r.error);
  if (r.data.error || !r.data.result) return fail(`RPC view ${method} on ${account}: ${r.data.error?.data ?? r.data.error?.message ?? 'no result'}`);
  try {
    return ok(JSON.parse(new TextDecoder().decode(new Uint8Array(r.data.result.result))) as T, 'chain');
  } catch (e) {
    return fail(`Could not decode ${method} result: ${(e as Error).message}`);
  }
}

export const getMandates = () => rpcView<OnchainMandate[]>(ENV.mandate, 'list_mandates', { from: 0, limit: 100 });
export const getMandate = (id: number) => rpcView<OnchainMandate | null>(ENV.mandate, 'get_mandate', { id });
export const getTrust = (treasurer: string) => rpcView<number>(ENV.mandate, 'get_trust', { treasurer });
export const getProposals = () => rpcView<DaoProposal[]>(ENV.dao, 'get_proposals', { from_index: 0, limit: 100 });
export const getDaoPolicy = () => rpcView<Record<string, unknown>>(ENV.dao, 'get_policy');

export async function viewAccountExists(account: string, network: 'testnet' | 'mainnet'): Promise<Result<{ exists: boolean; raw: string }>> {
  const r = await getJson<{ result?: unknown; error?: { cause?: { name?: string }; data?: string } }>(RPC[network], {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'qt', method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: account } }),
  });
  if (!r.ok) return fail(r.error);
  if (r.data.result) return ok({ exists: true, raw: 'account found' }, 'chain');
  const name = r.data.error?.cause?.name ?? 'UNKNOWN';
  return ok({ exists: false, raw: name }, 'chain');
}

export type TxRow = { hash: string; block_timestamp: string; action: string | null; method: string | null; signer: string; receiver: string };
export async function getPublicTxns(account: string, network = ENV.network): Promise<Result<TxRow[]>> {
  if (!account) return fail('No agent account configured.');
  // NearBlocks API v3 (v1 and v2 are retired; testnet runs v3 only). Paths: /v3/accounts/{id}/txns, results under `data`, cursor pagination via `limit`.
  const host = network === 'mainnet' ? 'https://api.nearblocks.io' : 'https://api-testnet.nearblocks.io';
  const r = await getJson<{ data?: { transaction_hash: string; block_timestamp: string; actions?: { action: string; method: string | null }[]; signer_account_id: string; receiver_account_id: string }[]; errors?: { message?: string }[] }>(
    `${host}/v3/accounts/${account}/txns?limit=25`,
  );
  if (!r.ok) return fail(r.error);
  if (!Array.isArray(r.data.data)) return fail(`NearBlocks v3 returned no data: ${r.data.errors?.[0]?.message ?? 'unexpected response shape'}`);
  return ok(
    (r.data.data ?? []).map((t) => ({
      hash: t.transaction_hash, block_timestamp: t.block_timestamp, action: t.actions?.[0]?.action ?? null, method: t.actions?.[0]?.method ?? null,
      signer: t.signer_account_id, receiver: t.receiver_account_id,
    })),
    'chain',
  );
}

// ---------- (c) recorded run (committed, REAL, labelled "recorded") ----------
export type RecordedRun = {
  recordedAt: string; note: string;
  mandate?: OnchainMandate; chunks?: Chunk[]; ledger?: LedgerRow[]; report?: Report; checks?: VerifyCheck[]; balances?: Balances;
  cancelRun?: { mandate?: OnchainMandate; items?: { key?: string; kind?: string; status?: string; token?: string; amount?: string; to?: string; note?: string }[] };
  verifier?: { ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] };
};

/** The recorded run describes specific mandates (the completed one and the cancelled one). Never apply it to any other id. */
export type RecordedMandate = {
  kind: 'completed' | 'cancelled'; mandate: OnchainMandate; chunks: Chunk[]; ledger: LedgerRow[]; report?: Report; checks: VerifyCheck[];
  verifier?: RecordedRun['verifier']; items: NonNullable<NonNullable<RecordedRun['cancelRun']>['items']>;
};
export async function getRecordedFor(id: number): Promise<Result<RecordedMandate>> {
  const rec = await getRecordedRun();
  if (!rec.ok) return rec as Result<never>;
  const r = rec.data;
  if (r.mandate?.id === id) return ok({ kind: 'completed', mandate: r.mandate, chunks: r.chunks ?? [], ledger: r.ledger ?? [], report: r.report, checks: r.checks ?? [], verifier: r.verifier, items: [] }, 'recorded');
  if (r.cancelRun?.mandate?.id === id) return ok({ kind: 'cancelled', mandate: r.cancelRun.mandate, chunks: [], ledger: [], checks: [], items: r.cancelRun.items ?? [] }, 'recorded');
  return fail(`The recorded run does not cover mandate #${id}.`);
}

/** Chunks for ONE mandate: live worker receipts if any, else the recorded run for that same mandate, else an explicit empty. */
export async function getChunksFor(id: number): Promise<Result<Chunk[]>> {
  const live = await getChunks(id);
  if (live.ok && live.data.length > 0) return live;
  const rec = await getRecordedFor(id);
  if (rec.ok && rec.data.chunks.length > 0) return ok(rec.data.chunks, 'recorded');
  return live.ok ? live : fail(live.error);
}

export type ReportView = { report: Report | null; why: string };
/** Report for ONE mandate. Never shows another mandate's report; explains why when there is none. */
export async function getReportFor(m: OnchainMandate): Promise<Result<ReportView>> {
  const live = await getReport(m.id);
  if (live.ok) return ok({ report: live.data, why: '' }, 'api');
  const rec = await getRecordedFor(m.id);
  if (rec.ok && rec.data.report) return ok({ report: rec.data.report, why: '' }, 'recorded');
  const why = m.status === 'Cancelled'
    ? 'This mandate was cancelled by a DAO vote. A cancelled mandate produces no settlement report (the contract only anchors reports for completed mandates); completed chunks and returned funds are in the cancel record.'
    : m.status === 'Completed' ? 'This mandate is completed on-chain, but neither the worker database nor the committed recorded run holds its report.'
    : `This mandate is ${m.status}; a settlement report is produced when it completes.`;
  return ok({ report: null, why }, 'chain');
}

/** Ledger rows for ONE mandate (rows are labelled "mandate N ..."); falls back to the recorded run only for the mandate it describes. */
export async function getLedgerFor(id: number): Promise<Result<LedgerRow[]>> {
  const live = await getLedger();
  const own = (rows: LedgerRow[], unlabelledBelongsHere: boolean) => rows.filter((r) => {
    const m = r.label.match(/^mandate (\d+)\b/);
    return m ? Number(m[1]) === id : unlabelledBelongsHere; // fee / payout / return rows carry no mandate prefix: they belong to the run's completed mandate
  });
  if (live.ok && live.data.length > 0) { const o = own(live.data, false); if (o.length) return ok(o, 'api'); }
  const run = await getRecordedRun();
  if (run.ok && run.data.ledger?.length) {
    const o = own(run.data.ledger, run.data.mandate?.id === id);
    if (o.length) return ok(o, 'recorded');
  }
  return ok([], 'chain'); // empty is a valid answer (e.g. cancelled mandate); the UI explains it
}

/** Whole ledger: live rows if any, else the recorded run (labelled). */
export async function getLedgerAll(): Promise<Result<LedgerRow[]>> {
  const live = await getLedger();
  if (live.ok && live.data.length > 0) return live;
  const rec = await getRecordedRun();
  if (rec.ok && (rec.data.ledger?.length ?? 0) > 0) return ok(rec.data.ledger!, 'recorded');
  return live.ok ? ok([], 'api') : fail(live.error);
}

export type CheckState = 'pass' | 'fail' | 'pending';
export type VerifyView = { checks: (VerifyCheck & { state: CheckState })[]; note: string | null; verifier: RecordedRun['verifier'] | null };
/** Verification for ONE mandate. "No data in the worker for this mandate" is PENDING, a genuine mismatch is FAIL. */
export async function getVerifyFor(m: OnchainMandate): Promise<Result<VerifyView>> {
  const rec = await getRecordedFor(m.id);
  const live = await getVerifyChecks(m.id);
  const liveChunks = await getChunks(m.id);
  const workerHasReceipts = liveChunks.ok && liveChunks.data.length > 0;
  if (rec.ok && rec.data.checks.length > 0 && !workerHasReceipts) {
    return ok({ checks: rec.data.checks.map((c) => ({ ...c, state: c.ok ? 'pass' : 'fail' })), note: 'The worker database has no receipts for this mandate, so these checks come from the committed recorded run of the same mandate.', verifier: rec.data.verifier ?? null }, 'recorded');
  }
  if (!live.ok) return fail(live.error);
  const noData = /worker 0\b|not settled yet|no receipts|not found/i;
  const checks = live.data.map((c) => ({ ...c, state: (c.ok ? 'pass' : !workerHasReceipts && noData.test(c.detail) ? 'pending' : 'fail') as CheckState }));
  const pending = checks.some((c) => c.state === 'pending');
  return ok({
    checks,
    note: pending ? 'Some checks are PENDING, not failed: the worker has no receipts or report for this mandate yet (for example it is still running, was cancelled, or ran on another worker).' : null,
    verifier: rec.ok ? rec.data.verifier ?? null : null,
  }, 'api');
}
export async function getRecordedRun(): Promise<Result<RecordedRun>> {
  const r = await getJson<RecordedRun>('/demo-run/run.json');
  return r.ok ? ok(r.data, 'recorded') : fail('No recorded run committed yet (app/public/demo-run/run.json). It is produced by the real end-to-end run.');
}

/** Prefer live sources; fall back to the recorded run, always returning the true source. */
export async function withRecordedFallback<T>(live: Promise<Result<T>>, pick: (r: RecordedRun) => T | undefined): Promise<Result<T>> {
  const l = await live;
  if (l.ok) return l;
  const rec = await getRecordedRun();
  if (rec.ok) {
    const v = pick(rec.data);
    if (v !== undefined) return ok(v, 'recorded');
  }
  return l; // surface the live error; never fabricate
}

// ---------- formatting helpers ----------
export function fmtUnits(raw: string | number | bigint | null | undefined, decimals: number, maxFrac = 4): string {
  if (raw === null || raw === undefined) return '-';
  const n = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const frac = (n % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
/** Round a decimal string/number for display (4 dp by default); removes float noise like 3.516365499999999. */
export function fmtPrice(x: string | number | null | undefined, dp = 4): string {
  if (x === null || x === undefined || x === '') return '-';
  const n = Number(x);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: dp }) : String(x);
}
/** Replace long raw integers / float noise inside free text (AI summaries) with readable numbers. The signed raw text stays available. */
export function humanizeText(text: string, sellDecimals = 24, buyDecimals = 6): string {
  return text
    .replace(/\b\d{19,}\b/g, (n) => fmtUnits(n, sellDecimals, 4))
    .replace(/\b\d{7,18}\b/g, (n) => fmtUnits(n, buyDecimals, 4))
    .replace(/\b\d+\.\d{7,}\b/g, (n) => fmtPrice(n, 4));
}
export const nsToDate = (ns: number | string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function download(name: string, text: string, mime = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
export function toCsv(rows: LedgerRow[]): string {
  const head = ['timestamp', 'kind', 'label', 'token', 'amount', 'chain', 'reference', 'status'];
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return [head.join(','), ...rows.map((r) => [r.ts, r.kind, r.label, r.token, r.amount, r.chain, r.ref ?? '', r.status].map(esc).join(','))].join('\n');
}

