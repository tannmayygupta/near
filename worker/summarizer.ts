// AI settlement summary written by a NEAR AI Cloud CONFIDENTIAL TEE model and signed (EIP-191 over sha256(request):sha256(response)).
// The signed completion is kept so anyone can re-verify it (src/verify). The summary may only use numbers present in the report JSON.
import { NearAiClient, SignedCompletion } from '../src/near/ai';
import type { Summarizer } from './ports';

export const SUMMARY_SYSTEM = `You write a factual 3-sentence summary of a DAO treasury settlement report given as JSON.
Rules: use ONLY numbers present in the JSON; do not give investment advice; if any fill, payout or leftover has source "simulated", say plainly that those figures come from a simulated testnet execution and are not real trades; mention any violations. Reply with the summary text only.`;

export function createSummarizer(ai: NearAiClient, onCompletion?: (c: SignedCompletion) => void, model?: string): Summarizer {
  return async (report) => {
    const c = await ai.signedCompletion({ model, system: SUMMARY_SYSTEM, user: JSON.stringify(report), maxTokens: 400 });
    onCompletion?.(c);
    return { text: c.content.trim(), chatId: c.chatId, requestHash: c.requestHash, responseHash: c.responseHash, signer: c.signature.signing_address };
  };
}
