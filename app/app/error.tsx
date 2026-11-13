'use client';
import Link from 'next/link';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="state" role="alert">
      <strong>Something went wrong loading this page.</strong>
      <p style={{ margin: '8px 0' }}>Nothing here can move funds: the pages only read recorded runs and public testnet data. A chain read or a data file probably failed; trying again usually works.</p>
      <div className="row"><button className="primary" onClick={reset}>Try again</button><Link href="/">Back to the overview</Link></div>
    </div>
  );
}