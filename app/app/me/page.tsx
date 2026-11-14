'use client';
// "My payouts": type a NEAR account and see every payout, fee and return it received in the recorded runs (each row has its transaction),
// plus its live usdt.fakes.testnet balance read from public RPC. Static-export friendly: the account comes from ?account= read on the client.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { asset, fmtUnits, rpcView } from '@/lib/data';
import type { Result } from '@/lib/types';
import { PAYOUT_RUNS, isNearAccountId, normalizeAccount, payoutRowsOf, recipientsIn, rowsFor, totalsOf, type PayoutRow } from '@/lib/payouts';
import { Acct } from '@/components/acct';
import { TxLink } from '@/components/real';
import { PageHead, Src, Stat, StatusPill, useAsync, View } from '@/components/ui';

const USDT_CONTRACT = 'usdt.fakes.testnet';
type Loaded = { rows: PayoutRow[]; missing: string[] };

/** Reads the four recorded run files in parallel. A file that cannot be read is named, never silently skipped. */
async function loadRows(): Promise<Result<Loaded>> {
  const parts = await Promise.all(PAYOUT_RUNS.map(async (r) => {
    try {
      const res = await fetch(asset(r.file), { cache: 'no-store' });
      if (!res.ok) return { r, rows: [] as PayoutRow[], err: `HTTP ${res.status}` };
      return { r, rows: payoutRowsOf(r.key, await res.json()), err: '' };
    } catch (e) { return { r, rows: [] as PayoutRow[], err: (e as Error).message }; }
  }));
  const missing = parts.filter((p) => p.err).map((p) => `${p.r.label} (${p.err})`);
  if (missing.length === parts.length) return { ok: false, error: `Could not load any recorded run: ${missing.join('; ')}` };
  return { ok: true, source: 'recorded', data: { rows: parts.flatMap((p) => p.rows), missing } };
}

const amountText = (r: PayoutRow) => (r.unit === 'raw' ? `${r.amount} (raw units of ${r.tokenId})` : `${fmtUnits(r.amount, r.decimals, 6)} ${r.unit}`);

function LiveBalance({ account }: { account: string }) {
  const a = useAsync(() => rpcView<string>(USDT_CONTRACT, 'ft_balance_of', { account_id: account }, 'testnet'), [account]);
  return (
    <View a={a} what="live USDT.e balance">
      {(raw, s) => (
        <>
          <div className="grid"><Stat k={`USDT.e held now by this account (${USDT_CONTRACT})`} v={fmtUnits(String(raw), 6, 6)} s={s} /></div>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>
            This is the live token balance, read from public testnet RPC just now. It also counts anything the account received outside these runs and
            anything it has spent since, so it will not necessarily equal the total below, and testnet balances can be far larger than any payout. 0 means the account holds none (or never registered with the token).
          </p>
        </>
      )}
    </View>
  );
}

function Rows({ account, data }: { account: string; data: Loaded }) {
  const mine = useMemo(() => rowsFor(account, data.rows), [account, data.rows]);
  const totals = totalsOf(mine);
  const hasSealed = mine.some((r) => r.sealed);
  if (mine.length === 0) {
    return (
      <div className="state" role="status">
        <strong>No payout, fee or return to <span className="mono">{account}</span> in the recorded runs.</strong>
        <div style={{ marginTop: 6 }}>
          The recorded runs paid {recipientsIn(data.rows).length} accounts (listed below). If this is your account, it was not a recipient of any of them; that says nothing about
          the account itself. Its live balance above is still read from the chain.
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="card" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Run</th><th>Mandate</th><th>Kind</th><th>Label</th><th>Amount</th><th>Status</th><th>Transaction</th></tr></thead>
          <tbody>
            {mine.map((r, i) => (
              <tr key={`${r.runKey}-${r.part}-${r.tx || i}`}>
                <td>{r.runLabel}{r.sealed && <span className="pill warn" style={{ marginLeft: 6 }}>sealed</span>}</td>
                <td>{r.mandateId === null ? '-' : `#${r.mandateId}`}{r.part === 'cancelled' && <span className="pill" style={{ marginLeft: 6 }}>cancelled by DAO vote</span>}</td>
                <td>{r.kind}</td>
                <td>{r.label}</td>
                <td title={`${r.amount} (smallest units)`}>{amountText(r)}<Src s="chain" /></td>
                <td><StatusPill status={r.status} /></td>
                <td>{r.tx ? <TxLink hash={r.tx} /> : <span className="mono">-</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ margin: '8px 0' }}>
        {totals.length === 0 ? 'No successful transfers to total.' : <>Total of the successful rows above: <strong>{totals.map((t) => `${fmtUnits(t.amount, t.decimals, 6)} ${t.unit}`).join(' + ')}</strong>.</>}
        {' '}<span style={{ color: 'var(--muted)', fontSize: 13 }}>These are recorded testnet runs; the tokens have no monetary value.</span>
      </p>
      {hasSealed && (
        <div className="state" role="note">
          <strong>Sealed run.</strong> While a sealed mandate runs, its terms (including who gets paid, and how much) are not on the mandate contract: only the commitment and the budget are.
          The recipients and amounts above became visible when the payouts executed at settlement, and this list is taken from the settled run. Sealing hides the plan, not the transfers:
          on testnet each payout is an ordinary public transaction.
        </div>
      )}
    </>
  );
}

export default function MyPayouts() {
  const [input, setInput] = useState('');
  const [account, setAccount] = useState('');
  const all = useAsync(loadRows, []);

  // shareable: /me?account=<id> opens the page already looking at that account
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('account');
    if (q) { const a = normalizeAccount(q); setInput(a); setAccount(a); }
  }, []);

  function go(a: string) {
    const next = normalizeAccount(a);
    setInput(next); setAccount(next);
    try { const u = new URL(window.location.href); if (next) u.searchParams.set('account', next); else u.searchParams.delete('account'); window.history.replaceState(null, '', u); } catch { /* the URL is a convenience only */ }
  }
  const onSubmit = (e: FormEvent) => { e.preventDefault(); go(input); };
  const valid = isNearAccountId(account);
  const recipients = !all.loading && all.result.ok ? recipientsIn(all.result.data.rows) : [];

  return (
    <>
      <PageHead title="My payouts" lead="Type a NEAR testnet account to see every payout, fee and return it received in the recorded runs, each with its transaction, and what it holds now. Look up a contributor, the fee account, or the DAO." />
      <form className="card" onSubmit={onSubmit}>
        <label htmlFor="acct">NEAR account id</label>
        <div className="row" style={{ marginTop: 6 }}>
          <input id="acct" type="text" list="known-recipients" inputMode="text" autoComplete="off" spellCheck={false} placeholder="for example qtcontrib-68669.testnet" value={input} onChange={(e) => setInput(e.target.value)} style={{ flex: '1 1 280px', width: 'auto' }} />
          <button className="primary" type="submit" disabled={!input.trim()}>Look up</button>
        </div>
        <datalist id="known-recipients">{recipients.map((r) => <option key={r} value={r} />)}</datalist>
      </form>

      {account && !valid && <div className="state error" role="alert"><strong>That is not a valid NEAR account id.</strong> <span className="mono">{account}</span> (2 to 64 characters: lowercase letters, digits, and - _ . separators).</div>}

      {account && valid && (
        <>
          <h2><Acct id={account} /></h2>
          <h3>Live balance <Src s="chain" /></h3>
          <LiveBalance account={account} />
          <h3>Received in the recorded runs <Src s="chain" /></h3>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 0 }}>Rows come from the committed recorded runs (<Src s="recorded" />); every row links to its public testnet transaction.</p>
          <View a={all} what="recorded payouts">
            {(data) => (
              <>
                {data.missing.length > 0 && <div className="state error" role="alert"><strong>Some recorded runs could not be read, so this list may be incomplete:</strong> {data.missing.join('; ')}</div>}
                <Rows account={account} data={data} />
              </>
            )}
          </View>
        </>
      )}

      <h2>Accounts paid in the recorded runs</h2>
      <View a={all} what="recorded payouts">
        {(data) => (
          <div className="card">
            <div className="row">
              {recipientsIn(data.rows).map((r) => (
                <button key={r} type="button" onClick={() => go(r)} className="mono" title={`Look up ${r}`}>{r.length > 30 ? `${r.slice(0, 12)}…${r.slice(-8)}` : r}</button>
              ))}
              <Src s="recorded" />
            </div>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 0 }}>
              {data.rows.length} transfers across {PAYOUT_RUNS.length - data.missing.length} recorded runs. See <Link href="/ledger">the ledger</Link> for the whole run and <Link href="/recompute">Recompute</Link> to re-check a run from the chain yourself.
            </p>
          </div>
        )}
      </View>
    </>
  );
}
