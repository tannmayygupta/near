// AI settlement summary written by a NEAR AI Cloud CONFIDENTIAL TEE model and signed (EIP-191 over sha256(request):sha256(response)).
// The signed completion is kept so anyone can re-verify it (src/verify). The summary may only use numbers present in the report JSON.
import { NearAiClient, SignedCompletion } from '../src/near/ai';
import type { Summarizer } from './ports';

export const SUMMARY_SYSTEM = `You write a factual 3-sentence summary of a DAO treasury settlement report given as JSON.
Rules: use ONLY numbers present in the JSON; do not give investment advice; if any fill, payout or leftover has source "simulated", say plainly that those figures come from a simulated testnet execution and are not real trades; mention any violations. Reply with the summary text only.`;

export function createSummarizer(ai: NearAiClient, onCompletion?: (c: SignedCompletion) => void, model?: string): Summarizer {
  return async (report) => {
    const c = await ai.signedCompletion({ model, system: SUMMARY_SYSTEM, user: JSON.stringify(compact(report)), maxTokens: 1500 });
    onCompletion?.(c);
    return { text: c.content.trim(), chatId: c.chatId, requestHash: c.requestHash, responseHash: c.responseHash, signer: c.signature.signing_address };
  };
}

/** Only the facts the summary needs (keeps the signed request small and the model focused). */
function compact(r: any) {
  return {
    mandateId: r.mandateId, totals: r.totals, floorRespected: r.floorRespected,
    fills: { count: r.fills?.length ?? 0, sources: [...new Set((r.fills ?? []).map((f: any) => f.source))] },
    payouts: (r.payouts ?? []).map((p: any) => ({ label: p.label, chain: p.chain, amount: p.amount, status: p.status, source: p.source })),
    leftovers: (r.leftovers ?? []).map((l: any) => ({ token: l.token, amount: l.amount, returnedTo: l.returnedTo, source: l.source })),
    violations: r.violations ?? [],
  };
}
