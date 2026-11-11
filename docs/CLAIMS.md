# CLAIMS vs EVIDENCE (updated as work lands; anything without evidence is deleted before submission)

Legend: VERIFIED = reproduced by a command in this repo | LOCAL = verified on the local sandbox only | UNVERIFIED = not yet proven live

| Claim | Status | Evidence |
|---|---|---|
| Real Sputnik DAO v2 votes create/cancel mandates; 1 of 3 votes does nothing, 2 of 3 executes | LOCAL | `npx tsx scripts/sandbox/dao-flow.ts` (9/9) |
| Non-DAO callers cannot create mandates; agent cannot exceed budget or act after cancel | LOCAL | same script + contract unit tests (16) |
| Worker: tiers, floors, idempotent chunks, crash resume, cancel mid-run, payouts, leftover sweep, anchored report | LOCAL (with a TEST-ONLY OutLayer stand-in) | `npx vitest run` (70), `scripts/sandbox/worker-e2e.ts` |
| Intent parser rejects prompt-injection and out-of-bounds terms | VERIFIED (unit tests) | `tests/engine.test.ts` |
| Verifier detects tampered reports/signatures | VERIFIED (unit tests) | `src/verify/cli.ts` |
| OutLayer confidential swap quote works for a fresh wallet | VERIFIED (read-only live call, 2026-11-11) | `scripts/outlayer-readonly-check.ts` |
| NEAR AI attestation is fetchable with a fresh nonce, no key | VERIFIED (live, 2026-11-11) | `src/near/ai.ts` |
| Real confidential swap settles with real money | UNVERIFIED | gate G5 |
| Real confidential payout lands on Solana/Base | UNVERIFIED | gate G6 |
| DAO Transfer funds the agent's Intents balance on mainnet | UNVERIFIED | gate G3 |
| NEAR AI signed responses verify end to end | UNVERIFIED (needs API key) | gate G4 |
| OutLayer wallet policy (layer A) blocks attacks | UNVERIFIED | gate G7 / G13 |
