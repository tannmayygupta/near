# Working in this repository

Quiet Treasury: a DAO votes once on an AI-parsed mandate; a bounded agent executes it on NEAR testnet; everything is verifiable.

## Read first
1. `CONTEXT.md`: the shared vocabulary. Use these words exactly.
2. `docs/adr/`: the decisions and what they rejected. If a change contradicts one, say so before making it.
3. `docs/CLAIMS.md`: every claim with its status and evidence. Do not add a claim without evidence; delete a claim that loses its evidence.
4. `docs/JUDGES.md`: the five-minute path a reviewer follows.

## Rules
- **Never commit secrets.** Keys live in `data/secret/` and `.env` (git-ignored). Run `npm run secret-scan` before committing.
- **Honest numbers.** Counts in docs (tests, checks, runs) must match reality: run `npm test`, `npm run verify`, `npm run demo` and update every file that quotes them (README, `docs/JUDGES.md`, `docs/CLAIMS.md`, `docs/TRACKS.md`, `llms.txt`).
- **Testnet only.** Never point anything at mainnet without an explicit instruction. The worker refuses to start on a network that does not match its configuration.
- **Do not weaken a safety bound to make a test pass.** A zero price floor, a wider key scope or a looser guard is a bug.
- **Money-moving code is deterministic.** The AI drafts and summarises; it never signs, never decides an amount, never holds a key.
- **Idempotency first.** A retried step must never act twice; an unknown outcome is parked, not guessed.
- **Docs ship with the code** in the same commit. Write an ADR for a decision others could reasonably have made differently; write an incident note when something real failed.

## Commands
`npm ci` · `npm test` · `npm run verify` · `npm run demo` · `npm run secret-scan` · `npm run check:evidence` (network) · `npm run verify:contract` (network) · `npm run e2e:custody` / `e2e:restart` / `e2e:real` / `e2e:sealed` (need funded testnet accounts and a NEAR AI key; see `docs/RUNBOOK.md`).

## Layout
`contracts/mandate/` Rust contract · `src/` engine, NEAR clients, verifier · `worker/` agent, API, guards, red team, adapters · `app/` dashboard · `scripts/testnet/` live runs · `data/demo-run/` recorded runs · `docs/` documents.
