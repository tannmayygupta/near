'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { WalletButton } from './wallet';
import { ENV } from '@/lib/data';

// Three groups so a first-time visitor can read the nav: what the DAO decides, what the agent does, how you check it.
// (Routes and labels are unchanged; only the look is new.)
const GROUPS: Array<{ label: string; links: ReadonlyArray<readonly [string, string]> }> = [
  { label: 'Govern', links: [['/', 'Home'], ['/wizard', 'New mandate'], ['/votes', 'Votes'], ['/reputation', 'Reputation']] },
  { label: 'Run', links: [['/live', 'Live run'], ['/me', 'My payouts'], ['/routes', 'Routes'], ['/copycat', 'Copycat view'], ['/redteam', 'Red team']] },
  { label: 'Prove', links: [['/custody', 'Custody'], ['/sealed', 'Sealed'], ['/report', 'Report'], ['/verify', 'Verify'], ['/recompute', 'Recompute'], ['/ledger', 'Ledger']] },
];

/** The mark: a vault dial. Ink tile, mint ring, one quiet dot. */
function Mark() {
  return (
    <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="10" fill="#0f1b2d" />
      <circle cx="16" cy="16" r="8.2" fill="none" stroke="#10d28a" strokeWidth="2.6" strokeDasharray="38 14" strokeLinecap="round" transform="rotate(-70 16 16)" />
      <circle cx="16" cy="16" r="2.4" fill="#ffffff" />
    </svg>
  );
}

export function Nav() {
  const path = usePathname();
  return (
    <header className="top">
      <div className="bar">
        <Link href="/" className="brand" aria-label="Quiet Treasury, home"><Mark />Quiet Treasury</Link>
        <span className="pill" title="NEAR network used for chain reads">{ENV.network}</span>
        <WalletButton />
      </div>
      <nav className="links" aria-label="Main">
        {GROUPS.map((g) => (
          <span key={g.label} className="grp" role="group" aria-label={g.label}>
            <span className="lab" aria-hidden="true">{g.label}</span>
            {g.links.map(([href, label]) => (
              <Link key={href} href={href} aria-current={path === href ? 'page' : undefined}>{label}</Link>
            ))}
          </span>
        ))}
      </nav>
    </header>
  );
}
