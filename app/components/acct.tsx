'use client';
// One consistent way to show a NEAR account: named accounts are shown in full with an explorer link; 64-hex implicit accounts are
// shortened and labelled "implicit" (they have no human name). Optional role label (e.g. "council", "treasurer", "agent").
import { SOCIAL, isNamed } from '@/lib/social';

export function Acct({ id, role }: { id: string; role?: string }) {
  if (!id) return <span className="mono">-</span>;
  const named = isNamed(id);
  const shown = named ? id : `${id.slice(0, 8)}…${id.slice(-6)}`;
  return (
    <span className="acct">
      <a className="mono" href={SOCIAL.explorerAccount(id)} target="_blank" rel="noreferrer" title={named ? `${id} (named account)` : `${id} (implicit account: no human-readable name)`}>{shown}</a>
      {!named && <span className="pill warn" style={{ marginLeft: 6 }}>implicit</span>}
      {role && <span className="pill" style={{ marginLeft: 6 }}>{role}</span>}
    </span>
  );
}
