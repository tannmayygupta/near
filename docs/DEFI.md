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
| A real Intents / OutLayer swap or cross-chain withdraw settles | **NOT PROVEN** | needs mainnet funds. An owner-run script for one real 1Click settlement is built and smoke-tested but **has not been run with funds**: see "Real settlement (mainnet, owner-run)" below |

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
- For a wNEAR-origin quote, 1Click answered HTTP 400 `{"message":"Internal server error"}` when `refundTo`/`recipient` was the named account `wrap.near` and HTTP 201 when it was an **implicit 64-hex account**, which is the account type an OutLayer agent wallet has. The route planner therefore uses an implicit account. **Corrected 2026-11-14:** the first reading ("named accounts fail") was too broad; see the probe table below. Ordinary existing named accounts quote fine; the 400 cases are `wrap.near` as refund address, a non-existent name, and the USDC token contract as recipient. Implicit accounts worked in every case.
- No OutLayer mainnet key exists in this repo and the lane never created one (hard rule: no account creation, no registration). OutLayer confidential quotes were therefore not re-run in this lane; an earlier read-only confidential swap quote (2026-11-11) is recorded in `docs/CLAIMS.md`.

## Probe results for the live settlement (2026-11-14, all `dry:true`, no key, no funds)
Re-run with `dryQuoteFull`; amounts are quotes at the time, not fills. Sell leg = 0.5 wNEAR (about US$1.66).

**Named vs implicit accounts** (wNEAR -> USDC on NEAR):

| recipient / refundTo | Result |
|---|---|
| `alice.near` / `alice.near` | 201, out 1.658507 USDC, withdraw fee 0 |
| `bob.near` / `bob.near` | 201, out 1.656257, fee 0 |
| `wrap.near` / `wrap.near` | **400** `Internal server error` |
| `alice.near` / refund `wrap.near` | **400** `Internal server error` |
| `wrap.near` / refund `alice.near` | 201, fee 0 |
| `nonexistent-qt-probe-98765.near` (does not exist) both | **400** `Internal server error` |
| recipient = the USDC token contract's own 64-hex account, refund `alice.near` | **400** `Internal server error` |
| implicit 64-hex (the OutLayer docs example) both | 201, out 1.654083, **fee 0.004164** |
| two random fresh implicit accounts | 201, out 1.651612, same fee 0.004164 |
| uppercase hex implicit | **400** `recipient is not valid` (use lowercase) |

What this shows: implicit accounts always quoted (with a 0.004164 USDC withdraw fee; the named accounts that quoted showed a fee of 0). Ordinary existing named accounts also quote. 1Click gives no reason for the `Internal server error` cases, so no cause is claimed. The settlement script uses an implicit account because it can be created for free by sending NEAR to it and its key is generated by the script, not because named accounts are impossible.

**Destinations** (0.5 wNEAR, implicit refund): USDC on NEAR 1.654083 (fee 0.004164, ETA 22 s); USDC on Base 1.655111 (fee 0.0024, 24 s); USDC on Solana 1.645780 (fee 0.010004, 19 s); USDC on Ethereum 1.355187 (fee **0.30**, 29 s). The script settles to USDC on NEAR only (verifiable by an on-chain balance); the other destinations are quoted, not executed.

**Minimum amount** (wNEAR -> USDC on NEAR, implicit accounts): 0.001 wNEAR is rejected with `Amount is too low for bridge, try at least 0` (the "0" is 1Click's text, not a typo here); 0.0015 wNEAR quotes (out 0.000817 USDC); 0.002 -> 0.002471; 0.005 -> 0.012421; 0.01 -> 0.028987; 0.1 -> 0.327250; 1 -> 3.309352. So the floor is between 0.001 and 0.0015 wNEAR (about US$0.004), but the fixed 0.004164 fee makes anything under about 0.01 wNEAR pointless; at 0.5 wNEAR the fee is about 0.25%. USDC on Base quoted from 0.01 wNEAR up. The docs list no USD minimum for NEAR routes.

## Real settlement (mainnet, owner-run)
**Status: built and tested against fakes, NOT yet run with funds.** Until the owner runs it and `data/demo-run/intents-run.json` exists, the claim "a real Intents swap settles" stays NOT PROVEN.

**What runs.** `scripts/mainnet/intents-settle.ts` (steps in `src/near/intents-settle.ts`, the 1Click client in `src/near/intents-live.ts`). With the owner's own funded mainnet account and about 0.5 NEAR (hard cap 1):
1. a fresh ed25519 key is generated and saved to `data/secret/mainnet-intents-key.json` (git-ignored; the script refuses if git does not ignore it); its implicit account (lowercase hex of the public key) is funded by the owner's account with the swap amount plus a 0.06 NEAR float;
2. that account registers on `wrap.near` and on the USDC contract (0.00125 NEAR each), wraps the NEAR (`wrap.near` `near_deposit`);
3. a **live** 1Click quote (`dry:false`) wNEAR -> USDC on NEAR, recipient and refund address = that account;
4. the quote's deposit address is registered on `wrap.near` if it is not (it was not at quote time), then the one **deposit**: `ft_transfer` of the wNEAR to the deposit address;
5. `POST /v0/deposit/submit`, then `GET /v0/status` until SUCCESS, REFUNDED or FAILED;
6. the USDC balance is read on chain: success is declared only if it rose by at least the quote's `minAmountOut`.
Every transaction is written with a `https://nearblocks.io/txns/<hash>` link, together with the quote, 1Click's status history and swap details (including its own origin/destination transaction hashes), the balances before and after, and the final outcome, to `data/demo-run/intents-run.json` (copied to `app/public/demo-run/`).

**What it proves.** That a real NEAR Intents settlement path works end to end on mainnet: a wNEAR deposit to a 1Click deposit address becomes USDC in the recipient's balance, with the transaction hashes to check. Nothing else.

**What it does NOT prove.**
- It is **not DAO- or agent-driven**: no mandate, no vote, no bounded agent, no Layer 0/A/B. The owner runs a script with their own key. It says nothing about DAO-governed cross-chain execution.
- It is **one swap of a small amount** with the owner's own money, to an account the owner controls. It is not a cross-chain payout (the destination is USDC on NEAR), not a confidential swap, not OutLayer custody.
- Price quality is not claimed: a quote is checked against its own USD values (loss above 5% is refused) and the on-chain result against `minAmountOut`, nothing more.

**Safety rules in the code.** The gates and the order of operations are unit-tested with a stubbed chain and a stubbed 1Click (`tests/intents-live.test.ts`); the script's own glue (RPC network check, key file handling, secret scrubbing, the real `near-api-js` calls) is not covered by unit tests.
- Refuses unless `ALLOW_MAINNET=1` and `CONFIRM_INTENTS_SPEND` equals the configured amount; hard cap 1 NEAR; refuses an RPC that does not report `mainnet`.
- The AI never touches it: no model, no key outside the process environment and the git-ignored key file; the funder key is read from the environment only and scrubbed from anything printed.
- Every step checks chain state first and skips itself when done: a re-run never funds, wraps or registers twice (a bug of exactly this kind was found by the tests: a re-run after the wrap would have funded the amount a second time).
- The deposit is the point of no return: the intent is journaled before it is sent, the hash right after. A journal with an attempt and no result is **parked**: the script never deposits again, prints the deposit address and tx hash, and exits non-zero (3). An unknown outcome (timeout, polling error) is reported as unknown, never as success or failure.
- Quote guards before any deposit: no memo, `minAmountOut` above zero, at least 5 minutes left on the **earlier** of the quote's two deadlines, USD loss within 5%, `amountIn` equal to what was asked.
- `--dry` (plan, public reads, one `dry:true` quote, no files) and `--quote-only` (one real quote for a throwaway account, deposit nothing) need no secrets.

**Run it.**
```powershell
# .env: MAINNET_FUNDER_ACCOUNT, MAINNET_FUNDER_KEY (and optionally INTENTS_AMOUNT_NEAR, ONECLICK_JWT)
npx tsx --env-file=.env scripts/mainnet/intents-settle.ts --dry          # rehearse: no funds, no files
$env:ALLOW_MAINNET='1'; $env:CONFIRM_INTENTS_SPEND='0.5'
npx tsx --env-file=.env scripts/mainnet/intents-settle.ts                # the real run
```
Exit codes: 0 settled and verified | 1 error before any deposit | 2 refused by a guard | 3 deposit sent, outcome unknown (parked) | 4 SUCCESS but the balance check failed | 5 refunded | 6 failed. Only exit 0 writes `intents-run.json`; every other ending is kept in the git-ignored journal `data/secret/mainnet-intents-journal.json`. The owner spends at most the amount plus the 0.06 NEAR float; the float's leftover and the USDC stay in the settlement account, whose key is in `data/secret/mainnet-intents-key.json`: back that file up.

**Recorded API shape and behaviour (`--quote-only`, 2026-11-14, throwaway account, nothing deposited).** `POST /v0/quote` with `dry:false` answers `{correlationId, timestamp, signature, quoteRequest, quote}`; `quote` has `depositAddress` (a 64-hex implicit account), `amountIn/Out` (+ `Formatted`, `Usd`), `minAmountOut`, `deadline`, `timeWhenInactive`, `timeEstimate`, `refundFee`, `withdrawFee`; no `depositMemo` for NEAR. Facts that shaped the code: (1) `quote.deadline` was **3 days** out although we sent a 20-minute `deadline`: it is when the deposit address goes inactive, ours is when refunds start, so the guard uses the earlier one; (2) the deposit address was **not registered** on `wrap.near` (`storage_balance_of` null), so the script registers it before `ft_transfer`; whether an unregistered address would actually make the transfer fail is the standard NEP-141 behaviour and was **not tested with a real deposit**; (3) `GET /v0/status` straight after the quote answers 200 `PENDING_DEPOSIT` with null swap fields (not 404); (4) `signature` is an `ed25519:` string of 88 characters, which the repo's secret scan matches, so the recorded run keeps only its SHA-256 and the journal keeps the string; (5) without a partner JWT 1Click adds 0.25% (per its docs; not measured here).

**What could go wrong.** The real run has never executed: the code paths that send transactions (`near-api-js` calls for the funding transfer, the two `storage_deposit`s, `near_deposit`, `ft_transfer`) are exercised only through fakes and through the read-only helpers. A swap can be refunded (exit 5; the wNEAR returns to the settlement account), or 1Click can report FAILED (exit 6; support needs the correlation id in the journal). A wrong guess about 1Click's deposit detection shows up as a status timeout (exit 3), never as a second deposit.

## What a skeptical judge could say (and the honest answer)
- "The swaps are on a testnet DEX, not Intents." True. Intents has no testnet. What is real: the DAO-bounded, non-custodial execution with a floor per chunk; Intents routes are live-quoted and the request path is tested but not executed.
- "Chunking gave no price gain." True (-1 bp on a constant-product pool, the report says so). No gain is claimed.
- "No perps / lending / vaults." True. The claim is a DAO-governed trading agent (vault funded by vote) only.

## Paragraph for the README top line (the parent owns README.md; text for it)
> **Unstoppable DeFi (scoped):** real on-chain execution (Ref Finance, public testnet) of a DAO-approved sell mandate with a price floor on every chunk, non-custodial (the DAO funds a vault by vote; the agent cannot exceed the on-chain mandate; a DAO cancel switches it off), plus the cross-chain NEAR Intents routes implemented and live-quoted on mainnet liquidity (dry-run quotes, [docs/DEFI.md](docs/DEFI.md)). NEAR Intents execution, OutLayer-custody swaps, confidential swaps and cross-chain payouts are **not proven with real money**.
