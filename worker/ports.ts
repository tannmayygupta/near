// Dependency ports for the executor. OutLayerClient and the real chain adapter satisfy these; tests inject fakes.
import type { ActionResponse, QuotePreview, RequestRecord, TerminalStatus } from '../src/near/outlayer';
import type { OnChainMandate } from '../src/near/mandate';
import type { PriceSample } from '../src/engine/benchmark';
import type { MandateTerms } from '../src/engine/schema';

export interface OutLayerPort {
  intentsBalance(token: string): Promise<{ balance: string }>;
  confidentialBalance(token?: string): Promise<{ balance?: string; balances?: Array<{ token: string; balance: string }> }>;
  confidentialShield(b: { token: string; amount: string }, idem: string): Promise<ActionResponse>;
  confidentialSwapQuote(b: { token_in: string; token_out: string; amount_in: string }): Promise<QuotePreview>;
  confidentialSwap(b: { token_in: string; token_out: string; amount_in: string; min_amount_out?: string }, idem: string): Promise<ActionResponse>;
  confidentialWithdraw(b: { chain: string; to: string; amount: string; token: string }, idem: string): Promise<ActionResponse>;
  request(id: string): Promise<RequestRecord>;
  waitForRequest(id: string, o?: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<RequestRecord & { status: TerminalStatus }>;
}

export interface ApprovalInfo { proposalId: number; status: string; approvals: number }
export interface ChainPort {
  listMandates(): Promise<OnChainMandate[]>;
  getMandate(id: number): Promise<OnChainMandate | null>;
  getTrust(treasurer: string): Promise<number>;
  councilSize(): Promise<number>;
  findApproval(m: OnChainMandate): Promise<ApprovalInfo | null>;
  markFunded(id: number): Promise<unknown>;
  recordChunk(id: number, index: number, soldAmount: string): Promise<unknown>;
  beginSettlement(id: number): Promise<unknown>;
  complete(id: number, reportHash: string, violations: number, revealedTerms: string | null): Promise<unknown>;
  expire(id: number): Promise<unknown>;
}

export interface Clock { nowS(): number; sleep(ms: number): Promise<void> }
export type Benchmark = (terms: MandateTerms, nowS: number) => Promise<PriceSample | null>;
export type Summarizer = (reportJson: unknown) => Promise<{ text: string; chatId: string; requestHash: string; responseHash: string; signer: string } | undefined>;
export type Logger = (kind: string, fields: Record<string, unknown>) => void;
