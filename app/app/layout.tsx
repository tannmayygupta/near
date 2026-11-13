import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Nav } from '@/components/nav';
import { StaticBanner } from '@/components/banner';
import { WalletProvider } from '@/components/wallet';

export const metadata: Metadata = {
  title: { default: 'Quiet Treasury', template: '%s | Quiet Treasury' },
  description: 'A DAO votes once on a plain-English mandate; a bounded agent executes it inside limits and an independent verifier proves it stayed in bounds. NEAR testnet.',
  openGraph: { title: 'Quiet Treasury', description: 'Vote once. The agent does the rest, inside limits it cannot break. Verifiable on NEAR testnet.', type: 'website' },
  twitter: { card: 'summary', title: 'Quiet Treasury', description: 'Vote once. The agent does the rest, inside limits it cannot break.' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>
          <Nav />
          <StaticBanner />
          <main className="wrap">{children}</main>
          <footer className="wrap" style={{ color: 'var(--muted)', fontSize: 13 }}>
            Tags next to numbers show their source: <span className="tag chain">chain</span> real on-chain fact (NEAR RPC or a transaction you can open), <span className="tag api">api</span> worker API, <span className="tag recorded">recorded</span> committed run (provenance; its on-chain facts carry a transaction link). A &ldquo;simulated&rdquo; tag appears only if the data itself says so. Not investment advice.
            <div style={{ marginTop: 8 }}>NEAR <strong>testnet</strong> only: no mainnet funds were moved. What is proven and what is not: <a href="https://github.com/tannmayygupta/near/blob/main/docs/CLAIMS.md">claims vs evidence</a> · <a href="https://github.com/tannmayygupta/near/blob/main/docs/JUDGES.md">5-minute judges path</a> · <a href="https://github.com/tannmayygupta/near">source</a>.</div>
            <div style={{ marginTop: 8 }}>NEAR <strong>testnet</strong> only: no mainnet funds were moved. What is proven and what is not: <a href="https://github.com/tannmayygupta/near/blob/main/docs/CLAIMS.md">claims vs evidence</a> · <a href="https://github.com/tannmayygupta/near/blob/main/docs/JUDGES.md">5-minute judges path</a> · <a href="https://github.com/tannmayygupta/near">source</a>.</div>
          </footer>
        </WalletProvider>
      </body>
    </html>
  );
}

