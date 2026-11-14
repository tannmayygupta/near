import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Bricolage_Grotesque, Instrument_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Nav } from '@/components/nav';
import { StaticBanner } from '@/components/banner';
import { WalletProvider } from '@/components/wallet';

// Self-hosted at build time by next/font: no request to Google from the visitor's browser.
const display = Bricolage_Grotesque({ subsets: ['latin'], variable: '--f-display', display: 'swap' });
const body = Instrument_Sans({ subsets: ['latin'], variable: '--f-body', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--f-mono', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Quiet Treasury: vote once, the agent does the rest', template: '%s | Quiet Treasury' },
  description: 'A DAO votes once on a plain-English mandate; a bounded agent executes it inside limits it cannot break and an independent verifier proves it stayed in bounds. NEAR testnet.',
  openGraph: { title: 'Quiet Treasury', description: 'Vote once. The agent does the rest, inside limits it cannot break. Verifiable on NEAR testnet.', type: 'website' },
  twitter: { card: 'summary', title: 'Quiet Treasury', description: 'Vote once. The agent does the rest, inside limits it cannot break.' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

const REPO = 'https://github.com/tannmayygupta/near';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <WalletProvider>
          <a className="skip" href="#main">Skip to content</a>
          <Nav />
          <StaticBanner />
          <main id="main" className="wrap">{children}</main>
          <footer className="foot">
            <div className="cols">
              <div>
                <h4>Quiet Treasury</h4>
                <p style={{ margin: 0, maxWidth: '34ch' }}>Vote once. The agent does the rest, inside limits it cannot break. Every claim links to evidence you can check yourself.</p>
              </div>
              <div>
                <h4>Product</h4>
                <ul><li><Link href="/wizard">New mandate</Link></li><li><Link href="/votes">Votes</Link></li><li><Link href="/live">Live run</Link></li><li><Link href="/me">My payouts</Link></li></ul>
              </div>
              <div>
                <h4>Proof</h4>
                <ul><li><Link href="/recompute">Recompute a run</Link></li><li><Link href="/verify">Verify a bundle</Link></li><li><Link href="/custody">Custody</Link></li><li><Link href="/redteam">Red team</Link></li></ul>
              </div>
              <div>
                <h4>Read</h4>
                <ul><li><a href={`${REPO}/blob/main/docs/CLAIMS.md`}>Claims vs evidence</a></li><li><a href={`${REPO}/blob/main/docs/JUDGES.md`}>5-minute judges path</a></li><li><a href={`${REPO}/blob/main/SECURITY.md`}>Security model</a></li><li><a href={REPO}>Source</a></li></ul>
              </div>
            </div>
            <div className="legend">
              Tags next to numbers show their source: <span className="tag chain">chain</span> real on-chain fact (NEAR RPC or a transaction you can open), <span className="tag api">api</span> worker API, <span className="tag recorded">recorded</span> committed run (provenance; its on-chain facts carry a transaction link). A &ldquo;simulated&rdquo; tag appears only if the data itself says so. Not investment advice.
              <div style={{ marginTop: 8 }}>NEAR <strong>testnet</strong> only: no mainnet funds were moved. What is proven and what is not: <a href={`${REPO}/blob/main/docs/CLAIMS.md`}>claims vs evidence</a>.</div>
            </div>
          </footer>
        </WalletProvider>
      </body>
    </html>
  );
}
