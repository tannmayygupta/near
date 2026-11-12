# ARCHITECTURE - Quiet Treasury

One sentence: a DAO votes once on a bounded **mandate**; an agent executes it in hidden chunks inside that mandate and a wallet policy, and publishes a verifiable report. Source of truth for authority is the chain; source of truth for facts is the signed/anchored report.

## 1. Flow
```
 member types intent
        |
        v
 [NEAR AI Cloud TEE model]  --signed completion + attestation-->  src/near/ai.ts, src/engine/parser.ts
        |  draft JSON (AI proposes; code clamps to BOUNDS, maps tokens, forces dao/treasurer/returnTo,
        |  rejects addresses not in the user's text, repairs <=2 times)            src/engine/schema.ts
        v
 human review/confirm (app /wizard) -> terms_hash = sha256(canonical terms)       src/engine/hash.ts
        |
        v  app builds Sputnik proposals; council signs (wallet-selector) or scripts vote
 [Sputnik DAO v2]  P1 FunctionCall mandate.create(...)    P2 Transfer budget -> agent   src/near/sputnik.ts
        |  2-of-3 votes execute the proposal AS the DAO account
        v
 [Mandate contract (Rust, contracts/mandate)]  Approved -> Funded -> Executing -> Settling -> Completed
        |  (Cancelled / Expired possible)  DAO-only: create, cancel, set_agent ; agent-only: mark_funded,
        |  record_chunk (idempotent, <= budget, inside window), begin_settlement, complete(report_hash), expire
        v
 [Worker (worker/)]  poll chain -> verify terms hash + DAO approval + approval tier + trust -> detect funding
        |   loop: planner (randomized size/time) -> swap quote -> PRICE FLOOR -> swap (idempotency key)
        |         -> poll to terminal -> record_chunk ON CHAIN after success
        |   settle: payouts -> fee -> sweep leftovers to returnTo -> report -> NEAR AI signed summary
        |         -> complete(report_hash) anchors it
        v                      two execution adapters behind worker/ports.ts (OutLayerPort):
 [OutLayer agent wallet]        live  : src/near/outlayer.ts   (confidential swap/withdraw; keys in Intel TDX via NEAR MPC)
                                sim   : worker/adapters/simulated-outlayer.ts (testnet; fills priced from real 1Click dry quotes,
                                        request ids `sim-*`, source tag `simulated`)
 [OutLayer wallet policy]       Layer A: per-tx cap, address whitelist ... set by an owner key (src/near/outlayer-policy.ts)
        |
        v
 [Dashboard (app/, Next.js)]  /  /wizard  /votes  /live  /copycat  /redteam  /report  /verify  /ledger
 [Verifier (src/verify)]       nonce echo, EIP-191 signature recovery, signer attested, report hash, price floor, anchor
```

## 2. Components
| Component | Path | Role |
|---|---|---|
| Mandate schema + bounds | `src/engine/schema.ts` | zod terms, hard bounds (duration, chunks, fee, payouts, allowed tokens), legal state transitions (mirrored in Rust) |
| Intent parser | `src/engine/parser.ts` | prompt-injection-safe drafting; output is only a proposal |
| NEAR AI client | `src/near/ai.ts` | confidential-model-only, exact request/response bytes, attestation (no key), signature fetch + local verification |
| Planner / settlement / benchmark | `src/engine/{planner,settlement,benchmark}.ts` | chunk sizes/timing, floor math, report + CSV, source tags (`chain`/`api`/`recorded`/`simulated`) |
| Chain helpers | `src/near/{chain,sputnik,mandate}.ts` | thin near-api-js wrappers, proposals/votes, contract views and calls |
| OutLayer clients | `src/near/{outlayer,outlayer-policy,intents}.ts` | wallet API, programmatic policy, 1Click dry quotes |
| Mandate contract | `contracts/mandate/src/lib.rs` | on-chain authority + budget/window enforcement + trust score; 16 unit tests; built in Docker |
| Worker | `worker/{executor,guards,state,api,redteam,summarizer,index}.ts` | state machine, guards (layer B), sqlite state (`node:sqlite`), read-only API, real red-team attacks |
| Dashboard | `app/` | all views read chain/worker/recorded data; every number carries a source tag; no mocked values |
| Verifier | `src/verify/` | independent checks of a proof bundle |

## 3. Data sources and tags
`chain` (NEAR RPC) | `api` (worker API, 1Click dry quotes) | `recorded` (committed real run in `data/demo-run`, `app/public/demo-run`) | `simulated` (testnet execution adapter; NOT a trade). The dashboard never shows a number without a tag and shows an explicit empty/error state when a source is down.

## 4. Networks
| Piece | Local sandbox | Public testnet | Mainnet |
|---|---|---|---|
| Sputnik DAO, Mandate contract, proposals, votes | yes (Docker) | **yes (recorded run)** | not deployed |
| NEAR AI Cloud (parse, signed summary, attestation) | - | yes (mainnet API, credits) | same |
| OutLayer wallet + policy (Layer A) | - | **yes** (native transfers) | not run |
| Swaps / confidential swaps / cross-chain payouts | stand-in (test only) | **simulated** | implemented, never run with money |

## 5. Trust boundaries (also in the README)
- The worker is **not** in a TEE: it sees the mandates it executes. It cannot exceed the DAO-approved mandate (contract) or the wallet policy (OutLayer), but a malicious worker could refuse to act.
- Keys for live trading sit in OutLayer's TDX enclave (MPC-derived). OutLayer's team currently holds governance keys.
- AI parsing/summaries run in NEAR AI's TEE; the verifier checks nonce binding, signature recovery and that the signer is listed in the attestation report. The Intel TDX quote itself is NOT verified locally.
- Defuse/1Click solvers see swap details before execution; the private shard has no public RPC but its operator can read it; the DAO funding transfer is public.
- Wallet-policy owner is a single account in v0 (production: the DAO). Demo council members are accounts controlled by the authors.
- Two cage layers: **A** = OutLayer wallet policy (inside the enclave; real 403 `policy_denied`), **B** = worker guards + mandate contract. The red-team page labels which layer blocked each attack.

## 6. Decisions worth knowing
- Authority is on-chain (DAO-only creation), not in server config; the worker re-verifies `terms_hash` before acting.
- `record_chunk` is idempotent and strictly ordered; chunks are recorded only after the swap succeeded.
- Sealed mandates store only `terms_hash` (commit with salt) on chain; terms are revealed in the report (`complete(..., revealed_terms)`).
- Release wasm traps with a generic `unreachable` for `require!` failures (known cosmetic issue).
