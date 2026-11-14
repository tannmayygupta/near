'use client';
// Mainnet status. PRESENTATION OF EVIDENCE ONLY: this page reads app/public/demo-run/mainnet-run.json (and mainnet-lock.json) if they are published with the site.
// With no file it says, plainly, that nothing has run on mainnet. Every "proven on mainnet" below is computed from that file's contents; nothing is typed in.
import Link from 'next/link';
import { asset, explorerAcct, explorerTx, fmtUnits } from '@/lib/data';
import { PageHead, Src, Stat, useAsync } from '@/components/ui';
import type { Result } from '@/lib/types';

type MainnetRun = {
  network?: string; recordedAt?: string; note?: string;
  ids?: { dao?: string; mandateContract?: string; agent?: string; vault?: string; owner?: string };
  mandate?: { status?: string; chunks?: number; sold?: string; max_sell?: string } | null;
  results?: { name: string; ok: boolean; note?: string }[];
  real?: { swaps?: { tx: string; in: string; out: string }[]; payouts?: { kind: string; label: string; status: string; tx: string | null }[] };
  proposals?: { id: number; status: string; description: string }[];
  verifier?: { ok: boolean };
};
type Lock = { contract?: string; fullAccessKeysAfter?: number; recordedAt?: string };

async function load<T>(path: string): Promise<Result<T | null>> {
  try {
    const r = await fetch(asset(path), { cache: 'no-store' });
    if (r.status === 404) return { ok: true, data: null, source: 'recorded' };
    if (!r.ok) return { ok: false, error: `HTTP ${r.status} loading ${path}` };
    return { ok: true, data: (await r.json()) as T, source: 'recorded' };
  } catch (e) { return { ok: false, error: `Could not load ${path}: ${(e as Error).message}` }; }
}

// One predicate per track: what in a MAINNET run file would show it. A track whose evidence is not part of the mainnet slice can never be shown by it.
const TRACKS: Array<{ name: string; testnet: string; mainnet: (r: MainnetRun) => boolean | 'n/a'; na?: string }> = [
  { name: 'Social Money', testnet: 'DAO votes, funding transfer, reputation', mainnet: (r) => (r.proposals ?? []).filter((p) => p.status === 'Approved').length >= 2 },
  { name: 'Autonomous Business', testnet: 'chunked execution, crash-restart, DAO cancel', mainnet: (r) => r.mandate?.status === 'Completed', na: 'crash-restart and cancel were not run on mainnet' },
  { name: 'AI Security & Defense', testnet: 'three layers, red team, protocol probes', mainnet: (r) => (r.results ?? []).some((x) => /FUNCTION-CALL key/i.test(x.name) && x.ok), na: 'OutLayer wallet policy and the red team were not run on mainnet' },
  { name: 'Privacy & Private AI', testnet: 'TEE-parsed intent, signed and attested', mainnet: (r) => (r.results ?? []).some((x) => /NEAR AI \(TEE\)/i.test(x.name) && x.ok) && r.verifier?.ok === true, na: 'hidden execution is not claimed anywhere' },
  { name: 'Real-World Money', testnet: 'payouts, fee, returns (play money)', mainnet: (r) => (r.real?.payouts ?? []).some((p) => p.status === 'success') },
  { name: 'Open Innovation (sealed)', testnet: 'commit-reveal mandate', mainnet: () => 'n/a', na: 'sealed mandates are not part of the mainnet slice' },
  { name: 'Unstoppable DeFi', testnet: 'Ref swaps; Intents quoted only', mainnet: (r) => (r.real?.swaps ?? []).length > 0, na: 'Intents settlement is a separate owner-run script and has not run' },
];

export default function Mainnet() {
  const run = useAsync(() => load<MainnetRun>('/demo-run/mainnet-run.json'), []);
  const lock = useAsync(() => load<Lock>('/demo-run/mainnet-lock.json'), []);
  const r = !run.loading && run.result.ok ? run.result.data : undefined;   // undefined = still loading / failed, null = no file
  const err = !run.loading && !run.result.ok ? run.result.error : null;
  const isMainnet = !!r && r.network === 'mainnet';
  const l = !lock.loading && lock.result.ok ? lock.result.data : null;
  const passed = r?.results ? r.results.filter((x) => x.ok).length : 0;
  return (
    <>
      <PageHead title="Mainnet" lead="What has really run on NEAR mainnet, read from files published with this site. If a number is not in a file, it is not here." />
      {run.loading && <div className="state loading" role="status">Looking for a published mainnet run…</div>}
      {err && <div className="state error" role="alert"><strong>Could not check.</strong> {err}</div>}

      {r === null && (
        <div className="card" role="status" style={{ borderColor: 'color-mix(in srgb, var(--warn) 55%, transparent)' }}>
          <span className="pill warn">NOT RUN</span>
          <h2 style={{ margin: '12px 0 6px' }}>Nothing has run on NEAR mainnet yet.</h2>
          <p style={{ margin: 0, color: 'var(--muted)' }}>Everything on this site was recorded on public NEAR testnet with play money. A mainnet slice (one tiny DAO-voted mandate, about US$2 of NEAR) is built and has been rehearsed end to end on testnet; it has not been deployed. This page switches on by itself when a mainnet run file is published, and not before.</p>
        </div>
      )}

      {r && !isMainnet && <div className="state error" role="alert"><strong>A file is published but it is not a mainnet run</strong> (it says network &ldquo;{r.network ?? 'unknown'}&rdquo;). Nothing is shown from it.</div>}

      {isMainnet && r && (
        <>
          <div className="card" role="status"><span className="pill ok">MAINNET RUN PUBLISHED</span> <span className="mono" style={{ marginLeft: 8 }}>{r.recordedAt}</span> <Src s="recorded" />
            {r.note && <p style={{ margin: '12px 0 0', color: 'var(--muted)' }}>{r.note}</p>}</div>
          <div className="grid">
            <Stat k="Checks passed" v={`${passed}/${r.results?.length ?? 0}`} s="recorded" />
            <Stat k="Mandate" v={r.mandate?.status ?? '-'} s="recorded" />
            <Stat k="Real swaps" v={r.real?.swaps?.length ?? 0} s="recorded" />
            <Stat k="Sold (NEAR)" v={r.mandate?.sold ? fmtUnits(r.mandate.sold, 24, 3) : '-'} s="recorded" />
          </div>
          <h2>Where to look</h2>
          <div className="card"><table><tbody>
            {([['DAO', r.ids?.dao], ['Mandate contract', r.ids?.mandateContract], ['Agent', r.ids?.agent], ['Vault', r.ids?.vault]] as const).map(([k, id]) => id ? (
              <tr key={k}><td>{k}</td><td><a className="mono" href={explorerAcct(id, 'mainnet')} target="_blank" rel="noreferrer">{id} ↗</a></td></tr>) : null)}
          </tbody></table></div>
          {(r.real?.swaps ?? []).length > 0 && <div className="card"><div style={{ marginBottom: 8 }}><strong>Swap transactions</strong> <Src s="recorded" /></div>
            <div className="row">{(r.real?.swaps ?? []).map((s, i) => <a key={i} className="mono" href={explorerTx(s.tx, 'mainnet')} target="_blank" rel="noreferrer">swap {i} ↗</a>)}</div></div>}
          <p><Link href="/recompute?run=mainnet&auto=1">Recompute this run in your browser from mainnet RPC →</Link></p>
          {l && <div className="card"><span className={`pill ${l.fullAccessKeysAfter === 0 ? 'ok' : 'warn'}`}>{l.fullAccessKeysAfter === 0 ? 'contract locked: no full-access key remains' : 'contract NOT locked'}</span></div>}
        </>
      )}

      <h2>Track by track: testnet and mainnet</h2>
      <p className="lead">&ldquo;Verified on testnet&rdquo; links to recorded, explorer-checked runs. The mainnet column is computed from the published mainnet run file and says &ldquo;pending&rdquo; until it exists.</p>
      <div className="card"><table>
        <thead><tr><th>Track</th><th>On public testnet</th><th>On mainnet</th></tr></thead>
        <tbody>
          {TRACKS.map((t) => {
            const v = isMainnet && r ? t.mainnet(r) : t.mainnet({}) === 'n/a' ? 'n/a' : false; // a track outside the mainnet slice is outside it before and after any run
            return (
              <tr key={t.name}><td><strong>{t.name}</strong></td><td><span className="pill ok">verified</span> <span style={{ color: 'var(--muted)' }}>{t.testnet}</span></td>
                <td>{v === 'n/a' ? <span className="pill warn">not part of the mainnet slice</span> : v ? <span className="pill ok">shown by the published run</span> : <span className="pill warn">pending</span>}
                  {t.na && <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>{t.na}</div>}</td></tr>
            );
          })}
        </tbody>
      </table></div>

      <h2>What is ready, and what it will cost</h2>
      <div className="card"><ul style={{ margin: 0, paddingLeft: 18 }}>
        <li>One atomic transaction deploys and initialises the contract, so nobody can initialise it first; rehearsed on testnet.</li>
        <li>A read-only preflight checks the network, owner, key, balance, target accounts and the wasm hash before anything is sent.</li>
        <li>Read-only verification and a JavaScript contract test check the deployed contract against the committed wasm.</li>
        <li>The owner moves about 15.15 NEAR into accounts it controls (measured gas about 0.07 NEAR); the mandate sells at most 0.6 NEAR (about US$2).</li>
        <li>On mainnet the vault is a key held by the worker and the council accounts are controlled by the authors: stated on every mainnet claim.</li>
      </ul>
      <p style={{ margin: '12px 0 0', color: 'var(--muted)' }}>Details: <a href="https://github.com/tannmayygupta/near/blob/main/docs/MAINNET-DEPLOYMENT-PLAN.md">deployment plan</a> · <a href="https://github.com/tannmayygupta/near/blob/main/docs/MAINNET.md">how to run it</a>.</p></div>
    </>
  );
}
