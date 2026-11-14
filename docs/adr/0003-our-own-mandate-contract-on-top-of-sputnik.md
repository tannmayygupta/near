# 0003. Our own mandate contract on top of Sputnik DAO

Status: accepted (2026-11-11); amended 2026-11-14

Sputnik DAO v2 already does governance (proposals, roles, votes, funding transfers). It does not know what a mandate is. `contracts/mandate/` (near-sdk 5) adds the state machine: DAO-only create/cancel, agent-only `mark_funded` / `record_chunk` / `begin_settlement` / `complete` / `expire`, a budget and a window enforced on-chain, **idempotent** chunk records (replaying an index is a no-op, skipping ahead panics), a report-hash anchor and a trust score for treasurers.

Rejected: **Sputnik alone** (no on-chain budget or window, no per-chunk accounting). **A vault contract that holds the funds** (more code on the money path, harder to audit in a week; the vault is an OutLayer wallet, ADR 0004). **An off-chain registry** (nothing for the verifier to anchor to).

Honest limit: the contract is a thin registry, not an escrow. Money movement is guarded by the wallet policy and the executor, not by this contract. 36 contract tests (31 unit, 5 property; 37 with the migration feature) cover its invariants.

Amended 2026-11-14: the same day we listed events (NEP-297), state versioning, two-step role changes and typed views as gaps, we closed them in **v2** (`qtmandate2-83872.testnet`, see `docs/CONTRACT.md`): NEP-297 events with a stable `quiet_treasury` standard, a `STATE_VERSION` with a feature-gated `migrate()` from v1, `set_paused` (blocks new mandates, never blocks the agent finishing or the DAO cancelling), `propose_dao` / `accept_dao`, `get_stats`, and `dao != agent` enforced in `new`. We **redeployed to a fresh account instead of upgrading v1 in place**: v1's recordings predate the price-sanity fix, so keeping them next to v2 would have mixed two generations of evidence; the v1 account stays on chain and its runs are tagged `v1-recorded-runs` in git. Still not done: near-workspaces sandbox tests and a `cargo near build reproducible-wasm` build (the wasm is built in a pinned Docker image, and `npm run verify:contract` proves the deployed hash equals the committed file, not that the file is reproducible from source by a third party).
