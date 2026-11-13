# 0003. Our own mandate contract on top of Sputnik DAO

Status: accepted (2026-11-11); amended 2026-11-14

Sputnik DAO v2 already does governance (proposals, roles, votes, funding transfers). It does not know what a mandate is. `contracts/mandate/` (near-sdk 5) adds the state machine: DAO-only create/cancel, agent-only `mark_funded` / `record_chunk` / `begin_settlement` / `complete` / `expire`, a budget and a window enforced on-chain, **idempotent** chunk records (replaying an index is a no-op, skipping ahead panics), a report-hash anchor and a trust score for treasurers.

Rejected: **Sputnik alone** (no on-chain budget or window, no per-chunk accounting). **A vault contract that holds the funds** (more code on the money path, harder to audit in a week; the vault is an OutLayer wallet, ADR 0004). **An off-chain registry** (nothing for the verifier to anchor to).

Honest limit: the contract is a thin registry, not an escrow. Money movement is guarded by the wallet policy and the executor, not by this contract. 21 contract tests (16 unit, 5 property) cover its invariants.

Amended 2026-11-14: events (NEP-297), state versioning, two-step role changes and typed views are known gaps; they need a redeploy and are on the roadmap, not claimed.
