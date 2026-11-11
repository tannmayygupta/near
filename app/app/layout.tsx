import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Nav } from '@/components/nav';
import { WalletProvider } from '@/components/wallet';

export const metadata: Metadata = {
  title: 'Quiet Treasury',
  description: 'A DAO votes once on a plain-English mandate; a sealed-chip agent executes it privately and proves it stayed in bounds.',
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>
          <Nav />
          <main className="wrap">{children}</main>
          <footer className="wrap" style={{ color: 'var(--muted)', fontSize: 13 }}>
            Tags next to numbers show their source: <span className="tag chain">chain</span> NEAR RPC, <span className="tag api">api</span> worker API, <span className="tag recorded">recorded</span> committed real run. Not investment advice.
          </footer>
        </WalletProvider>
      </body>
    </html>
  );
}
