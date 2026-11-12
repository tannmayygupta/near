// Latency probe: how long does each CONFIDENTIAL TEE model on NEAR AI Cloud take for a small JSON task? (key from env, never printed)
import { NearAiClient, isConfidentialModel } from '../../src/near/ai.js';
const ai = new NearAiClient();
const models = (await ai.listModels()).filter(isConfidentialModel).map((m) => m.modelId).filter((m) => /glm|deepseek|qwen3\.8|qwen3\.6/i.test(m) && !/abliterated|embedding|rerank|vl|whisper|flux|privacy/i.test(m));
console.log('candidates:', models.join(', '));
for (const model of models) {
  const t0 = Date.now();
  try {
    const r = await ai.signedCompletion({ model, system: 'Reply with ONE JSON object only, no prose.', user: 'Return {"sell":"NEAR","buy":"USDT.e","amount":0.4,"floor":2}', maxTokens: 800 });
    console.log(model, `${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(r.content).slice(0, 80));
  } catch (e: any) {
    console.log(model, `${((Date.now() - t0) / 1000).toFixed(1)}s ERR`, String(e.message).slice(0, 100));
  }
}
