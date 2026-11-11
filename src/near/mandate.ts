// Client for the Mandate contract (contracts/mandate). Shapes mirror lib.rs.
import type { Account } from 'near-api-js';
import { view, TGAS } from './chain.js';

export type OnChainStatus = 'Approved' | 'Funded' | 'Executing' | 'Settling' | 'Completed' | 'Cancelled' | 'Expired';
export interface OnChainMandate {
  id: number;
  treasurer: string;
  terms_hash: string;
  terms_json: string | null;
  sell_token: string;
  max_sell: string;
  start_ns: number;
  end_ns: number;
  tier: 'small' | 'mid' | 'large';
  status: OnChainStatus;
  sold: string;
  chunks: number;
  created_ns: number;
  report_hash: string | null;
  revealed_terms: string | null;
}

export interface CreateArgs {
  treasurer: string;
  terms_hash: string;
  terms_json: string | null;
  sell_token: string;
  max_sell: string;
  start_ns: number;
  end_ns: number;
  tier: 'small' | 'mid' | 'large';
}

export const getMandate = (rpc: string, contract: string, id: number) => view<OnChainMandate | null>(rpc, contract, 'get_mandate', { id });
export const listMandates = (rpc: string, contract: string, from = 0, limit = 50) => view<OnChainMandate[]>(rpc, contract, 'list_mandates', { from, limit });
export const getTrust = (rpc: string, contract: string, treasurer: string) => view<number>(rpc, contract, 'get_trust', { treasurer });

const call = (a: Account, contract: string, methodName: string, args: object) =>
  a.callFunction({ contractId: contract, methodName, args, gas: TGAS(30) });

// agent-only operations
export const markFunded = (agent: Account, c: string, id: number) => call(agent, c, 'mark_funded', { id });
export const recordChunk = (agent: Account, c: string, id: number, index: number, soldAmount: string) => call(agent, c, 'record_chunk', { id, index, sold_amount: soldAmount });
export const beginSettlement = (agent: Account, c: string, id: number) => call(agent, c, 'begin_settlement', { id });
export const complete = (agent: Account, c: string, id: number, reportHash: string, violations: number, revealedTerms: string | null) =>
  call(agent, c, 'complete', { id, report_hash: reportHash, violations, revealed_terms: revealedTerms });
export const expire = (agent: Account, c: string, id: number) => call(agent, c, 'expire', { id });

export const nsFromSeconds = (s: number) => s * 1_000_000_000;
