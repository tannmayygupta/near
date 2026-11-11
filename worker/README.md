# worker/ - Quiet Treasury agent worker

Turns an APPROVED on-chain mandate into hidden swap chunks, payouts, a leftovers sweep and an anchored settlement report.
Pure logic lives in `executor.ts` over injected ports (`ports.ts`), so it is unit-tested with fakes; `index.ts` is the only production wiring.

| File | Role |
|---|---|
| `executor.ts` | state machine: verify terms + DAO approval + tier -> fund -> chunk loop -> settle -> report -> anchor; kill switch |
| `guards.ts` | LAYER B rules (budget, tokens, destinations, window, tiers) shared by executor and red-team |
| `state.ts` | SQLite (`node:sqlite`) + AES-256-GCM store for sealed terms (`SEALED_TERMS_KEY`, 32 bytes) |
| `chain.ts` | real adapter for the mandate contract + Sputnik DAO reads |
| `api.ts` / `auth.ts` | read-only HTTP API (paths = `app/lib/data.ts`), NEP-413 council auth |
| `redteam.ts` | five REAL attacks, never money-moving; reports which layer blocked (A = OutLayer wallet policy, B = executor/contract) or `blocked:false` |
| `index.ts` | env config, `/health`, JSON logs, graceful shutdown |

## Run
```
NEAR_NETWORK=mainnet DAO_ACCOUNT=... MANDATE_CONTRACT=... AGENT_ACCOUNT_ID=... AGENT_SECRET_KEY=... OUTLAYER_WK=wk_... \
SEALED_TERMS_KEY=<64 hex> STATE_DB=data/worker.sqlite PORT=8787 npx tsx worker/index.ts
```
Tests: `npx vitest run tests/worker` (28). End to end on the local sandbox: `npx tsx scripts/sandbox/worker-e2e.ts` (20 checks; uses a TEST-ONLY local OutLayer stand-in).

## Behaviour worth knowing
- A mandate runs only if: on-chain hash matches the terms, terms re-validate against `BOUNDS`, a DAO proposal with that `terms_hash` is Approved, and approvals meet the tier (small 1, mid majority, large all; low treasurer trust can bump small to mid).
- Each chunk: plan -> confidential swap quote -> floor check (no trade if below) -> swap with `X-Idempotency-Key = mandate:chunk:attempt` and `min_amount_out` -> poll to terminal -> `record_chunk` on chain AFTER success. Refunded/failed swaps retry with a new attempt key and never count toward the budget.
- Crash-safe: in-flight chunks persist (planned/submitted); restart re-polls the same request, never submits twice.
- Settlement: fee, payouts (percent of net or fixed, capped by proceeds, shortfall flagged), leftover proceeds and unspent budget to `returnTo`. A payout that keeps failing becomes `needs_review`; the mandate then stays `Settling` and is NOT completed (surfaced in `/health` and `/api/mandates/:id/status`).
- DAO cancel: stop within one tick, wait for any in-flight swap, return everything to `returnTo`, no payouts/fee. The contract cannot anchor reports for Cancelled mandates, so that report is kept locally (verify page says so).
- Payouts must be in the buy token (other tokens would need a second swap; the mandate is refused instead of silently skipped).

## NOT verified / known gaps (honest)
- Money-moving OutLayer calls (`confidential/swap`, `withdraw`, `shield`) have NEVER been run live; request/response shapes follow the docs. The e2e uses a local stand-in, which proves worker logic, not OutLayer behaviour.
- The on-chain `agent` account must be a key this process holds. Signing `mark_funded/record_chunk/...` with the OutLayer wallet (`/wallet/v1/call`) is not implemented.
- The DAO `Transfer`-with-`msg` funding of the agent's Intents balance (gate G3) is unverified; the worker only observes balances and shields public -> confidential when needed.
- `terms_hash` convention: plain = `sha256(canonical JSON of parsed terms)` (`hashJson`); sealed = `sha256(salt|canonical terms)` (`commit`). The wizard in `app/` must produce the same hashes (not checked here).
- OutLayer policy updates per mandate (gate G13) are not attempted; Layer B enforces destinations. Withdraw dry-run before real withdraws is not performed (saves custody-op budget).
- NEAR AI summaries and the live benchmark are wired in `index.ts` but untested live (no API key in this environment).
