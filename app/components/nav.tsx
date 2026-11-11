'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { WalletButton } from './wallet';
import { ENV } from '@/lib/data';

const LINKS = [
  ['/', 'DAO'], ['/wizard', 'New mandate'], ['/votes', 'Votes'], ['/live', 'Live run'], ['/copycat', 'Copycat view'],
  ['/redteam', 'Red team'], ['/report', 'Report'], ['/verify', 'Verify'], ['/ledger', 'Ledger'],
] as const;

export function Nav() {
  const path = usePathname();
  return (
    <header className="top">
      <div className="row">
        <span className="brand">Quiet Treasury</span>
        <span className="pill" title="NEAR network used for chain reads">{ENV.network}</span>
        <WalletButton />
        <nav className="links" aria-label="Main">
          {LINKS.map(([href, label]) => (
            <Link key={href} href={href} aria-current={path === href ? 'page' : undefined}>{label}</Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
