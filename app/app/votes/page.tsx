'use client';
import { useState } from 'react';
import { ENV, getDaoPolicy, getMandates, getProposals, getTrust } from '@/lib/data';
import { PageHead, Src, StatusPill, useAsync, View } from '@/components/ui';
import { TIER_RULES } from '@/components/mandates';
import { Acct } from '@/components/acct';
import { RunTxList } from '@/components/real';
import { useWallet } from '@/components/wallet';
import type { DaoProposal } from '@/lib/types';

const kindName = (k: Record<string, unknown>) => Object.keys(k)[0] ?? 'unknown';
const tally = (p: DaoProposal) => {
  const vc = Object.values(p.vote_counts ?? {});
  const sum = (i: number) => vc.reduce((s, v) => s + Number(v[i] ?? 0), 0);
  return { approve: sum(0), reject: sum(1), remove: sum(2) };
};

function Treasurers() {
  const a = useAsync(async () => {
    const m = await getMandates();
    if (!m.ok) return m;
    const names = [...new Set(m.data.map((x) => x.treasurer))];
    const rows = await Promise.all(names.map(async (n) => ({ n, t: await getTrust(n) })));
    const bad = rows.find((r) => !r.t.ok);
    if (bad && !bad.t.ok) return { ok: false as const, error: bad.t.error };
    return { ok: true as const, source: 'chain' as const, data: rows.map((r) => ({ n: r.n, t: (r.t as { ok: true; data: number }).data })) };
  }, []);
  return (
    <View a={a} what="treasurer trust scores">
      {(rows, s) => rows.length === 0 ? <div className="state">No treasurers yet.</div> : (
        <div className="card"><table><thead><tr><th>Treasurer</th><th>Mandates settled with zero violations</th></tr></thead><tbody>
          {rows.map((r) => <tr key={r.n}><td><Acct id={r.n} role="treasurer" /></td><td>{r.t}<Src s={s} /></td></tr>)}
        </tbody></table></div>
      )}
    </View>
  );
}

export default function Votes() {
  const w = useWallet();
  const props = useAsync(getProposals, []);
  const policy = useAsync(getDaoPolicy, []);
  const [msg, setMsg] = useState<Record<number, string>>({});

  async function vote(id: number, action: 'VoteApprove' | 'VoteReject', kind: unknown) {
    // this Sputnik version requires the proposal kind to be echoed back in act_proposal
    const r = await w.call(ENV.dao, { methodName: 'act_proposal', args: { id, action, proposal: kind }, gas: '150000000000000', deposit: '0' });
    setMsg((m) => ({ ...m, [id]: r.ok ? `${action} sent` : `error: ${r.error}` }));
    props.reload();
  }

  return (
    <>
      <PageHead title="Votes" lead="Every mandate and every funding transfer is a real Sputnik DAO proposal. The agent does nothing before the proposal passes." />
      <h2>Proposals</h2>
      <View a={props} what="DAO proposals">
        {(list, s) => list.length === 0 ? <div className="state">No proposals yet.</div> : (
          <div className="card"><table>
            <thead><tr><th>ID</th><th>Kind</th><th>Description</th><th>Status</th><th>Approve / reject</th><th>Vote</th></tr></thead>
            <tbody>
              {[...list].reverse().map((p) => {
                const t = tally(p);
                return (
                  <tr key={p.id}>
                    <td>#{p.id}</td><td>{kindName(p.kind)}</td>
                    <td style={{ maxWidth: 360 }}>{p.description}</td>
                    <td><StatusPill status={p.status} /></td>
                    <td>{t.approve} / {t.reject}<Src s={s} /></td>
                    <td>
                      {p.status === 'InProgress' ? (
                        <div className="row">
                          <button className="primary" disabled={!w.accountId} onClick={() => vote(p.id, 'VoteApprove', p.kind)}>Approve</button>
                          <button className="danger" disabled={!w.accountId} onClick={() => vote(p.id, 'VoteReject', p.kind)}>Reject</button>
                        </div>
                      ) : '—'}
                      {msg[p.id] && <div className="mono">{msg[p.id]}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </View>
      <RunTxList match={/proposal|vote/i} caption="Real proposal and vote transactions (recorded run, incl. the funding Transfer and the cancel)" />
      <h2>Approval tiers <span className="tag chain">design</span></h2>
      <div className="card"><table><tbody>
        {Object.entries(TIER_RULES).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}
      </tbody></table>
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>Tiers are enforced by the mandate contract plus the worker reading proposal votes. The DAO’s own roles and thresholds are below.</p></div>
      <h2>Treasurer trust <Src s="chain" /></h2>
      <Treasurers />
      <h2>DAO roles and thresholds</h2>
      <View a={policy} what="DAO policy">
        {(p, s) => {
          const roles = (p as { roles?: { name: string; kind: unknown; permissions: string[]; vote_policy: unknown }[] }).roles ?? [];
          return <div className="card"><table><thead><tr><th>Role</th><th>Members</th><th>Permissions</th><th>Vote policy</th></tr></thead><tbody>
            {roles.map((r) => (
              <tr key={r.name}><td>{r.name}<Src s={s} /></td><td className="mono">{JSON.stringify(r.kind)}</td><td className="mono">{r.permissions.join(', ')}</td><td className="mono">{JSON.stringify(r.vote_policy)}</td></tr>
            ))}</tbody></table></div>;
        }}
      </View>
    </>
  );
}

