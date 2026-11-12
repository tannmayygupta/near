// Sealed-mandate (commit-reveal) checks. A sealed mandate keeps its terms off the public chain until settlement:
//   create_mandate(terms_hash = sha256(salt|canonical terms), terms_json = null)  ->  ... trading ...  ->  complete(..., revealed_terms = {salt, terms}).
// These checks prove, from public data only, that (1) nothing secret was public while the mandate ran, (2) the reveal matches the commitment,
// (3) the revealed terms are the ones the on-chain budget/window and the executor's report actually followed.
import { commit } from '../engine/hash';
import { fillPrice } from '../engine/benchmark';
import type { Report } from '../engine/settlement';

export interface SealedEvidence {
  /** the mandate as read from chain AFTER completion */
  onChain: { terms_hash: string; terms_json: string | null; revealed_terms: string | null; sell_token: string; max_sell: string; start_ns: number; end_ns: number };
  /** serialized PUBLIC view captured WHILE the mandate was executing (chain mandate + the DAO proposal text/kind) */
  publicBefore: { terms_json: string | null; revealed_terms: string | null; text: string };
  /** secret term values (recipient addresses, field names, the floor literal) that must NOT occur in `publicBefore.text` */
  forbidden: string[];
  decimals: { sell: number; buy: number };
}
export interface SealedCheck { name: string; ok: boolean; detail?: string }

export function sealedChecks(s: SealedEvidence, report?: Report): SealedCheck[] {
  const out: SealedCheck[] = [];
  const run = (name: string, fn: () => boolean | string) => {
    try { const r = fn(); out.push(typeof r === 'string' ? { name, ok: false, detail: r } : { name, ok: !!r }); }
    catch (e: any) { out.push({ name, ok: false, detail: e.message }); }
  };

  run('sealed: while the mandate ran the public chain view carried NO terms', () => s.publicBefore.terms_json === null && s.publicBefore.revealed_terms === null || 'terms were public before completion');
  run('sealed: no secret term value (recipients, floor, field names) appears in the public pre-reveal view', () => {
    const leaked = s.forbidden.filter((f) => s.publicBefore.text.includes(f));
    return leaked.length === 0 || `leaked: ${leaked.join(', ')}`;
  });

  let revealed: { salt: string; terms: any } | null = null;
  run('sealed: the reveal is published on chain after settlement', () => {
    if (!s.onChain.revealed_terms) return 'no revealed_terms on chain';
    revealed = JSON.parse(s.onChain.revealed_terms);
    return !!revealed && typeof revealed.salt === 'string' && typeof revealed.terms === 'object' || 'malformed reveal';
  });
  if (!revealed) return out;
  const { salt, terms } = revealed as { salt: string; terms: any };

  run('sealed: sha256(salt | revealed terms) equals the commitment that was public from the start', () => commit(terms, salt) === s.onChain.terms_hash || 'commitment mismatch: terms or salt were altered');
  run('sealed: the commitment had a real salt (>= 16 chars), so low-entropy terms cannot be brute-forced', () => salt.length >= 16 || 'salt too short');
  run('sealed: revealed terms match the public on-chain budget (token, max amount, window)', () =>
    terms.sellToken === s.onChain.sell_token && String(terms.maxSellAmount) === String(s.onChain.max_sell) && terms.startTs * 1e9 === s.onChain.start_ns && terms.endTs * 1e9 === s.onChain.end_ns || 'revealed terms disagree with chain fields');

  if (report) {
    run('sealed: every fill respected the REVEALED price floor', () => {
      const floor = Number(terms.minPrice);
      const bad = report.fills.filter((f) => fillPrice(f, s.decimals.sell, s.decimals.buy) + 1e-12 < floor);
      return bad.length === 0 || `${bad.length} fill(s) below revealed floor ${terms.minPrice}`;
    });
    run('sealed: total sold stayed within the revealed budget', () => report.fills.reduce((a, f) => a + BigInt(f.amountIn), 0n) <= BigInt(terms.maxSellAmount) || 'sold more than the budget');
    run('sealed: every payout and return went to a revealed recipient (payout list, fee recipient or DAO)', () => {
      const ok = new Set<string>([...(terms.payouts ?? []).map((p: any) => p.address), terms.returnTo, ...(terms.feeRecipient ? [terms.feeRecipient] : [])]);
      const stray = [...report.payouts.map((p) => p.address), ...report.leftovers.map((l) => l.returnedTo)].filter((a) => !ok.has(a));
      return stray.length === 0 || `unrevealed recipient(s): ${stray.join(', ')}`;
    });
  }
  return out;
}
