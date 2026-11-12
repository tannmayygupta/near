# CLAIMS vs EVIDENCE (updated as work lands; anything without evidence is deleted before submission)

Legend: **VERIFIED-TESTNET** = reproduced on PUBLIC NEAR testnet by a command in this repo (explorer links in `data/demo-run/run.json`) | VERIFIED = reproduced by a command/test here | LOCAL = local sandbox only | **SIMULATED** = produced by the testnet execution adapter, NOT a real trade | UNVERIFIED = not proven live

## What is real vs simulated in the public-testnet run (`npx tsx --env-file=.env scripts/testnet/e2e.ts`, 20/20)
| Part | Status |
|---|---|
| NEAR AI Cloud TEE parses plain English into a bounds-checked mandate; completions signed; attestation fetched with a fresh nonce | REAL (VERIFIED) |
| Sputnik DAO v2 proposals + votes (2 of 3) create the mandate; DAO cancel proposal stops it | REAL (VERIFIED-TESTNET) |
| Mandate contract state machine, budget/window enforcement, idempotent chunk records, report-hash anchoring, trust score | REAL (VERIFIED-TESTNET) |
| OutLayer testnet wallet policy (Layer A) set programmatically; 403 `policy_denied` for unlisted address and over-cap transfer | REAL (VERIFIED-TESTNET, native NEAR transfers; see G13) |
| Prices/benchmark | REAL read-only 1Click dry quotes (`api`) |
| Swap fills, payouts, leftover sweep | **SIMULATED** (`sim-*` request ids, source tag `simulated`) |
| DAO funding transfer credits the agent's Intents balance | **SIMULATED stand-in** (mainnet-only, unproven) |

## Claims table
| Claim | Status | Evidence |
|---|---|---|
| Real Sputnik DAO votes create/cancel mandates; 1 of 3 votes does nothing, 2 of 3 executes | VERIFIED-TESTNET (also LOCAL) | `scripts/testnet/dao-flow.ts` (8/8, tx hashes printed); `scripts/sandbox/dao-flow.ts` (9/9) |
| Non-DAO callers cannot create mandates; agent cannot exceed budget or act after cancel | VERIFIED-TESTNET | same + 16 contract unit tests. NOTE: the release wasm reports a generic `unreachable` trap, not the require! message |
| Whole flow: AI parse -> DAO vote -> worker chunks -> payouts/sweep -> signed summary -> anchored report -> verifier; second mandate cancelled mid-run | VERIFIED-TESTNET with SIMULATED fills | `scripts/testnet/e2e.ts` 20/20; `data/demo-run/run.json`; `data/demo-run/proof-bundle.json` |
| Independent verifier passes (nonce echo, EIP-191 signature recovery, signer attested, report hash, price floor, no violations) | VERIFIED | `npx tsx src/verify/cli.ts data/demo-run/proof-bundle.json` -> 13/13 |
| NEAR AI signed responses verify end to end | VERIFIED (live key, 2026-11-12) | `scripts/g4-check.ts`, e2e. The Intel TDX quote itself is NOT verified locally (nonce binding + attested-signer listing only; gate U5) |
| **G13: an OutLayer wallet policy CAN be set programmatically** by an owner NEAR key (encrypt-policy -> sign-policy -> `store_wallet_policy` on `outlayer.testnet`) | VERIFIED-TESTNET | `src/near/outlayer-policy.ts`, `scripts/testnet/layer-a.ts`, `data/testnet-layer-a.json` |
| Layer A blocks attacks for real: unlisted destination and over-cap transfer return 403 `policy_denied` | VERIFIED-TESTNET (native NEAR transfers through the same policy engine) | `data/testnet-layer-a.json`, red-team `unlisted_payout` + `over_cap` in `data/demo-run/run.json` |
| Layer B blocks the other attacks (executor guards + mandate contract) | VERIFIED-TESTNET | red-team results in `data/demo-run/run.json` |
| Worker logic: tiers, floors, idempotent chunks, crash resume, cancel mid-run, payouts, leftover sweep, anchored report | VERIFIED (70 unit tests) + LOCAL e2e | `npx vitest run`, `scripts/sandbox/worker-e2e.ts` |
| Intent parser rejects prompt-injection and out-of-bounds terms | VERIFIED (unit tests) | `tests/engine.test.ts` |
| OutLayer confidential swap QUOTE works for a fresh wallet | VERIFIED (read-only live call, 2026-11-11) | `scripts/outlayer-readonly-check.ts` |
| Dashboard builds; all 9 routes serve; data layer reads real testnet chain state | VERIFIED | `cd app && npm run build`; smoke check in the testnet run notes |
| **Real confidential swap settles with real money** | **UNVERIFIED** | gate G5 (mainnet only) |
| **Real confidential payout lands on Solana/Base** | **UNVERIFIED** | gate G6 (mainnet only) |
| **DAO `Transfer` with `msg` funds the agent's Intents balance** | **UNVERIFIED** | gate G3 (mainnet only) |
| Layer A on the CONFIDENTIAL endpoints (swap/withdraw) | UNVERIFIED | docs say the same policy engine applies (`policy_denied`); only native transfers were exercised |
| Per-mandate payout addresses enforced by wallet policy | NOT IMPLEMENTED | G13 shows policy updates are programmatic (owner-signed, 0.1 NEAR storage deposit each); the worker does not yet request a policy update per mandate, so Layer B enforces payout destinations |
| Worker signing on-chain calls with the OutLayer wallet instead of a held key | NOT IMPLEMENTED | `worker/chain.ts` note |

Simulated numbers are labelled `simulated` in the report, the CSV, the API and the dashboard. They must never be quoted as real trades.
