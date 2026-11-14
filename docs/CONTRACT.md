# Mandate contract v2

`contracts/mandate/` (near-sdk 5.30, Rust 1.99.1 pinned): the on-chain source of truth for mandates. Deployed on public testnet as `qtmandate2-83872.testnet` (v1, `qtmandate-83872.testnet`, stays on chain; its recorded runs are tagged `v1-recorded-runs` in git). The code hash on chain equals the committed `contracts/mandate/out/mandate.wasm` (`npm run verify:contract`, `data/testnet-deploy-v2.json`).

## Access model
| Role | Account | May call |
|---|---|---|
| DAO | a Sputnik DAO (a FunctionCall proposal executes *as* the DAO, so "DAO-only" means "a vote approved it") | `create_mandate`, `cancel_mandate`, `set_agent`, `set_paused`, `propose_dao` |
| Proposed DAO | the account named in `propose_dao` | `accept_dao` (two-step handover; nothing changes until it calls) |
| Agent | the worker's account, driven by a NEAR **function-call key** limited to exactly these five methods | `mark_funded`, `record_chunk`, `begin_settlement`, `complete`, `expire` |
| Anyone | | the views below |

The DAO and the agent must be different accounts (`new`, `set_agent`, `propose_dao` enforce it).

## State machine
`Approved -> Funded -> Executing -> Settling -> Completed`, with `Cancelled` and `Expired` exits. `record_chunk` is **idempotent** (replaying an index is a no-op; skipping ahead panics), enforces the budget (`sold <= max_sell`) and the time window, and only works while Funded/Executing. `complete` anchors the report hash (64 hex chars) and, only with zero violations, raises the treasurer's trust score.

## v2 additions
* **NEP-297 events** (standard `quiet_treasury`, version `1.0.0`) for every state change: `mandate_created`, `mandate_funded`, `chunk_recorded`, `settlement_begun`, `mandate_completed`, `mandate_cancelled`, `mandate_expired`, `agent_changed`, `paused_changed`, `dao_proposed`, `dao_changed`. A mandate's whole history can be rebuilt from logs (`parseMandateEvents` in `src/near/mandate.ts`; the in-browser recompute reads them). **Sealed mandates log only the commitment** (`sealed: true`, `terms_hash`): never terms, recipients or the floor; a unit test asserts that revealed terms never appear in any log.
* **Versioned state + `migrate`.** `version` is stored; a feature-gated `migrate` upgrades v1 state (build with `--features migrate`, deploy, call `migrate`, redeploy the normal build). A test writes a v1 state, migrates it and checks every mandate and trust score survived.
* **Pause.** `set_paused(true)` (DAO only) stops *new* mandates. Funding, trading, settlement and cancel keep working, so a pause can never trap a running mandate (tested).
* **Two-step DAO handover** and role-separation checks.
* **Typed views:** `get_stats` (version, paused, dao, agent, pending DAO, counts per status, chunks recorded, treasurers with trust), `get_version`, `is_paused`; `get_config` keeps its v1 tuple shape for the existing clients.
* **NEP-330 source metadata:** `contract_source_metadata` returns version `2.0.0`, the repo link and the standard.

## Tests
36 in CI: 31 unit tests and 5 property tests (budget and chunk accounting under random sequences, replay idempotency, no chunk outside the window, only the right accounts can act, trust equals clean completions); 37 with `--features migrate`. Run: `powershell scripts/build-contract.ps1` (Docker) or `cargo test --release` in `contracts/mandate`.

## Honest limits
* It is a **registry**, not an escrow: it does not hold funds. Token movement is bounded by the OutLayer wallet policy, the executor guards and the price floor (ADR 0003, 0005).
* `build_info` in the NEP-330 metadata is `null`: the wasm is built with a pinned Docker image and locked dependencies (`scripts/build-contract.ps1`) and the deployed code hash is checked against it, but it was not produced by `cargo near build reproducible-wasm`, so a third party cannot yet re-derive the hash from the metadata alone.
* No near-workspaces sandbox tests yet (unit and property tests only).
* The contract account holds a full-access key (testnet): a production deployment would delete it after the final deploy or gate upgrades behind the DAO.