# 2026-11-13: the thin testnet pool drifted and the worker refused to trade

Status: closed (operational; tooling added)

## Summary
Two runs stalled for the same underlying reason: Ref Finance testnet pool #57 is open to anyone and its price moves. (1) The pool drifted to ~37 USDT.e per NEAR, 8x market; the adapter's sanity band rejected it ("no sane Ref testnet pool with enough liquidity"). (2) After several of our own sells it drifted down to 1.99, below the mandate's floor of 2.0, so every chunk answered `floor_not_met` and nothing traded. In both cases the worker did the right thing: it refused to sell at a price outside the mandate.

## Identifiers
| What | Value |
|---|---|
| Pool | `ref-finance-101.testnet` pool 57 (wrap.testnet / usdt.fakes.testnet) |
| Observed | 36.877 -> (rebalanced) 4.509; later 1.990 -> 4.497 USDT.e per NEAR |
| Worker events | `outlayer_error ... no sane Ref testnet pool`, `floor_not_met {"quoted":"111329","minOut":"114248"}` |

## Why
Ours: the recorded runs depend on a pool price we do not control. Theirs: nobody maintains the testnet pool.

## What changed
* `scripts/dev/ref-rebalance.ts`: restores the pool toward a target price from the key-held vault (either direction); `docs/RUNBOOK.md` says to run it when the worker keeps answering `floor_not_met`.
* The price floor itself was **not** loosened (ADR 0007).
* `docs/CLAIMS.md` already states that testnet prices say nothing about mainnet.

## Lesson
A guard that fires is the system working. Do not widen a bound to make a demo pass; fix the environment.
