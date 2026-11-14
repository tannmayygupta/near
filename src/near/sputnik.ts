// Sputnik DAO v2 helpers: build proposals, vote, read state. Works on any network (pass rpcUrl / Account).
import type { Account } from 'near-api-js';
import { view, b64, TGAS } from './chain.js';

export type VoteAction = 'VoteApprove' | 'VoteReject' | 'VoteRemove' | 'Finalize';
export type ProposalStatus = 'InProgress' | 'Approved' | 'Rejected' | 'Removed' | 'Expired' | 'Moved' | 'Failed';

export interface Proposal {
  id: number;
  proposer: string;
  description: string;
  kind: Record<string, unknown>;
  status: ProposalStatus;
  vote_counts: Record<string, [number, number, number]>;
  votes: Record<string, string>;
  submission_time: string;
}

export const functionCallKind = (receiverId: string, methodName: string, args: object, deposit = '0', gas = TGAS(60).toString()) => ({
  FunctionCall: { receiver_id: receiverId, actions: [{ method_name: methodName, args: b64(args), deposit, gas }] },
});

/** Transfer from the DAO treasury. `msg` set => ft_transfer_call (used to credit an agent's Intents balance; format verified in gate G3). */
export const transferKind = (tokenId: string, receiverId: string, amount: string, msg?: string) => ({
  Transfer: { token_id: tokenId, receiver_id: receiverId, amount, ...(msg !== undefined ? { msg } : {}) },
});

export async function getPolicy(rpc: string, dao: string): Promise<any> {
  return view(rpc, dao, 'get_policy');
}

export async function addProposal(rpc: string, who: Account, dao: string, description: string, kind: object): Promise<number> {
  const policy = await getPolicy(rpc, dao);
  const bond = BigInt(policy.proposal_bond ?? '0');
  const id = await who.callFunction({
    contractId: dao,
    methodName: 'add_proposal',
    args: { proposal: { description, kind } },
    gas: TGAS(30),
    deposit: bond,
  });
  return Number(id);
}

export async function vote(rpc: string, who: Account, dao: string, id: number, action: VoteAction): Promise<void> {
  // this Sputnik version requires the proposal kind to be echoed back (guards against proposal-id races)
  const p = await getProposal(rpc, dao, id);
  await who.callFunction({ contractId: dao, methodName: 'act_proposal', args: { id, action, proposal: p.kind }, gas: TGAS(150) });
}

export const getProposal = (rpc: string, dao: string, id: number) => view<Proposal>(rpc, dao, 'get_proposal', { id });
export const listProposals = (rpc: string, dao: string, fromIndex = 0, limit = 50) =>
  view<Proposal[]>(rpc, dao, 'get_proposals', { from_index: fromIndex, limit });
export const lastProposalId = (rpc: string, dao: string) => view<number>(rpc, dao, 'get_last_proposal_id');

