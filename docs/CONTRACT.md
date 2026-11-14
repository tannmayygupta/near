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

---
# Deploying and checking it (added with the mainnet kit)

## Authoritative method inventory
Generated from the source **and** cross-checked against the exports of the compiled wasm: `npm run contract:methods` (add `--markdown` for the table). `tests/contract-methods.test.ts` fails if the source, the wasm and this inventory ever disagree.

**19 public methods in `lib.rs`; the production wasm exports 20 (the SDK adds `contract_source_metadata`, NEP-330); 21 counting `migrate`, which exists only with `--features migrate` and is not in the deployed wasm.** Eleven methods are access-restricted.

| Method | Kind | Changes state | Guard |
|---|---|---|---|
| `new` | init | yes | single-use (near-sdk init: panics if state already exists) |
| `create_mandate`, `cancel_mandate`, `set_agent`, `set_paused`, `propose_dao` | dao (5) | yes | `assert_dao`: predecessor == dao |
| `accept_dao` | proposed-dao | yes | only the account in `pending_dao`, and only while a handover is pending |
| `mark_funded`, `record_chunk`, `begin_settlement`, `complete`, `expire` | agent (5) | yes | `assert_agent`: predecessor == agent |
| `get_mandate`, `list_mandates`, `get_trust`, `get_config`, `get_version`, `is_paused`, `get_stats` | view (7) | no | none |
| `contract_source_metadata` | SDK metadata view | no | none |
| `migrate` | feature-gated | yes | `#[private]`; not in the production wasm |

(An earlier status report of ours said "16 methods": that was a counting error. 1 init + 5 DAO + 1 proposed-DAO + 5 agent + 7 views = 19.)

## Deployment: one atomic transaction
`new` can be called by anyone until it has run once. Deploying in one transaction and initialising in a second would leave a window in which anybody could initialise the contract with their own DAO and agent. `scripts/mainnet/setup.ts` therefore sends **one transaction containing two ordered actions: `DeployContract(wasm)` and `FunctionCall new(dao, agent)`**. NEAR executes those actions in order inside one receipt, so a failed `new` also reverts the deploy: the account ends up with the right code and the right state, or with nothing. Logic and tests: `src/near/deploy-atomic.ts`, `tests/deploy-atomic.test.ts`.

* It decides from the account's **current state**: empty -> deploy+init; same code and initialised for this DAO and agent -> nothing to do; **different code, or someone else's DAO/agent -> stop, never overwrite**.
* **Exactly one attempt, never a blind retry.** If the result is uncertain (timeout) it re-reads the account; it does not send again. Anything unexpected stops the script with the state it found.
* After the transaction it reads the account back and requires: code hash == committed wasm, `version == 2`, `dao` and `agent` as intended.
* The only path that sends `new` alone is "committed wasm present but uninitialised" (left by an older two-step run), verified the same way.

## Check before, check after (all read-only unless stated)
| Command | What it does | Needs a key |
|---|---|---|
| `npm run mainnet:preflight` | RPC and chain id, owner exists, **the key really is a full-access key of that account**, balance vs the cost recomputed from `setup.ts`'s own plan, target accounts free, wasm hash, secret directory and git exposure | reads `.env` (names and shapes only, never printed) |
| `npm run mainnet:verify` | contract exists, **code hash == committed wasm**, initialised, DAO and agent as intended, version, stats, DAO answers `get_policy`, agent key is function-call-only; prints the explorer URL; writes `data/<tag>-verify.json` | no |
| `npm run mainnet:test` | **JavaScript integration test**: all 7 views plus `contract_source_metadata`, shapes and cross-checks validated | no |
| `npm run mainnet:test -- --auth` | adds **authorisation tests**: each of the 11 restricted methods is called by an unprivileged account and must be rejected; state must be identical before and after. Sends 11 transactions that are expected to fail (gas only) | the payee's key; on mainnet also `ALLOW_MAINNET=1` |

`QT_NET=testnet` runs every one of them against the testnet rehearsal contract.

### What the authorisation test can and cannot prove
The release wasm drops the `require!` text (`docs/RUNBOOK.md`), so a refused call shows only `WebAssembly trap: unreachable`; the chain never says **which** check refused it.
* Every call uses arguments the contract would reject by its own validation even if the guard were missing, so a broken guard cannot change production state (`src/near/contract-auth-matrix.ts` states the reason per method).
* Evidence is labelled. **`set_paused(false)` while unpaused is decisive**: with a missing guard it would succeed, so a contract-level failure proves the guard refused it. The other ten are **indirect**: they prove "rejected, state unchanged"; which guard it was rests on the Rust unit tests, which do assert the messages.
* `accept_dao` is refused by the "no handover pending" state check, not the identity check; proving the identity check on a live contract needs a real DAO proposal.
* A failure that did not happen inside the contract (no gas money, dead RPC) is **inconclusive**, never a pass. This happened in our first rehearsal run (the payee ran out of NEAR) and is covered by a test.

### Result on the testnet rehearsal contract (14 Nov 2026)
`qt-mandate.qtr-a-53587.testnet`, same wasm hash as the committed file: **verify 15/15; contract test 21/21** (9 view checks, 11 refusals, state unchanged); the 11 failed calls cost 0.0126 testnet NEAR. Reports: `data/rehearsal-verify.json`, `data/rehearsal-test-report.json` (each refusal has its transaction link). A second, fresh rehearsal proved the atomic deploy+init on-chain with the secret directory on another drive. **These are testnet results; nothing has been deployed to mainnet.**

## Secrets
Account keys go to `data/secret/` (git-ignored) or to the folder named by **`QT_SECRET_DIR`** (for example `D:\qt-secrets`). Files are created owner-only where the OS enforces it (Windows does not enforce POSIX modes: rely on the user-profile ACL). **Mainnet commands refuse to run when the secret directory is inside a cloud-synchronised folder (OneDrive, Dropbox, ...)**; this repository lives under OneDrive, so set `QT_SECRET_DIR` outside it before the first mainnet command. Nothing here prints a key.

## More known limits and recovery
* **The Rust tests never call `list_mandates`** (found by the inventory cross-check; recorded as a known gap in `tests/contract-methods.test.ts`). The live test exercises it.
* **Panic text is lost in the release wasm**, so refusals are opaque on-chain. Fixing it means a rebuild, a new code hash and re-verifying every recorded run; not done.
* **A locked contract is permanent.** `npm run mainnet:lock` deletes every full-access key of the contract account: nobody, including us, can change or delete it afterwards. Before a lock, a bad deploy can be fixed by redeploying (state is kept).
* **Agent key lost while a mandate is `Settling`:** the DAO calls `set_agent`, the new agent completes it. The contract holds no funds, so nothing is stranded.
* A contract upgrade is not an app deploy: it is a deliberate, owner- or DAO-authorised action (v1 -> v2 needs the `migrate` build, see above).
* This is our own review of the source, **not a formal audit**.
