import { STATIC_DEMO } from '@/lib/data';

/** Shown only on the static hosted demo (GitHub Pages). */
export function StaticBanner() {
  if (!STATIC_DEMO) return null;
  return (
    <div className="wrap" role="note" aria-label="Hosted demo notice" style={{ paddingBottom: 0 }}>
      <div className="state" style={{ margin: '12px 0 0' }}>
        <strong>Hosted read-only demo.</strong> Pages read the committed testnet runs and the public NEAR testnet live from your browser.
        Parsing a new intent and firing live red-team attacks need the worker: run it locally (see the repo README, &ldquo;Run it&rdquo;).
        Everything shown opens on the public testnet explorer.
      </div>
    </div>
  );
}
