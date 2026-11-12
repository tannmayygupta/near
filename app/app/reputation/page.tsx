'use client';
import { ENV, getDaoPolicy, getMandates, getTrust } from '@/lib/data';
import { councilFromPolicy, getPosts, getProfile, getReputation, kvUrl, SOCIAL, tsFromNs, type KvEntry, type RepEntry } from '@/lib/social';
import { Acct } from '@/components/acct';
import { Empty, PageHead, Src, StatusPill, useAsync, View } from '@/components/ui';

const short = (h: string) => (h && h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h);
const link = (href: string, text: string) => <a href={href} target="_blank" rel="noreferrer" className="mono">{text}</a>;

function Why() {
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Why this is reputation</h2>
      <ul>
        <li><strong>One point = one settled mandate.</strong> The mandate contract adds +1 to a treasurer&apos;s trust score only when the agent anchors a settlement report with <em>zero violations</em>. There is no other way to earn a point.</li>
        <li><strong>Every point is traceable.</strong> Each entry below lists the mandate, its settlement report hash, the on-chain anchor transaction and the terms commitment. Anyone can re-check them against the contract.</li>
        <li><strong>Reputation changes what a treasurer can do.</strong> The worker reads the trust score when it decides how many approvals a mandate needs (small mandates need fewer approvals from a trusted treasurer).</li>
        <li><strong>It lives on near.social.</strong> The agent&apos;s named account publishes announcements, completions and the reputation entry to near.social (FastData KV on <span className="mono">{SOCIAL.receiver}</span>); the DAO itself can post by council vote.</li>
      </ul>
    </div>
  );
}

function Council() {
  const a = useAsync(getDaoPolicy, []);
  return (
    <View a={a} what="DAO members">
      {(policy, s) => {
        const groups = councilFromPolicy(policy);
        return groups.length === 0 ? <Empty what="council members" /> : (
          <div className="card"><table><thead><tr><th>Role</th><th>Members (named accounts)</th></tr></thead><tbody>
            {groups.map((g) => <tr key={g.role}><td>{g.role}<Src s={s} /></td><td>{g.members.map((m) => <div key={m}><Acct id={m} role={g.role} /></div>)}</td></tr>)}
          </tbody></table></div>
        );
      }}
    </View>
  );
}

function Treasurers() {
  const a = useAsync(async () => {
    const [m, rep] = await Promise.all([getMandates(), getReputation(ENV.agent)]);
    if (!m.ok) return m;
    const names = [...new Set(m.data.map((x) => x.treasurer))];
    const trust = await Promise.all(names.map(async (n) => ({ n, t: await getTrust(n) })));
    const bad = trust.find((r) => !r.t.ok);
    if (bad && !bad.t.ok) return { ok: false as const, error: bad.t.error };
    const repMap = new Map<string, RepEntry>(rep.ok ? rep.data.map((e) => [e.treasurer, e]) : []);
    return {
      ok: true as const, source: 'chain' as const,
      data: { repError: rep.ok ? null : rep.error, rows: trust.map((r) => ({ n: r.n, trust: (r.t as { ok: true; data: number }).data, rep: repMap.get(r.n) ?? null, completed: m.data.filter((x) => x.treasurer === r.n && x.status === 'Completed') })) },
    };
  }, []);
  return (
    <View a={a} what="treasurer reputation">
      {({ rows, repError }, s) => (
        <>
          {repError && <div className="state error" role="alert"><strong>near.social reputation entry unavailable.</strong><div className="mono">{repError}</div></div>}
          {rows.length === 0 ? <Empty what="treasurers" /> : rows.map((r) => {
            const match = r.rep ? r.rep.settled === r.trust : null;
            return (
              <div className="card" key={r.n} style={{ marginBottom: 12 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div><Acct id={r.n} role="treasurer" /></div>
                  <div>Trust score <strong>{r.trust}</strong><Src s={s} /> {match === true && <span className="pill ok">matches near.social entry</span>}{match === false && <span className="pill bad">differs from near.social entry</span>}{match === null && <span className="pill warn">no near.social entry yet</span>}</div>
                </div>
                <table style={{ marginTop: 8 }}><thead><tr><th>Settled mandate</th><th>Settlement report hash</th><th>Anchor tx</th><th>Terms commitment</th></tr></thead><tbody>
                  {(r.rep?.mandates ?? []).map((x) => (
                    <tr key={x.id}>
                      <td>#{x.id}</td>
                      <td className="mono" title={x.reportHash}>{short(x.reportHash)}</td>
                      <td>{x.anchorTx ? link(SOCIAL.explorerTx(x.anchorTx), short(x.anchorTx)) : <span className="pill warn">not resolved</span>}</td>
                      <td className="mono" title={x.terms_hash}>{short(x.terms_hash)}</td>
                    </tr>
                  ))}
                  {(r.rep?.mandates ?? []).length === 0 && <tr><td colSpan={4}>{r.completed.length ? `${r.completed.length} settled mandate(s) on chain; the near.social reputation entry has not been published yet.` : 'No settled mandates yet.'}</td></tr>}
                </tbody></table>
              </div>
            );
          })}
        </>
      )}
    </View>
  );
}

function Feed({ account, title, note }: { account: string; title: string; note: string }) {
  const a = useAsync(async () => {
    const [posts, profile] = await Promise.all([getPosts(account), getProfile(account)]);
    return posts.ok ? { ok: true as const, source: 'chain' as const, data: { posts: posts.data, profile: profile.ok ? profile.data : {} } } : posts;
  }, [account]);
  return (
    <section>
      <h2>{title}</h2>
      <p style={{ color: 'var(--muted)' }}>{note}</p>
      <View a={a} what={`${title} posts`}>
        {({ posts, profile }, s) => (
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div><Acct id={account} />{profile.name && <> <strong>{profile.name}</strong></>}</div>
              <div>{link(kvUrl(account), 'raw FastData KV')} {link(SOCIAL.viewer(account), 'near.social view')}</div>
            </div>
            {posts.length === 0 ? <Empty what="posts" /> : posts.map((p: KvEntry) => (
              <article key={p.key} style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8 }}>
                <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{p.value.text}</div>
                <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
                  <span className="mono">{p.key}</span> · {tsFromNs(p.block_timestamp)} · block {p.block_height}<Src s={s} />
                </div>
              </article>
            ))}
          </div>
        )}
      </View>
    </section>
  );
}

export default function Reputation() {
  const mandates = useAsync(getMandates, []);
  return (
    <>
      <PageHead title="Reputation" lead="Social Money: who the DAO trusts, and why. Named accounts, earned trust, every point traceable to a settled mandate, published on near.social." />
      <Why />
      <h2>Council (Sputnik DAO roles)</h2>
      <Council />
      <h2>Treasurer reputation</h2>
      <Treasurers />
      <Feed account={ENV.agent} title="Agent posts on near.social" note="Announcements, completions and the reputation entry, written by the agent's named account. Idempotent: restarts never double-post." />
      <Feed account={ENV.dao} title="DAO posts on near.social (by council vote)" note="The DAO account itself is the author: a Sputnik FunctionCall proposal, approved 2 of 3, made the DAO call the social account. Sputnik shows that proposal as Failed because the social account has no contract. That is expected by the near.social standard; the post still lands, as shown here." />
      <View a={mandates} what="mandate statuses">
        {(ms) => ms.length > 0 ? <p style={{ color: 'var(--muted)' }}>On chain: {ms.length} mandate(s) — {ms.map((m) => <span key={m.id} style={{ marginRight: 6 }}>#{m.id} <StatusPill status={m.status} /></span>)}</p> : null}
      </View>
    </>
  );
}
