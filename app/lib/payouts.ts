// "My payouts": flatten every payout, fee and return of the committed recorded runs into rows, then pick the ones paid to one account.
// Pure functions with relative imports only, so the dashboard page (app/app/me/page.tsx) and tests/payouts.test.ts run the same code.
// Nothing is invented: every row is a row of app/public/demo-run/{run,custody-run,sealed-run,restart-run}.json and carries its transaction hash.

export type RunKey = 'real' | 'custody' | 'sealed' | 'restart';
export const PAYOUT_RUNS: ReadonlyArray<{ key: RunKey; label: string; file: string; sealed: boolean }> = [
  { key: 'custody', label: 'OutLayer custody run', file: '/demo-run/custody-run.json', sealed: false },
  { key: 'real', label: 'Key-held vault run', file: '/demo-run/run.json', sealed: false },
  { key: 'sealed', label: 'Sealed mandate run', file: '/demo-run/sealed-run.json', sealed: true },
  { key: 'restart', label: 'Crash-restart run', file: '/demo-run/restart-run.json', sealed: false },
];

export type PayoutRow = {
  runKey: RunKey; runLabel: string; recordedAt: string; mandateId: number | null; sealed: boolean;
  /** which mandate of the run the row belongs to: the one that completed, or the one a DAO vote cancelled mid-run */
  part: 'completed' | 'cancelled';
  kind: string; label: string; to: string; amount: string;
  /** USDT.e (6 decimals), native NEAR (24 decimals, `return_sell`), or a token this page does not know (shown raw) */
  unit: 'USDT.e' | 'NEAR' | 'raw'; decimals: number; tokenId: string | null;
  status: string; tx: string;
};

const USDT = 'nep141:usdt.fakes.testnet';
const KIND_LABEL: Record<string, string> = {
  return_buy: 'leftover proceeds returned to the DAO',
  return_sell: 'unspent budget returned to the DAO (native NEAR)',
  payout: 'payout', fee: 'service fee',
};

type RawRow = { kind?: unknown; label?: unknown; to?: unknown; amount?: unknown; token?: unknown; status?: unknown; tx?: unknown };

/** `return_sell` is the unspent budget (the sell token, native NEAR here); every other kind is paid in the buy token. */
function unitOf(kind: string, token: string | null): Pick<PayoutRow, 'unit' | 'decimals'> {
  if (kind === 'return_sell') return { unit: 'NEAR', decimals: 24 };
  if (token === null || token === USDT) return { unit: 'USDT.e', decimals: 6 };
  return { unit: 'raw', decimals: 0 };
}

/** Rows of one recorded run file (its shape differs: `real.payouts`, top-level `payouts`, and `cancelRun.items`). */
export function payoutRowsOf(key: RunKey, run: any): PayoutRow[] {
  const meta = PAYOUT_RUNS.find((r) => r.key === key)!;
  const out: PayoutRow[] = [];
  const add = (raws: unknown, part: PayoutRow['part'], mandateId: unknown) => {
    if (!Array.isArray(raws)) return;
    for (const r of raws as RawRow[]) {
      if (typeof r?.to !== 'string' || typeof r?.amount !== 'string' || !/^\d+$/.test(r.amount)) continue; // not a transfer row: skip, never guess
      const kind = typeof r.kind === 'string' ? r.kind : 'transfer';
      const tokenId = typeof r.token === 'string' ? r.token : null;
      out.push({
        runKey: key, runLabel: meta.label, recordedAt: String(run?.recordedAt ?? ''), mandateId: typeof mandateId === 'number' ? mandateId : null, sealed: meta.sealed, part,
        kind, label: typeof r.label === 'string' ? r.label : KIND_LABEL[kind] ?? kind, to: r.to, amount: r.amount, tokenId, ...unitOf(kind, tokenId),
        status: typeof r.status === 'string' ? r.status : 'unknown', tx: typeof r.tx === 'string' ? r.tx : '',
      });
    }
  };
  add(run?.real?.payouts ?? run?.payouts, 'completed', run?.mandate?.id ?? run?.mandateId);
  add(run?.cancelRun?.items, 'cancelled', run?.cancelRun?.mandate?.id);
  return out;
}

export const rowsFor = (account: string, rows: PayoutRow[]): PayoutRow[] => rows.filter((r) => r.to === account);
export const recipientsIn = (rows: PayoutRow[]): string[] => [...new Set(rows.map((r) => r.to))].sort();

/** Totals per unit over the given rows (smallest units, as bigint strings), for the one-line summary. */
export function totalsOf(rows: PayoutRow[]): Array<{ unit: PayoutRow['unit']; decimals: number; amount: string }> {
  const sums = new Map<string, { unit: PayoutRow['unit']; decimals: number; amount: bigint }>();
  for (const r of rows) {
    if (r.unit === 'raw' || r.status !== 'success') continue; // only transfers that succeeded, and only units we can read
    const s = sums.get(r.unit) ?? { unit: r.unit, decimals: r.decimals, amount: 0n };
    s.amount += BigInt(r.amount); sums.set(r.unit, s);
  }
  return [...sums.values()].map((s) => ({ ...s, amount: s.amount.toString() }));
}

/** NEAR account id syntax (2-64 chars, lowercase, digits, `-`/`_`/`.` separators; a 64-hex implicit id also matches). */
export const isNearAccountId = (s: string): boolean => s.length >= 2 && s.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s);
export const normalizeAccount = (s: string): string => s.trim().toLowerCase();
