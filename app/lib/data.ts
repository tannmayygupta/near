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
  dao: process.env.NEXT_PUBLIC_DAO_ACCOUNT ?? '',
  mandate: process.env.NEXT_PUBLIC_MANDATE_CONTRACT ?? '',
  agent: process.env.NEXT_PUBLIC_AGENT_ACCOUNT ?? '',
};

export const RPC = {
  testnet: 'https://test.rpc.fastnear.com',
  mainnet: 'https://rpc.mainnet.fastnear.com',
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
export const parseIntent = (intent: string) =>
  worker<ParseResult>('/api/parse', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intent }) });
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
  const host = network === 'mainnet' ? 'https://api.nearblocks.io' : 'https://api-testnet.nearblocks.io';
  const r = await getJson<{ txns?: { transaction_hash: string; block_timestamp: string; actions?: { action: string; method: string | null }[]; signer_account_id: string; receiver_account_id: string }[] }>(
    `${host}/v1/account/${account}/txns?per_page=25`,
  );
  if (!r.ok) return fail(r.error);
  return ok(
    (r.data.txns ?? []).map((t) => ({
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
};
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
