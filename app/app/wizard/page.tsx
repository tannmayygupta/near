'use client';
import { useEffect, useMemo, useState } from 'react';
import { ENV, fmtUnits, getRealRun, parseIntent, sha256Hex } from '@/lib/data';
import { BOUNDS, MandateTerms, boundIssues, type ParseResult } from '@/lib/types';
import { ErrorState, PageHead, Src } from '@/components/ui';
import { useWallet } from '@/components/wallet';

import { canonical } from '@/lib/canon';
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

export default function Wizard() {
  const w = useWallet();
  // Sample intent matches the network profile: testnet trades wNEAR/USDT.e on Ref Finance (USDC is never silently mapped to USDT.e); mainnet uses Intents assets.
  const [intent, setIntent] = useState(ENV.network === 'testnet'
    ? 'Sell up to 0.4 NEAR for USDT.e over the next 8 minutes, never below 2 USDT.e per NEAR, in chunks of 0.05 to 0.1 NEAR every 5 to 8 seconds. Pay 50% of the proceeds to alice at qtcontrib-68669.testnet and 20% to bob at qttreasurer-83872.testnet, both on near. Take a 0.5% service fee paid to qtfund-83872.testnet.'
    : 'Sell 20 NEAR for USDC over 3 days, not below 3.5 USDC per NEAR, then pay the two contributors on Solana and Base.');
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tier, setTier] = useState<'small' | 'mid' | 'large'>('small');
  const [confirmed, setConfirmed] = useState(false);
  const [sent, setSent] = useState<Record<string, string>>({});

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  async function run() {
    setBusy(true); setErr(null); setParsed(null); setConfirmed(false); setSent({});
    const r = await parseIntent(intent);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    const v = MandateTerms.safeParse(r.data.terms);
    if (!v.success) return setErr(`Parser output failed schema validation: ${v.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    setParsed({ ...r.data, terms: v.data });
  }

  const issues = useMemo(() => (parsed ? boundIssues(parsed.terms) : []), [parsed]);
  const [proposals, setProposals] = useState<{ create: object; fund: object; hash: string } | null>(null);

  async function build() {
    if (!parsed) return;
    // The treasurer is whoever proposes the mandate (it earns the on-chain trust score); the worker's parser only knows a placeholder, so bind the connected wallet here BEFORE hashing.
    if (!w.accountId) { setErr('Connect your NEAR wallet first: the connected account becomes the mandate’s treasurer (the account that earns the trust score).'); return; }
    setErr(null);
    const t = { ...parsed.terms, treasurer: w.accountId };
    const hash = await sha256Hex(canonical(t));
    const sellTokenContract = t.sellToken.replace(/^nep141:/, '');
    const create = {
      proposal: {
        description: `Quiet Treasury mandate: sell up to ${fmtUnits(t.maxSellAmount, BOUNDS.allowedTokens[t.sellToken]?.decimals ?? 0)} ${BOUNDS.allowedTokens[t.sellToken]?.symbol ?? ''} · terms_hash ${hash}${t.sealed ? ' (sealed)' : ''}`,
        kind: { FunctionCall: { receiver_id: ENV.mandate, actions: [{
          method_name: 'create_mandate', deposit: '0', gas: '100000000000000',
          args: b64(JSON.stringify({
            treasurer: t.treasurer, terms_hash: hash, terms_json: t.sealed ? null : canonical(t), sell_token: t.sellToken,
            max_sell: t.maxSellAmount, start_ns: t.startTs * 1_000_000_000, end_ns: t.endTs * 1_000_000_000, tier,
          })),
        }] } },
      },
    };
    let fund: object;
    if (ENV.network === 'testnet') {
      // REAL on testnet: native NEAR Sputnik Transfer from the DAO to the vault account that signs the Ref swaps (same as the recorded run).
      // The vault id comes from NEXT_PUBLIC_VAULT_ACCOUNT or the committed run; if neither exists we refuse instead of guessing.
      const run = await getRealRun();
      const vault = process.env.NEXT_PUBLIC_VAULT_ACCOUNT || (run.ok ? run.data.real.vault.accountId : '');
      if (!vault) { setErr('No vault account known for the funding transfer (set NEXT_PUBLIC_VAULT_ACCOUNT or commit a testnet-real run).'); return; }
      fund = {
        proposal: {
          description: `Fund the vault ${vault} with the mandate budget in native NEAR (terms_hash ${hash})`,
          kind: { Transfer: { token_id: '', receiver_id: vault, amount: t.maxSellAmount } },
        },
      };
    } else {
      // MAINNET design, UNVERIFIED (plan gate G3): intents.near ft_transfer_call msg format for crediting a third-party account.
      fund = {
        proposal: {
          description: `Fund agent wallet with the mandate budget (terms_hash ${hash}) - mainnet Intents path, UNVERIFIED`,
          kind: { Transfer: { token_id: sellTokenContract, receiver_id: 'intents.near', amount: t.maxSellAmount, msg: JSON.stringify({ receiver_id: ENV.agent }) } },
        },
      };
    }
    setProposals({ create, fund, hash });
  }

  async function submit(key: 'create' | 'fund') {
    if (!proposals) return;
    // Sputnik add_proposal requires the proposal bond (default 0.1 NEAR on testnet DAOs; read the DAO policy if different).
    const r = await w.call(ENV.dao, { methodName: 'add_proposal', args: proposals[key], gas: '150000000000000', deposit: '100000000000000000000000' });
    setSent((s) => ({ ...s, [key]: r.ok ? `sent ${r.detail}` : `error: ${r.error}` }));
  }

  const t = parsed?.terms;
  const rows: [string, string][] = t ? [
    ['Sell', `up to ${fmtUnits(t.maxSellAmount, BOUNDS.allowedTokens[t.sellToken]?.decimals ?? 0)} ${BOUNDS.allowedTokens[t.sellToken]?.symbol ?? t.sellToken}`],
    ['Buy', BOUNDS.allowedTokens[t.buyToken]?.symbol ?? t.buyToken],
    ['Price floor', `${t.minPrice} ${BOUNDS.allowedTokens[t.buyToken]?.symbol ?? ''} per ${BOUNDS.allowedTokens[t.sellToken]?.symbol ?? ''}`],
    ['Window', `${new Date(t.startTs * 1000).toISOString()} → ${new Date(t.endTs * 1000).toISOString()}`],
    ['Chunk size', `${fmtUnits(t.chunkMin, BOUNDS.allowedTokens[t.sellToken]?.decimals ?? 0, 6)} – ${fmtUnits(t.chunkMax, BOUNDS.allowedTokens[t.sellToken]?.decimals ?? 0, 6)} ${BOUNDS.allowedTokens[t.sellToken]?.symbol ?? ''}`],
    ['Interval', `${t.intervalMinS}s – ${t.intervalMaxS}s (randomised)`],
    ['Payouts', t.payouts.map((p) => `${p.label}: ${p.percent !== undefined ? `${p.percent}%` : p.amount} on ${p.chain}`).join(' · ') || 'none'],
    ['Fee', `${t.feeBps} bps${t.feeRecipient ? ` → ${t.feeRecipient}` : ''}`],
    ['Leftovers return to', t.returnTo],
    ['Mode', t.sealed ? 'sealed (hash on-chain, terms revealed in report)' : 'transparent'],
  ] : [];

  return (
    <>
      <PageHead title="New mandate" lead="Describe what the treasury should do in plain English. A private AI proposes structured terms; hard bounds are re-checked here, in the contract and in the worker. You review, then the DAO votes." />
      <div className="card">
        <label htmlFor="intent">Intent</label>
        <textarea id="intent" value={intent} onChange={(e) => setIntent(e.target.value)} />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" onClick={run} disabled={busy || intent.trim().length < 10}>{busy ? `Parsing… ${elapsed}s` : 'Parse with private AI'}</button>
          <span style={{ color: 'var(--muted)', fontSize: 13 }}>{busy ? 'The private AI is reading your request (10–40 s is normal; it may retry once if its first answer is invalid).' : 'Inference runs in a NEAR AI TEE; the AI only proposes, it never holds keys.'}</span>
        </div>
      </div>
      {err && <ErrorState what="Parsing" error={err} />}
      {parsed && t && (
        <>
          <h2>Review <Src s="api" /></h2>
          <p style={{ color: 'var(--muted)' }}>{parsed.summary}</p>
          {parsed.attestation && <p className="mono">attestation signer {parsed.attestation.signer} · nonce echoed: {String(parsed.attestation.nonceEchoed)}</p>}
          <div className="card"><table><thead><tr><th>Field</th><th>Parsed value</th></tr></thead><tbody>
            {rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}
          </tbody></table></div>
          <h2>Bounds check</h2>
          {issues.length === 0
            ? <div className="state"><span className="pill ok">all hard bounds satisfied</span> (token allow-list, duration, chunks, payouts, fee)</div>
            : <div className="state error" role="alert"><strong>Cannot proceed:</strong><ul>{issues.map((i) => <li key={i}>{i}</li>)}</ul></div>}
          <div className="card">
            <div className="row">
              <label htmlFor="tier">Approval tier</label>
              <select id="tier" value={tier} onChange={(e) => setTier(e.target.value as typeof tier)} style={{ padding: 8, borderRadius: 8 }}>
                <option value="small">small</option><option value="mid">mid</option><option value="large">large</option>
              </select>
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>Set from the budget by the app (not by the AI). Tier thresholds: see Votes.</span>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <input id="ok" type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <label htmlFor="ok">I reviewed these terms and they match my intent.</label>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="primary" disabled={!confirmed || issues.length > 0 || !ENV.dao || !ENV.mandate} onClick={build}>Build DAO proposals</button>
              {(!ENV.dao || !ENV.mandate) && <span className="pill bad">configure DAO + mandate contract</span>}
            </div>
          </div>
        </>
      )}
      {proposals && (
        <>
          <h2>Proposals to sign</h2>
          <p style={{ color: 'var(--muted)' }}>terms_hash <code>{proposals.hash}</code>. The DAO account executes these only after the vote passes.</p>
          {(['create', 'fund'] as const).map((k) => (
            <div className="card" key={k}>
              <strong>{k === 'create' ? '1 · create_mandate (FunctionCall)' : ENV.network === 'testnet' ? '2 · fund the vault (native NEAR Transfer from the DAO treasury, real on testnet)' : '2 · fund agent (Transfer → Intents balance, mainnet path UNVERIFIED)'}</strong>
              <pre>{JSON.stringify(proposals[k], null, 2)}</pre>
              <div className="row">
                <button className="primary" disabled={!w.accountId} onClick={() => submit(k)}>{w.accountId ? 'Sign with wallet' : 'Connect wallet to sign'}</button>
                <button onClick={() => navigator.clipboard.writeText(JSON.stringify(proposals[k]))}>Copy JSON</button>
                {sent[k] && <span className="mono">{sent[k]}</span>}
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}
