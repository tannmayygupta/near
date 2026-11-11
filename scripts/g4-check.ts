// Gate G4: live NEAR AI Cloud — signed completion + attestation + local verification + real intent parsing.
// Run: npx tsx --env-file=.env scripts/g4-check.ts   (key is read from env, never printed)
import { NearAiClient, verifySignedCompletion } from '../src/near/ai.js';
import { llmFromClient, parseIntent } from '../src/engine/parser.js';

const ai = new NearAiClient();
const model = await ai.resolveConfidentialModel();
console.log('confidential model:', model);

const { report, nonce } = await ai.fetchAttestation(model);
console.log('attestation nonce echoed + bound:', nonce.slice(0, 12) + '…');

const sc = await ai.signedCompletion({ model, system: 'Reply with exactly one word.', user: 'Say: sealed' });
console.log('completion:', JSON.stringify(sc.content), 'chat', sc.chatId.slice(0, 16) + '…');
const v = verifySignedCompletion(sc, report);
for (const c of v.checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ?? '');
console.log('signature record kind:', sc.signature.signature_kind, 'signer', sc.signature.signing_address);

// real intent parsing through the TEE model
const now = Math.floor(Date.now() / 1000);
const r = await parseIntent(
  'Sell up to 20 NEAR for USDC over the next 3 days, never below 3.5 USDC per NEAR, in chunks of 1 to 3 NEAR every 10 to 30 minutes. Then pay 40% of the proceeds to alice on Solana address 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin and 10% to bob on Base 0x1111111111111111111111111111111111111111.',
  { dao: 'quietdao.example.near', treasurer: 'treasurer.example.near', nowS: now, llm: llmFromClient(ai, model) },
);
console.log('parsed in', r.attempts, 'attempt(s)');
console.log(r.summary.join('\n'));
console.log('warnings:', r.warnings);
