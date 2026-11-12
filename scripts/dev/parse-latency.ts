// Time the REAL intent parser (testnet token profile) on each fast confidential model. Run: NEAR_NETWORK=testnet npx tsx --env-file=.env scripts/dev/parse-latency.ts
import { NearAiClient } from '../../src/near/ai.js';
import { llmFromClient, parseIntent } from '../../src/engine/parser.js';
const ai = new NearAiClient();
const intent = 'Sell up to 0.4 NEAR for USDT.e over the next 8 minutes, never below 2 USDT.e per NEAR, in chunks of 0.05 to 0.1 NEAR every 5 to 8 seconds. Pay 50% of the proceeds to alice at qtcontrib-68669.testnet and 20% to bob at qttreasurer-83872.testnet, both on near. Take a 0.5% service fee paid to qtfund-83872.testnet.';
for (const model of (process.argv[2] ? [process.argv[2]] : ['Qwen/Qwen3.8-27B', 'Qwen/Qwen3.6-35B-A3B-FP8', 'z-ai/glm-5.3-flash'])) {
  const t0 = Date.now();
  try {
    const r = await parseIntent(intent, { dao: 'quietdao-83872.sputnikv2.testnet', treasurer: 'qttreasurer-83872.testnet', nowS: Math.floor(Date.now() / 1000), llm: llmFromClient(ai, model) });
    console.log(model, `${((Date.now() - t0) / 1000).toFixed(1)}s`, 'attempts', r.attempts, '|', r.terms.sellToken, '->', r.terms.buyToken, '| payouts', r.terms.payouts.length, 'fee', r.terms.feeBps);
  } catch (e: any) {
    console.log(model, `${((Date.now() - t0) / 1000).toFixed(1)}s ERR`, String(e.message).slice(0, 160));
  }
}
