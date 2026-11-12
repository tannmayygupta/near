// Publishes DAO treasury activity to near.social (FastData KV) from a NAMED account, idempotently:
//   (a) an announcement post when a mandate is Approved (sealed mandates: hash + budget only),
//   (b) a completion post with the settlement report hash + anchor tx,
//   (c) the treasurer's reputation entry: contract trust score + every settled mandate it is traceable to (report hash, anchor tx).
// Idempotency lives in the worker sqlite (table social_posts) - a restart never double-posts. Every row keeps the KV tx hash.
import type { DatabaseSync } from 'node:sqlite';
import { BOUNDS } from '../src/engine/schema';
import type { OnChainMandate } from '../src/near/mandate';
import { postArgs, postId, profileArgs, reputationArgs, writeKv, type KvSender, type ReputationEntry, type SocialNet } from '../src/near/social';
import type { Logger } from './ports';

export interface PublisherChain { listMandates(): Promise<OnChainMandate[]>; getTrust(treasurer: string): Promise<number> }
export interface PublisherDeps {
  net: SocialNet; account: string; dao: string; contract: string;
  chain: PublisherChain; send: KvSender; db: DatabaseSync; log: Logger;
  /** best effort: find the tx hash of the `complete` call that anchored this report hash (undefined if unknown) */
  findAnchorTx?: (m: OnChainMandate) => Promise<string | undefined>;
  explorerAccount?: (id: string) => string;
}

const fmtAmount = (raw: string, token: string) => {
  const t = BOUNDS.allowedTokens[token];
  if (!t) return `${raw} (smallest units of ${token})`;
  const n = BigInt(raw), d = 10n ** BigInt(t.decimals);
  const frac = (n % d).toString().padStart(t.decimals, '0').slice(0, 4).replace(/0+$/, '');
  return `${n / d}${frac ? '.' + frac : ''} ${t.symbol}`;
};
const iso = (ns: number) => new Date(Math.floor(ns / 1e6)).toISOString().replace('.000Z', 'Z');
const tokName = (token: string) => BOUNDS.allowedTokens[token]?.symbol ?? token;

export function announceText(m: OnChainMandate, d: { dao: string; contract: string; link: (id: string) => string }): string {
  const sealed = m.terms_json === null;
  return [
    `#QuietTreasury mandate #${m.id} approved by the DAO ${d.dao} (tier: ${m.tier}).`,
    `Budget: up to ${fmtAmount(m.max_sell, m.sell_token)} to sell between ${iso(m.start_ns)} and ${iso(m.end_ns)}.`,
    sealed ? `Terms are SEALED: only the commitment ${m.terms_hash} is public; the full terms are revealed in the settlement report.` : `Terms commitment: ${m.terms_hash}.`,
    `Source of truth: ${d.link(d.contract)} (get_mandate ${m.id}). The agent cannot exceed this mandate. #NEARHackathon`,
  ].join('\n');
}

export function completeText(m: OnChainMandate, d: { dao: string; contract: string; link: (id: string) => string }, anchorTx?: string): string {
  return [
    `#QuietTreasury mandate #${m.id} settled: ${fmtAmount(m.sold, m.sell_token)} sold across ${m.chunks} chunk(s), settlement report anchored on-chain.`,
    `Report hash: ${m.report_hash}${anchorTx ? ` (anchor tx ${anchorTx})` : ''}.`,
    `Verify: ${d.link(d.contract)} -> get_mandate ${m.id}.report_hash must equal the hash above. Treasurer ${m.treasurer} earns +1 reputation only for zero-violation settlements. #NEARHackathon`,
  ].join('\n');
}

export class SocialPublisher {
  constructor(private d: PublisherDeps) {
    d.db.exec('CREATE TABLE IF NOT EXISTS social_posts(key TEXT PRIMARY KEY, kv_tx TEXT NOT NULL, ts INTEGER NOT NULL, detail TEXT)');
  }
  private link = (id: string) => (this.d.explorerAccount ?? ((a: string) => `https://explorer.testnet.near.org/accounts/${a}`))(id);
  private done(key: string): boolean { return !!this.d.db.prepare('SELECT 1 FROM social_posts WHERE key=?').get(key); }
  private mark(key: string, tx: string, detail: unknown) { this.d.db.prepare('INSERT OR REPLACE INTO social_posts VALUES(?,?,?,?)').run(key, tx, Math.floor(Date.now() / 1000), JSON.stringify(detail)); }
  records() { return this.d.db.prepare('SELECT key, kv_tx, ts, detail FROM social_posts ORDER BY ts').all() as unknown as Array<{ key: string; kv_tx: string; ts: number; detail: string }>; }

  private async publish(key: string, args: Record<string, unknown>, detail: unknown) {
    const w = await writeKv(this.d.net, this.d.send, args);
    this.mark(key, w.txHash, detail);
    this.d.log('social_published', { key, tx: w.txHash, explorer: w.explorer });
    return w;
  }

  /** One pass; safe to call on every worker tick (does nothing when everything is already published). */
  async tick(): Promise<number> {
    let n = 0;
    const { dao, contract } = this.d;
    if (!this.done('profile')) {
      await this.publish('profile', profileArgs({ name: 'Quiet Treasury Agent', about: `Posts DAO treasury mandates and settled-mandate reputation for ${dao}. Every claim links to on-chain state. #NEARHackathon` }), {});
      n++;
    }
    const ms = await this.d.chain.listMandates();
    const settledBy = new Map<string, OnChainMandate[]>();
    for (const m of ms) {
      if (m.status === 'Completed' && m.report_hash) settledBy.set(m.treasurer, [...(settledBy.get(m.treasurer) ?? []), m]);
      if (!['Cancelled', 'Expired'].includes(m.status) && !this.done(`announce:${m.id}`)) {
        const text = announceText(m, { dao, contract, link: this.link });
        await this.publish(`announce:${m.id}`, postArgs(postId(m.id, 'announce'), text), { mandate: m.id });
        n++;
      }
      if (m.status === 'Completed' && m.report_hash && !this.done(`complete:${m.id}`)) {
        const anchorTx = await this.d.findAnchorTx?.(m).catch(() => undefined);
        await this.publish(`complete:${m.id}`, postArgs(postId(m.id, 'complete'), completeText(m, { dao, contract, link: this.link }, anchorTx)), { mandate: m.id, reportHash: m.report_hash, anchorTx });
        n++;
      }
    }
    for (const [treasurer, list] of settledBy) {
      const trust = await this.d.chain.getTrust(treasurer);
      const key = `reputation:${treasurer}:${list.length}:${trust}`;
      if (this.done(key)) continue;
      const entry: ReputationEntry = {
        treasurer, settled: trust,
        mandates: await Promise.all(list.map(async (m) => ({ id: m.id, reportHash: m.report_hash!, terms_hash: m.terms_hash, anchorTx: await this.d.findAnchorTx?.(m).catch(() => undefined), contract, dao }))),
      };
      await this.publish(key, reputationArgs(entry), { treasurer, settled: trust, mandates: list.map((m) => m.id) });
      n++;
    }
    return n;
  }
}

/** Best-effort anchor lookup: list recent `complete` txs on the contract (NearBlocks v3), decode their args over RPC, match the report hash. */
export function nearblocksAnchorFinder(o: { api: string; rpc: string; contract: string; fetchImpl?: typeof fetch; decode: (txHash: string, signer: string) => Promise<{ args: any } | null> }) {
  const f = o.fetchImpl ?? fetch;
  return async (m: OnChainMandate): Promise<string | undefined> => {
    const r = await f(`${o.api}/v3/accounts/${o.contract}/txns?limit=100`);
    if (!r.ok) return undefined;
    const j: any = await r.json();
    for (const t of j.data ?? []) {
      if (!(t.actions ?? []).some((a: any) => a.method === 'complete')) continue;
      const dec = await o.decode(t.transaction_hash, t.signer_account_id).catch(() => null);
      if (dec?.args?.report_hash === m.report_hash && Number(dec.args.id) === m.id) return t.transaction_hash;
    }
    return undefined;
  };
}
