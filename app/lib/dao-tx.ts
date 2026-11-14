// Pure builders for every Sputnik DAO transaction the dashboard asks a wallet to sign (wizard: add_proposal, votes: act_proposal).
// No React, no network, no near-api-js and only relative imports, so the SAME functions run in the browser and in the unit test
// tests/wallet-parity.test.ts, which compares them with what the tested scripts send (src/near/sputnik.ts, scripts/testnet/lib.ts,
// scripts/testnet/dao-flow.ts, scripts/testnet/e2e-real.ts). The values below are the ones those scripts use on public testnet:
//   add_proposal  30 TGas, deposit = the DAO policy's proposal_bond (read at signing time, never hard-coded)
//   act_proposal  150 TGas, deposit 0, the proposal kind echoed back
//   create_mandate inner action  60 TGas, deposit 0
// If you change a number here, change it in the scripts too (and re-run them): the test fails when they drift apart.

/** A single-action function-call transaction in the shape components/wallet.tsx `call(receiverId, fc)` takes. */
export type DaoTx = { receiverId: string; methodName: string; args: object; gas: string; deposit: string };
export type Tier = 'small' | 'mid' | 'large';
export type VoteAction = 'VoteApprove' | 'VoteReject' | 'VoteRemove' | 'Finalize';
/** What Sputnik's `add_proposal` takes as its argument. */
export type ProposalBody = { proposal: { description: string; kind: object } };

export const tgas = (n: number): string => (BigInt(n) * 10n ** 12n).toString();
export const ADD_PROPOSAL_GAS = tgas(30);
export const ACT_PROPOSAL_GAS = tgas(150);
export const PROPOSAL_ACTION_GAS = tgas(60);

/** UTF-8 safe base64 of a string (identical to Buffer.from(s).toString('base64') in Node). */
export function b64(s: string): string {
  let bin = '';
  for (const byte of new TextEncoder().encode(s)) bin += String.fromCharCode(byte);
  return btoa(bin);
}

/** Same JSON and key order as `functionCallKind` in src/near/sputnik.ts. */
export const functionCallKind = (receiverId: string, methodName: string, args: object, deposit = '0', gas = PROPOSAL_ACTION_GAS) => ({
  FunctionCall: { receiver_id: receiverId, actions: [{ method_name: methodName, args: b64(JSON.stringify(args)), deposit, gas }] },
});

/** Same as `transferKind` in src/near/sputnik.ts. `msg` set => ft_transfer_call (mainnet Intents path, UNVERIFIED). */
export const transferKind = (tokenId: string, receiverId: string, amount: string, msg?: string) => ({
  Transfer: { token_id: tokenId, receiver_id: receiverId, amount, ...(msg !== undefined ? { msg } : {}) },
});

export interface MandateChainTerms { treasurer: string; sellToken: string; maxSellAmount: string; startTs: number; endTs: number }

/** Arguments of the mandate contract's `create_mandate` (same fields and order as `createArgs` in scripts/testnet/e2e-*.ts).
 *  `termsJson` is null for a sealed mandate: only the commitment (`termsHash`) and the budget go on chain. */
export function createMandateArgs(t: MandateChainTerms, termsHash: string, termsJson: string | null, tier: Tier) {
  return {
    treasurer: t.treasurer, terms_hash: termsHash, terms_json: termsJson, sell_token: t.sellToken,
    max_sell: t.maxSellAmount, start_ns: t.startTs * 1_000_000_000, end_ns: t.endTs * 1_000_000_000, tier,
  };
}

export const createMandateProposal = (mandateContract: string, description: string, args: ReturnType<typeof createMandateArgs>): ProposalBody =>
  ({ proposal: { description, kind: functionCallKind(mandateContract, 'create_mandate', args) } });

/** REAL on testnet: native NEAR from the DAO treasury to the vault (token_id ''), exactly the Transfer proposal the e2e scripts make. */
export const fundVaultProposal = (description: string, vault: string, amount: string): ProposalBody =>
  ({ proposal: { description, kind: transferKind('', vault, amount) } });

/** The DAO's proposal bond in yoctoNEAR, read from `get_policy`, the way the scripts read it (`BigInt(policy.proposal_bond ?? '0')`).
 *  Throws on anything that is not a non-negative integer string, so a malformed policy never becomes a guessed deposit. */
export function proposalBondOf(policy: unknown): string {
  const raw = (policy as { proposal_bond?: unknown } | null)?.proposal_bond ?? '0';
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new Error(`DAO policy has no usable proposal_bond (got ${JSON.stringify(raw)})`);
  return BigInt(raw).toString();
}

/** `add_proposal` on the DAO: the proposal bond is attached as the deposit (Sputnik refuses a smaller one). */
export const addProposalTx = (dao: string, body: ProposalBody, bond: string): DaoTx =>
  ({ receiverId: dao, methodName: 'add_proposal', args: { proposal: { description: body.proposal.description, kind: body.proposal.kind } }, gas: ADD_PROPOSAL_GAS, deposit: bond });

/** `act_proposal` on the DAO: this Sputnik version needs the proposal kind echoed back (it guards against proposal-id races). */
export const actProposalTx = (dao: string, id: number, action: VoteAction, kind: unknown): DaoTx =>
  ({ receiverId: dao, methodName: 'act_proposal', args: { id, action, proposal: kind }, gas: ACT_PROPOSAL_GAS, deposit: '0' });
