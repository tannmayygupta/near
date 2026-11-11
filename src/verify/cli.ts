// usage: npx tsx src/verify/cli.ts <proof-bundle.json>   (exit code 1 if any check fails)
import { readFileSync } from 'node:fs';
import { verifyBundle, ProofBundle } from './index';

const file = process.argv[2];
if (!file) { console.error('usage: npx tsx src/verify/cli.ts <proof-bundle.json>'); process.exit(2); }
const bundle = JSON.parse(readFileSync(file, 'utf8')) as ProofBundle;
const { ok, checks } = verifyBundle(bundle);
const G = '\x1b[32m', R = '\x1b[31m', X = '\x1b[0m';
for (const c of checks) console.log(`${c.ok ? G + 'PASS' : R + 'FAIL'}${X}  ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`);
console.log(ok ? `${G}ALL ${checks.length} CHECKS PASSED${X}` : `${R}VERIFICATION FAILED${X}`);
process.exit(ok ? 0 : 1);
