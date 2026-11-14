'use client';
// The proof strip: numbers READ from the recorded runs (never typed), each linking to its evidence page.
import Link from 'next/link';
import { getCustodyRun, getRestartRun } from '@/lib/custody';
import { Src, Stat, useAsync } from '@/components/ui';

export function StartHere() {
  const custody = useAsync(getCustodyRun, []);
  const restart = useAsync(getRestartRun, []);
  const c = !custody.loading && custody.result.ok ? custody.result.data : null;
  const r = !restart.loading && restart.result.ok ? restart.result.data : null;
  const passed = (x: { results: { ok: boolean }[] } | null) => (x ? `${x.results.filter((y) => y.ok).length}/${x.results.length}` : '…');
  return (
    <section aria-labelledby="start-here">
      <div className="section-head">
        <h2 id="start-here">Proof, read from the runs</h2>
        <p>Every number below comes from a recorded run on public NEAR testnet, with an explorer link on each row of its page. No mainnet funds were moved.</p>
      </div>
      <div className="grid">
        <Stat k="Custody run checks passed" v={passed(c)} s="recorded" />
        <Stat k="Real swaps signed by the OutLayer wallet" v={c ? c.real.swaps.length : '…'} s="recorded" />
        <Stat k="Red-team attacks blocked" v={c ? `${c.redteam.filter((x) => x.blocked).length}/${c.redteam.length}` : '…'} s="recorded" />
        <Stat k="Protocol refusals of the scoped agent key" v={c?.protocolScope ? `${c.protocolScope.probes.filter((p) => p.ok).length}/${c.protocolScope.probes.length}` : '…'} s="recorded" />
        <Stat k="Crash-restart checks passed" v={passed(r)} s="recorded" />
      </div>
      <p style={{ margin: '16px 0 0' }} className="row">
        <Link href="/custody">See the custody run</Link> · <Link href="/redteam">Try an attack</Link> · <Link href="/verify">Verify a run</Link> · <Link href="/recompute">Recompute one in your browser</Link> · <Link href="/me">Look up your payouts</Link> · <Link href="/sealed">Sealed mandates</Link>
        <Src s="recorded" />
      </p>
    </section>
  );
}
