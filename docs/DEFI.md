# Unstoppable DeFi: what is real, what is quoted, what is not proven

Track text: *exchanges, perps, lending, vaults and trading agents that settle across chains through NEAR Intents. Deep liquidity, no custodian, nobody to switch it off.*
User decision 2026-11-12: claim the track, scoped exactly as below. Judging weights: NEAR Tech Usage 35, Real-Not-Simulated 25, Track Fit 20, Execution 20.

## The scoped claim (every word is evidenced)
Real on-chain DEX execution (Ref Finance, public NEAR testnet) of a DAO-approved sell mandate with a price floor on every chunk, non-custodial (the DAO funds a vault by vote, the agent cannot exceed the on-chain mandate, a DAO cancel switches it off), with the cross-chain NEAR Intents routes implemented and live-quoted on mainnet liquidity. **Not proven with real money:** NEAR Intents execution, OutLayer-custody swaps, confidential swaps and cross-chain payouts (Intents exists only on mainnet and the team is not funding mainnet).

## Evidence
| Claim | Status | How to reproduce / where |
|---|---|---|
| Real swaps of a DAO-approved mandate on a real DEX with a floor on every chunk | REAL (public testnet) | `data/demo-run/run.json` (`real.swaps`, explorer links), `npx tsx --env-file=.env scripts/testnet/e2e-real.ts`, verifier `npx tsx src/verify/cli.ts data/demo-run/proof-bundle.json` ("every fill respected the price floor") |
| Non-custodial: funding is a DAO vote; agent bounded by the contract; DAO cancel stops it and returns funds | REAL (public testnet) | `contracts/mandate`, `scripts/testnet/dao-flow.ts`, `data/demo-run/run.json` (`cancelRun`, `proposals`) |
| Intents sell leg and every cross-chain payout leg quote live (wNEAR -> USDC on NEAR; USDC on NEAR -> USDC on Solana / Base / Arbitrum / Ethereum) | QUOTED (mainnet, dry:true, no key, no funds) | `npx tsx scripts/mainnet/readonly-proof.ts` -> `data/demo-run/mainnet-readonly.json`; dashboard `/routes` |
| The live executor decision path (plan a chunk -> real quote -> price floor -> exact request) runs against mainnet liquidity with every money-moving call blocked | REAL logic, NO money (live-dryrun) | `EXEC_MODE=live-dryrun`, `worker/adapters/live-dryrun.ts`, `npx tsx scripts/mainnet/dryrun-decision.ts` -> `data/demo-run/mainnet-dryrun-decision.json` |
| OutLayer / Intents request shapes (paths, bodies, auth and idempotency headers) match the OutLayer docs | TESTED (contract-shape unit tests, no network) | `tests/routes.test.ts` |
| A real Intents / OutLayer swap or cross-chain withdraw settles | **NOT PROVEN** | needs mainnet funds |

## Recorded live quotes (2026-11-12, 1Click `dry:true`, mainnet liquidity)
Sample mandate: sell 5 wNEAR, pay five contributors. The quotes depend on the market at the time; re-run the script for current numbers.

| Leg | In | Quoted out | Min out | Withdraw fee | ETA |
|---|---|---|---|---|---|
| Sell wNEAR -> USDC (NEAR) | 5.0000 wNEAR | 16.785139 USDC | 16.617287 | 0.004190 | 22 s |
| Pay alice: USDC (NEAR) -> USDC (Solana) | 4.196284 | 4.185815 | 4.143956 | 0.009975 | 17 s |
| Pay bob: -> USDC (Base) | 4.196284 | 4.193034 | 4.151103 | 0.002400 | 22 s |
| Pay carol: -> USDC (Arbitrum) | 3.357027 | 3.351331 | 3.317817 | 0.005300 | 19 s |
| Pay dave: -> USDC (Ethereum) | 2.517770 | 2.217472 | 2.195297 | 0.300000 | 27 s |
| Pay erin: USDC already on NEAR | 2.517770 | plain Intents withdraw, nothing to quote | | | |

The Ethereum leg shows a 0.30 USDC withdraw fee on a small amount: it is recorded, not hidden. Live-dryrun decisions (same sample sale): floor below the market -> the executor would send `POST /wallet/v1/confidential/swap` (blocked); floor above the market -> it would refuse.

## Findings from the probe (kept because they are real API behaviour)
- For a wNEAR-origin quote, 1Click answered HTTP 400 `{"message":"Internal server error"}` when `refundTo`/`recipient` was a **named** NEAR account (e.g. `wrap.near`) and HTTP 201 when it was an **implicit 64-hex account**, which is the account type an OutLayer agent wallet has. The route planner therefore uses an implicit account.
- No OutLayer mainnet key exists in this repo and the lane never created one (hard rule: no account creation, no registration). OutLayer confidential quotes were therefore not re-run in this lane; an earlier read-only confidential swap quote (2026-11-11) is recorded in `docs/CLAIMS.md`.

## What a skeptical judge could say (and the honest answer)
- "The swaps are on a testnet DEX, not Intents." True. Intents has no testnet. What is real: the DAO-bounded, non-custodial execution with a floor per chunk; Intents routes are live-quoted and the request path is tested but not executed.
- "Chunking gave no price gain." True (-1 bp on a constant-product pool, the report says so). No gain is claimed.
- "No perps / lending / vaults." True. The claim is a DAO-governed trading agent (vault funded by vote) only.

## Paragraph for the README top line (the parent owns README.md; text for it)
> **Unstoppable DeFi (scoped):** real on-chain execution (Ref Finance, public testnet) of a DAO-approved sell mandate with a price floor on every chunk, non-custodial (the DAO funds a vault by vote; the agent cannot exceed the on-chain mandate; a DAO cancel switches it off), plus the cross-chain NEAR Intents routes implemented and live-quoted on mainnet liquidity (dry-run quotes, [docs/DEFI.md](docs/DEFI.md)). NEAR Intents execution, OutLayer-custody swaps, confidential swaps and cross-chain payouts are **not proven with real money**.
