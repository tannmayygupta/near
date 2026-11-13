import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="state">
      <strong>That page does not exist.</strong>
      <p style={{ margin: '8px 0' }}>Start from the overview, or open the proof pages: <Link href="/custody">Custody</Link>, <Link href="/verify">Verify</Link>, <Link href="/redteam">Red team</Link>.</p>
    </div>
  );
}