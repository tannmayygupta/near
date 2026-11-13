# 2026-11-13: the crash-restart test failed three times before it passed

Status: closed (12/12 recorded in `data/demo-run/restart-run.json`)

## Summary
The live crash-restart test kills the worker right after a real swap landed and starts a new one from the same files. Attempt 1: the restarted worker looped on `OutLayer call ft_transfer_call ended with status success`. Attempt 2: it traded 5 chunks then stopped on `wallet_blocked policy_denied`. Attempt 3: no chunk traded (pool below the floor, see the pool-drift note). Attempt 4 passed 12/12.

## Identifiers
| What | Value |
|---|---|
| Replay probe | `scripts/dev/outlayer-idem-probe.ts` (first call, then the same `X-Idempotency-Key`) |
| Replay response | `{"error":"duplicate_idempotency_key","status":"success","request_id":...,"result":{"tx_hash":"..."}}` |
| Passing run | `data/demo-run/restart-run.json` (crash swap tx recorded in `crash.swapTx`) |

## Why
1. OutLayer **does** deduplicate a replayed idempotency key (good: no double swap), but the replay carries the hash under `result.tx_hash`, not at the top level; our signer required the top-level field.
2. The wallet policy's `max_per_hour` (84) was lower than the calls our own repeated test runs had made in the same hour.
3. The pool price (see the other note).

## What changed
* `txOfResponse()` reads both shapes (`worker/adapters/signers.ts`, unit-tested).
* `rate_limit.max_per_hour = max(300, chunks * 40)` and an hourly rate-limit refusal is a pause, not a block (`worker/executor.ts`).
* The refusal message is recorded in the event (`wallet_blocked` now carries the text).
* ADR 0008 amended.

## Lesson
The proof that matters is the one that survives a kill. We kept the failures in the repo history rather than re-running until green.
