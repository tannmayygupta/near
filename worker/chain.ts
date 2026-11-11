// Real chain adapter: mandate contract + Sputnik DAO reads, writes signed by the agent account key.
// NOTE: the on-chain `agent` account must be one whose key this process holds. Signing these calls with the OutLayer wallet
// (POST /wallet/v1/call, keys in the enclave) is a documented follow-up (worker/README.md) and is NOT implemented here.
import type { Account } from 'near-api-js';
import { TGAS, view } from '../src/near/chain';
import * as mc from '../src/near/mandate';
import * as sp from '../src/near/sputnik';
import type { ApprovalInfo, ChainPort } from './ports';

export interface RealChainOpts { rpc: string; mandateContract: string; dao: string; agent: Account }

export class RealChain implements ChainPort {
  constructor(private o: RealChainOpts) {}
  listMandates() { return mc.listMandates(this.o.rpc, this.o.mandateContract, 0, 200); }
  getMandate(id: number) { return mc.getMandate(this.o.rpc, this.o.mandateContract, id); }
  getTrust(t: string) { return mc.getTrust(this.o.rpc, this.o.mandateContract, t); }
  async councilSize(): Promise<number> {
    const p = await sp.getPolicy(this.o.rpc, this.o.dao);
    const role = (p.roles ?? []).find((r: any) => r.name === 'council') ?? (p.roles ?? []).find((r: any) => r.kind?.Group);
    return role?.kind?.Group?.length ?? 1;
  }
  /** Finds the DAO proposal that created this mandate: FunctionCall -> mandate.create_mandate with args.terms_hash == m.terms_hash. */
  async findApproval(m: mc.OnChainMandate): Promise<ApprovalInfo | null> {
    const last = await sp.lastProposalId(this.o.rpc, this.o.dao);
    const from = Math.max(0, last - 200);
    const list = await sp.listProposals(this.o.rpc, this.o.dao, from, 200);
    for (const p of list.reverse()) {
      const fc: any = (p.kind as any).FunctionCall;
      if (!fc || fc.receiver_id !== this.o.mandateContract) continue;
      const act = (fc.actions ?? []).find((a: any) => a.method_name === 'create_mandate');
      if (!act) continue;
      let args: any; try { args = JSON.parse(Buffer.from(act.args, 'base64').toString('utf8')); } catch { continue; }
      if (args.terms_hash !== m.terms_hash) continue;
      const approvals = Object.values(p.votes ?? {}).filter((v) => v === 'Approve').length;
      return { proposalId: p.id, status: p.status, approvals };
    }
    return null;
  }
  markFunded(id: number) { return mc.markFunded(this.o.agent, this.o.mandateContract, id); }
  recordChunk(id: number, i: number, a: string) { return mc.recordChunk(this.o.agent, this.o.mandateContract, id, i, a); }
  beginSettlement(id: number) { return mc.beginSettlement(this.o.agent, this.o.mandateContract, id); }
  complete(id: number, h: string, v: number, r: string | null) { return mc.complete(this.o.agent, this.o.mandateContract, id, h, v, r); }
  expire(id: number) { return mc.expire(this.o.agent, this.o.mandateContract, id); }

  /** Red-team only: a REAL create_mandate call from the agent account (must be rejected by the contract: only the DAO may create). */
  attackCreateAsAgent() {
    const now = Date.now() * 1e6;
    return this.o.agent.callFunction({
      contractId: this.o.mandateContract, methodName: 'create_mandate', gas: TGAS(30),
      args: { treasurer: this.o.agent.accountId, terms_hash: 'b'.repeat(64), terms_json: null, sell_token: 'nep141:wrap.near', max_sell: '1', start_ns: now, end_ns: now + 3_600_000_000_000, tier: 'small' },
    });
  }
  /** Red-team only: a REAL record_chunk from the agent beyond the budget / outside the window (must be rejected by the contract). */
  attackRecord(id: number, index: number, amount: string) { return mc.recordChunk(this.o.agent, this.o.mandateContract, id, index, amount); }
  rpc() { return this.o.rpc; }
  viewRaw<T>(c: string, method: string, args: object = {}) { return view<T>(this.o.rpc, c, method, args); }
}
