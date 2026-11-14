'use client';
// Landing sections of the home page. PRESENTATION ONLY: every figure is read from the committed recorded runs (via the same loaders the other pages use),
// nothing is typed in. While a run loads, the figures show "…". No wallet, signing or contract code is touched here.
import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { fmtUnits } from '@/lib/data';
import { getCustodyRun, type CustodyRun } from '@/lib/custody';
import { useAsync } from '@/components/ui';

const REPO = 'https://github.com/tannmayygupta/near';
const SVG = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false } as const;
const IconShield = () => <svg {...SVG}><path d="M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5l8-3z" /><path d="M9 12l2 2 4-4" /></svg>;
const IconWallet = () => <svg {...SVG}><path d="M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /><path d="M3 7l2-3h12v3" /><circle cx="16" cy="13.5" r="1.2" /></svg>;
const IconDoc = () => <svg {...SVG}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" /><path d="M14 3v5h5" /><path d="M9 14l2 2 4-4" /></svg>;

/** CSS custom properties are valid in style attributes but not in React's CSSProperties type. */
const css = (v: Record<string, string | number>) => v as CSSProperties;

/** Terms of the recorded mandate (budget, price floor), read from the run file. Null if the file does not carry them. */
function recordedTerms(c: CustodyRun | null): { budget: bigint; floor: string } | null {
  try {
    const m = (c as unknown as { mandate?: { terms_json?: string | null } } | null)?.mandate;
    if (!m?.terms_json) return null;
    const t = JSON.parse(m.terms_json) as { maxSellAmount?: string; minPrice?: string };
    if (!t.maxSellAmount || !t.minPrice) return null;
    return { budget: BigInt(t.maxSellAmount), floor: String(t.minPrice) };
  } catch { return null; }
}

export function Hero() {
  const run = useAsync(getCustodyRun, []);
  const c = !run.loading && run.result.ok ? run.result.data : null;
  const passed = c ? c.results.filter((x) => x.ok).length : null;
  const blocked = c ? c.redteam.filter((x) => x.blocked).length : null;
  const swaps = c ? c.real.swaps.length : null;
  const terms = recordedTerms(c);
  const sold = c ? c.real.swaps.reduce((a, s) => a + BigInt(s.in), 0n) : null;
  const pct = sold !== null && terms && terms.budget > 0n ? Math.min(100, Number((sold * 100n) / terms.budget)) : null;
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div>
        <span className="eyebrow"><i aria-hidden="true" />Verifiable on NEAR testnet</span>
        <h1 id="hero-title">Vote once.<br /><em>The agent does the rest.</em></h1>
        <p className="lead">A DAO approves one plain-English mandate: what to sell, how much, at what minimum price. A bounded agent carries it out in price-floored chunks, pays contributors, returns what is left, and anchors a report that anyone can recompute.</p>
        <div className="cta-row">
          <Link className="btn primary lg" href="/live">See a recorded run</Link>
          <Link className="btn lg" href="/recompute?run=custody&auto=1">Recompute it yourself</Link>
        </div>
        <small className="note">Everything on this site ran on public NEAR testnet with play money; no mainnet funds were moved. What is proven and what is not is listed on every page that makes a claim.</small>
      </div>
      <div className="visual" aria-label="A recorded mandate, summarised">
        <div className="mcard">
          <header><span>Recorded mandate{c ? '' : ' …'}</span><span className="pill ok">{c ? (c.verifier.ok ? 'verifier: all checks pass' : 'verifier: a check FAILED') : 'loading'}</span></header>
          <div className="ring" style={css({ '--p': pct ?? 0 })} role="img" aria-label={pct === null ? 'Amount sold versus budget' : `${pct}% of the budget sold`}>
            <div><b>{sold !== null ? fmtUnits(sold, 24, 3) : '…'}</b><span>{terms ? `NEAR sold of ${fmtUnits(terms.budget, 24, 3)} budget` : 'NEAR sold'}</span></div>
          </div>
          <div className="facts">
            {swaps !== null && <span className="pill">{swaps} real swaps on Ref Finance</span>}
            {terms && <span className="pill">price floor {terms.floor} USDT.e per NEAR</span>}
            {c && <span className="pill">{c.real.payouts.length} payouts, fee and returns</span>}
          </div>
        </div>
        <Link className="chip sun" href="/custody" style={css({ top: 6, left: 0, '--r': '-5deg' })}><span aria-hidden="true">✓</span>{passed !== null ? `${passed}/${c!.results.length}` : '…'} checks passed</Link>
        <Link className="chip mint" href="/redteam" style={css({ top: '40%', right: -4, '--r': '4deg' })}>{blocked !== null ? `${blocked}/${c!.redteam.length}` : '…'} attacks blocked</Link>
        <Link className="chip sky" href="/recompute" style={css({ bottom: 8, left: '4%', '--r': '3deg' })}>Check it in your browser</Link>
        <span className="chip sand" style={css({ bottom: 0, right: '2%', '--r': '-3deg' })}>Recorded run, not a mock-up</span>
      </div>
    </section>
  );
}

export function HowItWorks() {
  const steps: Array<{ n: string; tone: string; title: string; body: string; href: string; cta: string }> = [
    { n: '1', tone: 'mint', title: 'One vote', body: 'A DAO approves a plain-English mandate (token, budget, price floor, window, payouts) with a 2-of-3 council vote. Not a hundred trades; one decision.', href: '/votes', cta: 'See the votes' },
    { n: '2', tone: 'sun', title: 'A bounded agent runs it', body: 'It sells in price-floored chunks from an OutLayer wallet, pays contributors and returns the leftovers. A DAO cancel stops it at any moment.', href: '/live', cta: 'Watch a run' },
    { n: '3', tone: 'sky', title: 'Anyone verifies', body: 'The settlement report hash is anchored on-chain. Your browser can re-derive every chunk, sum and price floor from public RPC.', href: '/recompute', cta: 'Recompute in your browser' },
  ];
  return (
    <section aria-labelledby="how">
      <div className="section-head"><h2 id="how">How it works</h2><p>Three steps, and every one of them leaves a transaction you can open.</p></div>
      <div className="steps">
        {steps.map((s) => (
          <article key={s.n} className={`step ${s.tone}`}>
            <div className="n" aria-hidden="true">{s.n}</div>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
            <p style={{ marginTop: 14 }}><Link href={s.href}>{s.cta} →</Link></p>
          </article>
        ))}
      </div>
    </section>
  );
}

export function Layers() {
  const run = useAsync(getCustodyRun, []);
  const c = !run.loading && run.result.ok ? run.result.data : null;
  const probes = c?.protocolScope?.probes ?? null;
  const layers: Array<{ tone: string; icon: ReactNode; title: string; body: string; limit: ReactNode }> = [
    { tone: 'mint', icon: <IconShield />, title: 'Layer 0: the protocol', body: 'The agent signs with a NEAR function-call key limited to five methods on the mandate contract, with no deposit. The network itself refuses anything else.',
      limit: <><b>Recorded:</b> {probes ? `${probes.filter((p) => p.ok).length} of ${probes.length}` : '…'} probes of that key were refused by the protocol.</> },
    { tone: 'sun', icon: <IconWallet />, title: 'Layer A: the wallet policy', body: 'An OutLayer agent wallet holds the budget; the worker writes a per-mandate policy (allowed contracts, native limits, rate limits) before the first trade.',
      limit: <><b>Limit:</b> this policy does not check token recipients or amounts (we probed it). Layer B covers them.</> },
    { tone: 'sky', icon: <IconDoc />, title: 'Layer B: contract and executor', body: 'The mandate contract enforces roles, window, chunk order and budget. The executor enforces the price floor, the token and the destination, in deterministic code.',
      limit: <><b>Limit:</b> the contract is a registry, not an escrow: it holds no funds. The AI drafts and summarises; it never signs or decides an amount.</> },
  ];
  return (
    <section aria-labelledby="layers">
      <div className="section-head"><h2 id="layers">Three layers, and what each one does not stop</h2><p>A stolen key, a hostile operator or a confused model each hit a different wall. We say which, and where the walls end.</p></div>
      <div className="layers">
        {layers.map((l) => (
          <article key={l.title} className="layer">
            <div className={`ic ${l.tone}`}>{l.icon}</div>
            <h3>{l.title}</h3>
            <p>{l.body}</p>
            <div className="lim">{l.limit}</div>
          </article>
        ))}
      </div>
      <p style={{ marginTop: 14 }}><Link href="/redteam">Try an attack →</Link> · <a href={`${REPO}/blob/main/SECURITY.md`}>Read the security model</a></p>
    </section>
  );
}

export function CheckBand() {
  return (
    <section className="band" aria-labelledby="check">
      <h2 id="check">Don&rsquo;t trust us. Check.</h2>
      <p>Pick a recorded run and your browser re-reads the mandate from the contract and every chunk from public NEAR RPC, then recomputes the hashes, sums and price floors itself. No worker, no database, nothing of ours in the path.</p>
      <div className="cta-row" style={{ marginBottom: 0 }}>
        <Link className="btn lg" href="/recompute?run=custody&auto=1">Recompute a run</Link>
        <a className="btn ghost lg" href={`${REPO}/blob/main/docs/CLAIMS.md`}>Claims vs evidence</a>
      </div>
    </section>
  );
}

