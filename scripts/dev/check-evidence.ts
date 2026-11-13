// Pre-submit evidence audit: EVERY transaction we cite must exist on public NEAR testnet.
// Collects tx hashes from (a) explorer links in README.md / docs / llms.txt and (b) tx-like fields of the recorded runs in data/**.json,
// then looks each one up on the nearblocks testnet API (throttled, retried). Writes data/evidence-check.json and exits 1 if any hash is missing.
// Run: npm run check:evidence        (needs network; not part of CI)
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const walk = (d: string, out: string[] = []): string[] => { for (const n of readdirSync(d)) { if (['node_modules', '.git', '.next', 'secret'].includes(n)) continue; const p = join(d, n); statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; };
const cited = new Map<string, Set<string>>(); // hash -> files
const add = (h: string, f: string) => { if (!cited.has(h)) cited.set(h, new Set()); cited.get(h)!.add(f); };

for (const f of [...walk('docs'), 'README.md', 'llms.txt'].filter((x) => /\.(md|txt)$/.test(x) && existsSync(x))) {
  for (const m of readFileSync(f, 'utf8').matchAll(/explorer\.testnet\.near\.org\/transactions\/([1-9A-HJ-NP-Za-km-z]{43,44})/g)) add(m[1], f.replaceAll('\\', '/'));
}
const KEY = /(^|_)(tx|txhash|storetx|swaptx|wraptx|withdrawtx|hash|crashedhash|policytx|dest_tx)$/i;
const SKIP = /(report|terms|code|response|request|block|chat)hash|hash_hex/i;
const visit = (v: unknown, k: string, f: string) => {
  if (typeof v === 'string') { if (KEY.test(k) && !SKIP.test(k) && HASH.test(v)) add(v, f); for (const m of v.matchAll(/explorer\.testnet\.near\.org\/transactions\/([1-9A-HJ-NP-Za-km-z]{43,44})/g)) add(m[1], f); }
  else if (Array.isArray(v)) v.forEach((x) => visit(x, k, f));
  else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) visit(vv, kk, f);
};
for (const f of walk('data').filter((x) => x.endsWith('.json') && !x.includes('proof-bundle') && !x.includes('mainnet-'))) { try { visit(JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')), '', f.replaceAll('\\', '/')); } catch { /* not json */ } }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function exists(h: string): Promise<'ok' | 'missing' | 'unknown'> {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(`https://api-testnet.nearblocks.io/v1/txns/${h}`, { headers: { accept: 'application/json' } });
      if (r.status === 429) { await sleep(8000 * (i + 1)); continue; }
      if (!r.ok) { if (r.status === 404) return 'missing'; await sleep(2000); continue; }
      const j: any = await r.json();
      return Array.isArray(j.txns) && j.txns.length > 0 ? 'ok' : 'missing';
    } catch { await sleep(3000); }
  }
  return 'unknown';
}

const hashes = [...cited.keys()];
console.log(`checking ${hashes.length} distinct cited transactions…`);
const results: Array<{ hash: string; status: string; files: string[] }> = [];
for (const [i, h] of hashes.entries()) {
  let s = await exists(h);
  if (s === 'missing') { await sleep(1500); s = await exists(h); } // one retry: the index can lag
  results.push({ hash: h, status: s, files: [...cited.get(h)!] });
  if (s !== 'ok') console.log(`  ${s.toUpperCase()}  ${h}  (${[...cited.get(h)!].join(', ')})`);
  if ((i + 1) % 25 === 0) console.log(`  …${i + 1}/${hashes.length}`);
  await sleep(450);
}
const bad = results.filter((r) => r.status !== 'ok');
writeFileSync('data/evidence-check.json', JSON.stringify({ checkedAt: new Date().toISOString(), source: 'https://api-testnet.nearblocks.io/v1/txns/<hash>', total: results.length, ok: results.length - bad.length, missing: results.filter((r) => r.status === 'missing').length, unknown: results.filter((r) => r.status === 'unknown').length, notOk: bad }, null, 2));
console.log(`\n${results.length - bad.length}/${results.length} cited transactions resolve on public testnet`);
process.exit(bad.length ? 1 : 0);
