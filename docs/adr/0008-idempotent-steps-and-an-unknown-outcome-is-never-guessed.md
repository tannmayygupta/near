# 0008. Idempotent steps, and an unknown outcome is never guessed

Status: accepted (2026-11-12); amended 2026-11-13

Every chunk has an idempotency key `<mandate>:<chunk>:<attempt>`; the adapter persists its stage **before** each side effect; the contract's `record_chunk` ignores a replayed index. With OutLayer custody the key is also sent as `X-Idempotency-Key` (a deterministic UUID per step), and OutLayer deduplicates a replay: the original result comes back with `result.tx_hash`. A worker that dies after a swap landed therefore resumes onto the **same** transaction instead of swapping twice. This is proven live, not only in unit tests (`data/demo-run/restart-run.json`, 12/12).

Rejected: **blind retries** (double-spend risk). **Guessing an unknown outcome** (refund a swap that actually happened). An unrecoverable outcome parks the item for a human.

Amended 2026-11-13: a replayed key answers with `result.tx_hash`, not a top-level `tx_hash`; the signer reads both (`txOfResponse`). Hourly policy rate limits are treated as a pause, not a block.
