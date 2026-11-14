// Prints the authoritative public-method inventory of the mandate contract, derived from contracts/mandate/src/lib.rs AND from the exports of the compiled wasm.
// Exit 1 if the source and the wasm disagree. Run: npm run contract:methods   (add --markdown to print the table used in docs/CONTRACT.md)
import { readFileSync } from 'node:fs';
import { inventory } from '../../src/near/contract-methods.js';

const inv = inventory(readFileSync('contracts/mandate/src/lib.rs', 'utf8'), readFileSync('contracts/mandate/out/mandate.wasm'));
if (process.argv.includes('--markdown')) {
  console.log('| Method | Kind | Changes state | Guard |\n|---|---|---|---|');
  for (const m of inv.methods) console.log(`| \`${m.name}\` | ${m.kind} | ${m.mutates ? 'yes' : 'no'} | ${m.guard ?? ''} |`);
} else {
  console.log(JSON.stringify({ counts: inv.counts, restricted: inv.restricted, wasmExports: inv.wasmExports, missingInWasm: inv.missingInWasm, unexpectedInWasm: inv.unexpectedInWasm }, null, 2));
}
process.exit(inv.missingInWasm.length || inv.unexpectedInWasm.length ? 1 : 0);
