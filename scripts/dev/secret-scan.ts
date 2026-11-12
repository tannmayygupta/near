// Secret scan: tracked files AND full git history, plus .gitignore coverage. Never prints a secret (only a redacted preview).
// Run: npx tsx scripts/dev/secret-scan.ts      Exit code 1 if anything is found. Suppress a deliberate fixture with a line containing "secret-scan:allow".
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const B58 = '[1-9A-HJ-NP-Za-km-z]';
const RULES: Array<{ name: string; re: RegExp }> = [
  { name: 'API key "api_" + 40+ chars (NEAR Builders MCP style)', re: /\bapi_[A-Za-z0-9]{40,}\b/ },
  { name: 'API key "sk-" + 20+ chars (NEAR AI Cloud / OpenAI style)', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'OutLayer wallet key "wk_" + 32+ hex', re: /\bwk_[0-9a-f]{32,}\b/ },
  { name: 'NEAR ed25519 SECRET key (base58, 80+ chars)', re: new RegExp(`ed25519:${B58}{80,}`) },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'GitHub token', re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { name: '64-hex value assigned to a secret-like name', re: /(secret|private|seed|token|password|api[_-]?key|\bwk)[A-Za-z_]*["']?\s*[:=]\s*["']?[0-9a-f]{64}\b/i },
  { name: 'secretKey/secret_key field holding an ed25519 key', re: new RegExp(`secret_?key["']?\\s*[:=]\\s*["']ed25519:${B58}{40,}`, 'i') },
];
const ALLOW = 'secret-scan:allow';
const redact = (s: string) => (s.length <= 10 ? '***' : `${s.slice(0, 5)}...(${s.length} chars)`);
const git = (args: string[], max = 1024 * 1024 * 512) => {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: max });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

type Hit = { where: string; rule: string; preview: string };
const hits: Hit[] = [];
const scanLine = (where: string, line: string) => {
  if (line.includes(ALLOW)) return;
  for (const r of RULES) {
    const m = line.match(r.re);
    if (m) hits.push({ where, rule: r.name, preview: redact(m[0]) });
  }
};

// 1) tracked files (working tree content)
const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
let scanned = 0;
for (const f of tracked) {
  try {
    if (statSync(f).size > 3_000_000) continue;
    const buf = readFileSync(f);
    if (buf.includes(0)) continue; // binary
    scanned++;
    buf.toString('utf8').split(/\r?\n/).forEach((l, i) => scanLine(`${f}:${i + 1}`, l));
  } catch { /* deleted/unreadable */ }
}

// 2) tracked files that must never be tracked
const FORBIDDEN = [/^\.env($|\.(?!example$))/, /(^|\/)data\/secret\//, /\.sqlite(-shm|-wal)?$/, /(^|\/)node_modules\//, /(^|\/)\.next\//, /^\.claude\//, /(^|\/)\.env\.local$/, /\.stackdump$/];
for (const f of tracked) if (FORBIDDEN.some((re) => re.test(f))) hits.push({ where: f, rule: 'file must not be tracked', preview: '(file)' });

// 3) full history (added lines of every commit on every ref)
let commits = 0;
{
  const log = git(['log', '--all', '-p', '--no-color', '--no-ext-diff', '--pretty=format:@@COMMIT %h']);
  let commit = '', file = '';
  for (const line of log.split('\n')) {
    if (line.startsWith('@@COMMIT ')) { commit = line.slice(9).trim(); commits++; continue; }
    if (line.startsWith('+++ b/')) { file = line.slice(6); continue; }
    if (line.startsWith('+') && !line.startsWith('+++')) scanLine(`history ${commit}:${file}`, line.slice(1));
  }
}

// 4) .gitignore coverage (git check-ignore on representative paths)
const MUST_IGNORE = ['.env', '.env.local', 'app/.env.local', 'data/secret/x.json', 'data/worker-dev.sqlite', 'data/worker-dev.sqlite-wal', 'data/worker-dev.sqlite-shm', 'app/.next/x', 'node_modules/x', 'app/node_modules/x', '.claude/x', 'contracts/mandate/target/x', 'data/worker-dev.out.log'];
const ignoreRows = MUST_IGNORE.map((p) => ({ p, ok: spawnSync('git', ['check-ignore', '-q', p]).status === 0 }));

const uniq = new Map<string, Hit>();
for (const h of hits) uniq.set(`${h.where}|${h.rule}`, h);
console.log(`scanned ${scanned} tracked text files and ${commits} commits`);
console.log('\n.gitignore coverage:');
for (const r of ignoreRows) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.p}`);
console.log(`\nfindings: ${uniq.size}`);
for (const h of uniq.values()) console.log(`  HIT  ${h.where}  [${h.rule}]  ${h.preview}`);
const bad = uniq.size > 0 || ignoreRows.some((r) => !r.ok);
console.log(bad ? '\nRESULT: FAIL (do not push until fixed; history hits need a history rewrite decision from the user)' : '\nRESULT: PASS');
process.exit(bad ? 1 : 0);
