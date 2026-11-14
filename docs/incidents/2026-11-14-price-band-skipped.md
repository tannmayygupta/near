# 2026-11-14: two recorded runs traded through an absurd pool because the price band was silently skipped

Status: closed (fixed, tested, every run re-recorded on contract v2; the old recordings are only in git history, tag `v1-recorded-runs`)

## Summary
Rendering the dashboard pages in a real browser showed nonsense in the OutLayer-custody run: swaps 2 and 3 "received" 975,814,065,959,276 USDT.e and the payouts were astronomically large. Scanning every recorded run confirmed it: in `custody-run.json` (swaps 2-3) and in all of `restart-run.json`, the Ref adapter had swapped through a testnet pool priced about 10^16 USDT.e per NEAR. The adapter has a **sanity band** that ignores pools whose spot price is far from a mainnet reference price, precisely because anyone can create or drain a testnet pool. When the reference-price fetch failed (a rate-limited quote), the band was **skipped** instead of refusing to trade, so the "best output" pool won. The run's 36/36 and 12/12 checks all passed anyway: the price floor is trivially met at an absurd price, and nothing asserted that prices were market-like. The key-held run and the sealed run were not affected (prices 2-4.5).

## Identifiers
| What | Value |
|---|---|
| Affected recordings (git tag `v1-recorded-runs`) | `data/demo-run/custody-run.json`, `data/demo-run/restart-run.json` |
| Absurd prices (USDT.e per NEAR) | custody swaps 2-3: ~1.0e16; restart swaps 0-5: 6.4e15 to 8.2e15 |
| Pool that won | a testnet wNEAR/USDT.e pool with ~1.9e16 USDT.e of reserve (pool 34) |
| Where it was caught | the `/custody` page in a headless-Chrome render; then `scripts` scan of all runs |

## Why
Ours: the band was **fail-open**. Our own incident notes say "a guard that fires is the system working"; this guard did not fire when its input was missing. Our checks verified the floor, not the plausibility of the fills, and no page had been looked at by anything but a build.
Theirs: the mainnet quote used as the reference is rate limited.

## What changed
* `worker/adapters/price-guard.ts`: `RefPriceGuard` retries the reference fetch, remembers the last good price for an hour, and **throws `ReferenceUnavailable` instead of skipping the band**; the adapter turns that into a refusal to trade (503, retried later). Unit tests: fresh price, fallback to a recent price, refusal with none, retries, and the band rejecting 1e16x and 0.0001x pools (`tests/hardening.test.ts`).
* Every end-to-end script (`e2e-real`, `e2e-custody`, `e2e-sealed`, `e2e-restart`) now asserts **every swap executed at a market-like price (0.3-15 USDT.e per NEAR)** and prints the prices (`pricesSane` in `scripts/testnet/lib.ts`).
* All four runs were re-recorded on the v2 contract with these checks (custody 37/37, restart 13/13, real and sealed with an extra check each).
* `docs/CLAIMS.md` and the README quote only the re-recorded runs.

## Risks that remain
The band depends on a mainnet quote API being reachable at least once an hour. Without it the worker stops trading, which is the safe failure.

## Lesson
"All checks passed" only means the checks passed. Look at the numbers, and render the pages: the browser found in a minute what 36 green checks did not.
