# Mainnet release audit (Phase 2.5)

> **Superseded in part (final gate, same day):** the DAO factory deposit was investigated against the factory source and live mainnet data, the escalate-to-9-NEAR retry was removed and a balance gate was added. The 17/19 NEAR advice and the "UNVERIFIED" factory deposit below are replaced by `docs/MAINNET-DEPLOYMENT-PLAN.md`.


Nothing in this document was executed on mainnet. Every figure is either computed from the repository's own code, measured on the public testnet rehearsal, or read from public RPC with a read-only call. What could not be verified is marked **UNVERIFIED**.

## 1. Account-by-account funding (from `src/near/setup-plan.ts`, the table `setup.ts` and `preflight` both use)

There are **eight sub-accounts of the owner**, plus the DAO account, plus the vault (a sub-account of the *agent*, not of the owner). Earlier reports grouped them (council 2.8, payees 0.15), which is why the lines looked like seven.

| # | Account (pattern) | Created by | Deposit (NEAR) | Locked as storage | Spendable after setup | Purpose |
|---|---|---|---|---|---|---|
| 1 | `qt-c1.<owner>` | owner | 2.000 | ~0.002 (account + 1 key, estimate) | ~1.998 | council member that proposes: 1 NEAR proposal bond (refunded when the proposal executes) + gas |
| 2 | `qt-c2.<owner>` | owner | 0.400 | ~0.002 | ~0.398 | council member, votes |
| 3 | `qt-c3.<owner>` | owner | 0.400 | ~0.002 | ~0.398 | council member, votes |
| 4 | `qt-agent.<owner>` | owner | 1.900 | ~0.002 | ~1.898, of which 1.5 moves to the vault | the agent; holds the 5-method function-call key (allowance 1 NEAR is a gas ceiling, not a transfer) |
| 5 | `qt-alice.<owner>` | owner | 0.050 | ~0.002 | ~0.048 | payee (also the unprivileged caller of `mainnet:test --auth`) |
| 6 | `qt-bob.<owner>` | owner | 0.050 | ~0.002 | ~0.048 | payee |
| 7 | `qt-fee.<owner>` | owner | 0.050 | ~0.002 | ~0.048 | receives the 0.5% service fee |
| 8 | `qt-mandate.<owner>` | owner | **4.300** | **~3.692** (369,245 bytes x 1e19 yocto) + ~0.002 account + contract state | **~0.60** | the mandate contract |
| 9 | `quietdao-<5 digits>.sputnik-dao.near` | owner, via the factory `create` | **6.000** (a chosen treasury, not a protocol minimum: see MAINNET-DEPLOYMENT-PLAN.md) | factory-managed | becomes the DAO treasury | Sputnik DAO, council = accounts 1-3, 2 of 3 to pass |
| 10 | `vault.qt-agent.<owner>` | **the agent account** | 1.500 | ~0.002 | ~1.498 | key-held vault: receives the 0.6 NEAR budget from the DAO, signs swaps and payouts |

Owner outflow = sub-accounts **9.150** (4.850 + 4.300) + DAO **6.000** = **15.150 NEAR**. Gas measured on the fresh testnet rehearsal: owner balance 19.700 -> 4.478 = 15.222 NEAR, so **gas and fees measured = 0.072 NEAR** (the script's estimate is 0.2).

**Minimum owner balance.** Superseded by `docs/MAINNET-DEPLOYMENT-PLAN.md` section 2: planned transfers 15.150; gate 15.450; script minimum 16; recommended to hold 16.5. The earlier "up to 9 NEAR" escalation was removed, so there is no 18.45 worst case any more. The factory has no minimum deposit (source and live data reviewed); 6 NEAR is a generous treasury choice.

**Expected balances after a successful e2e (estimates).** DAO ~5.4 NEAR + a share of leftover USDC (6.0 - 0.6 sold + any returns; proposal bonds are refunded); council1 ~1.99; council2/3 ~0.39; agent ~0.39; vault ~1.43-1.47 (1.5 float - Ref and token storage registrations of about 0.025 - gas); alice/bob/fee ~0.048 each plus their USDC. The 0.6 NEAR sold becomes USDC paid to alice (50%), bob (20%), the fee account (0.5%) and the DAO (remainder).

## 2. What each test category costs (`mainnet:test`)

| Category | Command | What it does | Signed transactions | Gas and money |
|---|---|---|---|---|
| **A. Read-only view tests** | `npm run mainnet:test` | calls the 7 views plus `contract_source_metadata` over RPC and validates the answers | **none** | free; no key, no `ALLOW_MAINNET` |
| **B. Unauthorised-call rejection tests** | `npm run mainnet:test -- --auth` | 11 **signed** transactions from `qt-alice` (unprivileged), each expected to **fail** inside the contract | **11** | not read-only. Measured on testnet: 0.0126 NEAR for all 11 (about 0.0011 each; 10 Tgas prepaid per call, the unused part refunded). Needs `ALLOW_MAINNET=1`, the payee's key, and the payee to hold at least 0.02 NEAR (the script stops otherwise). State must be identical before and after, and the script checks it, but the transactions are real, are recorded on-chain and cost real gas |
| **C. State-changing functional tests** | **none in `test-contract.ts`** | the only mandate lifecycle test is the e2e below | n/a | see section 3 |

Not described as read-only: category B is signed and paid for even though it is designed to change nothing. Every B call uses arguments the contract would reject by its own validation even if its guard were missing; the one exception is `set_paused(false)`, sent only while unpaused (then it is a no-op even if the guard were missing, and a failure proves the guard). Only that one is **decisive** evidence of its guard; the other ten show "rejected, state unchanged" because the release wasm drops panic text.

## 3. What `mainnet:e2e` does (`scripts/mainnet/e2e-mainnet.ts`), step by step

**Not executed in this audit.** Needs `ALLOW_MAINNET=1`, the files `setup` wrote, and `NEAR_AI_API_KEY`.

1. **Reads (free):** contract code hash must equal the committed wasm; `get_stats` must show the right DAO and agent; the DAO must hold at least 1.5 NEAR; reads the pool 4512 state.
2. **External API calls (not on-chain, may cost NEAR AI credits):** fetches a TEE attestation and runs the intent through NEAR AI Cloud (signed completions). The result is then **overridden by code**: budget capped at `QT_MAX_SELL` (default 0.6 NEAR), window 6 minutes, chunks 0.1-0.2 NEAR, floor 2, fee 0.5%, payouts alice 50% / bob 20%.
3. **DAO proposal 1 (create_mandate):** `council1` `add_proposal` with a **1 NEAR bond** (refunded when the proposal executes); `council1` and `council2` vote; the DAO executes `create_mandate` on the contract: **mandate #0 is created** (`Approved`).
4. **DAO proposal 2 (funding):** `council1` proposes a `Transfer` of the budget (<= 0.6 NEAR) from the DAO to the vault (another 1 NEAR bond, refunded); one vote must **not** fund it (the script asserts that); a second vote executes the transfer. **0.6 NEAR leaves the DAO treasury for the vault.**
5. **Agent (function-call key, 5 methods only):** `mark_funded`, then `record_chunk` once per chunk (at least 2), `begin_settlement`, `complete` (anchors the report hash).
6. **Vault (full-access key on `vault.qt-agent.<owner>`):** one-time registrations (Ref account 0.01 NEAR, token storage 0.00125 NEAR each for wNEAR and USDC), then per chunk `near_deposit` (wrap), `ft_transfer_call` to **Ref pool 4512** (a swap against the public wNEAR/USDC pool), withdraw the output; then USDC payouts to alice, bob, the fee account, the return of leftover USDC and unspent NEAR to the DAO.
7. **Local writes:** `data/demo-run/mainnet-run.json`, `mainnet-proof-bundle.json` and copies in `app/public/demo-run/`; the vault-reserve and Ref ledger files in the secret directory.

**Potential impact on real users.** Every account, the DAO and the contract are created by `setup` for this slice and controlled by the owner, so **no third party's funds, mandates or state are touched**. The one shared surface is the **public Ref pool 4512** (about US$1.3M liquidity): selling at most 0.6 NEAR (about US$2) is a real trade against liquidity providers, moves the price negligibly, and pays the pool's 0.3% fee. The price-band guard fails closed if the reference quote is unavailable. If anything fails after the funding vote the script stops; the DAO can cancel the mandate and the funds remain in accounts the owner controls (vault key in the secret directory).

**Is an isolated production test possible?** Largely it already is: fresh DAO, fresh contract, owner-controlled accounts, hard-capped budget. Two ways to reduce risk further without changing code: (a) **stage it** with `QT_MAX_SELL=0.3` (two chunks of 0.1-0.2 NEAR satisfy the script's "at least 2 chunks" check) before the full 0.6; (b) run `mainnet:verify` and `mainnet:test` (category A and B) **before** the e2e so the contract is proven correct before any money moves through it. What cannot be isolated: the public pool and public RPC. Cancel and red-team paths are **not** exercised on mainnet.

## 4. Reproducible build (done 2026-11-14, on this machine, pinned image)

Recipe: the image `rust:1.99.1-bookworm` (already present locally), the contract sources copied to `D:\qt-build\src` (without `out/` and `target/`), the committed `Cargo.lock` used with `--locked`, `cargo test --release`, `cargo test --release --features migrate`, then `cargo build --locked --target wasm32-unknown-unknown --release`. Build and registry caches were bind-mounted on D:, so no Docker volume and nothing else was created on C:. **The repository's `scripts/build-contract.ps1` was deliberately not used: it copies its result over `contracts/mandate/out/mandate.wasm` and `Cargo.lock`.**

| Item | Value |
|---|---|
| Source revision | contract sources last changed in commit `82d197e`; build copied from working tree at `a44bfbc` (contracts/ clean, no diff) |
| near-sdk | `5.30.1` (resolved from the committed `Cargo.lock`; `Cargo.toml` says `5.9`) |
| Toolchain | rustc 1.99.1 (58cf8f9c3 2026-10-13), cargo 1.99.1, target wasm32-unknown-unknown |
| Profile | `opt-level = "z"`, `lto = true`, `codegen-units = 1`, `panic = "abort"`, `overflow-checks = true`, `debug = false` |
| Rust tests in the same image | **36 passed** (37 with `--features migrate`), 0 failed |
| Rebuilt wasm size | **369,245 bytes** |
| Rebuilt SHA-256 | `ead785fdf541757ee8fc86992d416a1b0ab70d10d01359660dc6fd192a7c1870` |
| NEAR code hash | `Goj1eumfHA866p2MiZEQHHrK9FvFvZ12Ek5LLASdFHV9` |
| Committed wasm | identical: same size, same SHA-256, **byte-for-byte equal**; same code hash as the one recorded on testnet and the one on-chain (`npm run verify:contract`: `match: true`) |

Limits of this result: it shows the build is **deterministic here and equals the committed artifact**; it is not a third-party reproduction on another machine. `build_info` in the NEP-330 metadata is `null`, so someone else cannot yet re-derive the hash from the chain alone (documented in `docs/CONTRACT.md`).

## 5. CI and Git state (checked, nothing pushed)

* HEAD `a44bfbc` (UI redesign) on top of `35de66a` (mainnet hardening), on top of `origin/main` = `bca7fd9`. **Two commits ahead; neither has ever been pushed**, so **no CI run exists for `35de66a`** (the last CI run, success, is for `bca7fd9`). I will not claim CI for `35de66a`.
* Working tree: clean except the untracked `image.png`, which is intentionally never committed (this audit adds `docs/MAINNET-RELEASE-AUDIT.md`, committed locally).
* What CI will run on that commit (`.github/workflows/ci.yml`): `npm ci`, `npm test` (all 396 tests, including the deployment-sequence, secret-dir, preflight, verify and method-inventory tests), `npm run verify`, `npm run secret-scan`; the dashboard static build; Rust `cargo test --release` and `--features migrate` in the same image.
* Local equivalents run today on this tree: 396/396 unit tests; verifier 13+21+16; secret scan 0 findings; the Rust tests in the pinned image (36 and 37) as above; the dashboard typecheck and static export. These are not CI evidence, they are the same commands.

## 6. Remaining security concerns

1. **DAO factory deposit:** resolved in the final gate: the factory has no minimum and refunds a failed creation; the 6 NEAR is a treasury choice (2.5 would do); the escalation logic was removed.
2. **The vault is a key held by the worker** (no OutLayer custody on mainnet): whoever holds that key controls the vault (about 2 NEAR at peak). Bounded by size, not by policy.
3. **The council is the authors**: "2 of 3 votes" is real mechanics but not independent governance. Say so on every mainnet claim.
4. **Contract is upgradable until locked.** Before `mainnet:lock` the owner's key can redeploy it; after the lock nobody can ever change it. Neither state is "safe by itself": decide deliberately and only after the e2e passed.
5. **Plaintext keys on disk.** Every sub-account key and the vault key sit in `QT_SECRET_DIR` unencrypted; Windows does not enforce the 0600 mode. Losing that folder strands the DAO treasury and the vault; leaking it hands them over. Keep it off synced and shared folders and back it up encrypted.
6. **Refusal tests are indirect** (panic text is dropped by the release wasm); only `set_paused` is decisive. The Rust tests never call `list_mandates`. Our own review of the source, **not a formal audit**.
7. **Shared dependencies:** the public Ref pool 4512, public RPC, NEAR AI Cloud (an API key and credits). A price-band guard fails closed if the reference quote is missing.
8. `build-contract.ps1` overwrites the committed wasm: never run it as part of the release.

## 7. Deployment prerequisites (all must hold)

1. The owner's id and full-access key in `.env`, written by you (`QT_FUNDER_ACCOUNT`, `QT_FUNDER_KEY`); a **named** account, preferably `*.near`.
2. `QT_SECRET_DIR` set to a folder outside OneDrive (for example `D:\qt-secrets`), with a plan to back it up.
3. **At least 16.5 NEAR** in the owner account (the script enforces 16).
4. `npm run mainnet:preflight` prints **READY**.
5. The two local commits pushed and **CI green on that exact commit** (needs your approval to push).
6. Your explicit, separate approval of the deployment plan.

## 8. Recommendation

**NOT READY.** The code and the artifact are verified: the rebuilt wasm is identical to the committed one, the Rust and unit suites pass, the atomic deploy is proven on testnet, and the read-only checks work. What is missing is not code: no funder credentials, the secret directory is not yet outside OneDrive, funding is not in place, and there is no CI run for the exact commit. When items 1-5 above are done and you approve item 6, the status becomes READY.
