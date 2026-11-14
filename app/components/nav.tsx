'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { WalletButton } from './wallet';
import { ENV } from '@/lib/data';

// Three groups so a first-time visitor can read the nav: what the DAO decides, what the agent does, how you check it.
const GROUPS: Array<{ label: string; links: ReadonlyArray<readonly [string, string]> }> = [
  { label: 'Govern', links: [['/', 'DAO'], ['/wizard', 'New mandate'], ['/votes', 'Votes'], ['/reputation', 'Reputation']] },
  { label: 'Run', links: [['/live', 'Live run'], ['/routes', 'Routes'], ['/copycat', 'Copycat view'], ['/redteam', 'Red team']] },
  { label: 'Prove', links: [['/custody', 'Custody'], ['/sealed', 'Sealed'], ['/report', 'Report'], ['/verify', 'Verify'], ['/recompute', 'Recompute'], ['/ledger', 'Ledger']] },
];

export function Nav() {
  const path = usePathname();
  return (
    <header className="top">
      <div className="row">
        <span className="brand">Quiet Treasury</span>
        <span className="pill" title="NEAR network used for chain reads">{ENV.network}</span>
        <WalletButton />
        <nav className="links" aria-label="Main">
          {GROUPS.map((g) => (
            <span key={g.label} role="group" aria-label={g.label} style={{ display: 'inline-flex', gap: 8, alignItems: 'baseline', marginRight: 14 }}>
              <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--muted)' }}>{g.label}</span>
              {g.links.map(([href, label]) => (
                <Link key={href} href={href} aria-current={path === href ? 'page' : undefined}>{label}</Link>
              ))}
            </span>
          ))}
        </nav>
      </div>
    </header>
  );
}