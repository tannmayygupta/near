# 2026-11-14: the schema accepted a price floor of zero

Status: closed (fixed in `de5008b`)

## Summary
While writing the offline demo (`npm run demo`) we checked which out-of-bound terms the schema rejects. `minPrice: "0"` was **accepted**. A zero floor means `min_amount_out = 0`: "sell at any price", the opposite of the product's central guarantee. A prompt-injected or careless parse could have produced it; the human review table and the DAO vote were the only remaining barriers.

## Identifiers
| What | Value |
|---|---|
| Probe | `minPrice0 ACCEPTED`, `noPayouts ACCEPTED` (the latter is legitimate: sell and return everything) |
| Fix | `src/engine/schema.ts`: `minPrice` must be finite and greater than zero |
| Regression test | `tests/engine.test.ts`: "rejects a zero (or non-numeric) price floor ..." |

## Why
Ours: `minPrice` was validated as a decimal string, not as a positive number. The existing tests covered injection and unknown tokens but not "valid-looking dangerous value". It was also not caught by the earlier red-team attacks, which test the guards after a mandate exists.

## What changed
Schema fix and test. The worker's own `verify()` re-parses the terms of every on-chain mandate with the same schema, so an already-created zero-floor mandate is refused (`terms_invalid`) as well.

## Risks that remain
Other "valid but dangerous" values (huge fee, tiny chunks) are bounded by existing limits; a property-based sweep of the schema is on the roadmap.

## Lesson
Test the dangerous-but-valid inputs, not just the malformed ones.
