# Quiet Treasury

**A DAO votes once on a plain-English mandate. A sealed-chip agent executes it privately inside hard limits, pays out, returns the leftovers, and publishes a verifiable settlement report.**
Built for NEAR HACKATHON 2026 (Social Money, Autonomous Business, Privacy & Private AI, Real-World Money, AI Security & Defense, Unstoppable DeFi, Open Innovation). Status of every claim: see [docs/CLAIMS.md](docs/CLAIMS.md). Plan: [PLAN.md](PLAN.md).

## The problem
DAOs and foundations regularly sell their own token to fund operations. Public, lumpy sales move the price and get front-run, and the vote itself telegraphs the trade. Quiet Treasury lets a DAO approve *what* may be sold (token, budget, price floor, window, payouts) and nothing else; an agent does the rest without the ability to exceed it.

## How it works
1. A member types an intent. A NEAR AI Cloud TEE model drafts a structured **mandate**; code validates it against hard bounds (it never trusts the AI) and a human confirms.
2. The app creates two **Sputnik DAO** proposals (create mandate on our contract, fund the agent). Council members vote; tier rules decide how many approvals are needed.
3. The **Mandate contract** (`contracts/mandate`) is the on-chain source of truth: only the DAO can create/cancel, only the agent can record progress, budget and window are enforced on-chain.
4. The **worker** (`worker/`) executes randomized chunks through an **OutLayer** agent wallet (keys in an Intel TDX enclave) using confidential swaps, with a price floor on every chunk, then pays contributors on their own chains, returns leftovers to the DAO, and anchors a settlement report hash on-chain.
5. Anyone can run the **verifier** (`src/verify`) on the report; the dashboard (`app/`) shows live state, a copycat view, and real red-team attacks.

## Why each NEAR piece is needed (what breaks without it)
| Piece | Remove it and... | Closest alternative and why it falls short |
|---|---|---|
| Sputnik DAO (+Trezu-compatible treasury) | no on-chain approval; the agent would obey whoever runs the server | multisig: approves transactions, not bounded standing mandates |
| Mandate contract | budget/window/cancel rules live only in our server | off-chain config: can be silently changed |
| OutLayer agent wallet (MPC keys in TDX, policy) | keys sit on our server | hot wallet / company-run custody: operator can steal |
| Confidential Intents (via OutLayer) | every chunk is a public trade; the sale is front-run | public DEX: leaks the schedule |
| NEAR AI Cloud (TEE inference, signed answers) | mandate drafting/report summaries go to a provider that can read them, with nothing to verify | normal LLM APIs: no confidentiality proof |
| Intents cross-chain payouts | contributors must use one chain | bridges: extra hops and risk |

## Run it (judge mode, no funds needed)
```
npm install
npx vitest run                         # 70 tests: parser, planner, settlement, verifier, worker edge cases
powershell scripts/build-contract.ps1  # builds + tests the contract in Docker (needs Docker)
npx tsx scripts/sandbox/setup.ts       # real Sputnik DAO on a local NEAR sandbox (docker run qt-sandbox, see docker/sandbox)
npx tsx scripts/sandbox/dao-flow.ts    # real DAO votes drive the mandate contract: expect 9/9 PASS
npx tsx scripts/sandbox/worker-e2e.ts  # full worker run on the sandbox (uses a TEST-ONLY OutLayer stand-in): expect all PASS
npx tsx src/verify/cli.ts <report.json>  # verify a settlement report
cd app && npm install && npm run dev   # dashboard (reads recorded run in app/public/demo-run when present)
```

### Public NEAR testnet (needs `.env` with `NEAR_AI_API_KEY`; testnet accounts are free)
```
npx tsx scripts/testnet/setup.ts                      # real Sputnik DAO + mandate contract on testnet (ids in data/testnet-public.json)
npx tsx scripts/testnet/dao-flow.ts                   # real votes -> contract, real tx hashes: expect 8/8 PASS
npx tsx scripts/testnet/layer-a.ts                    # OutLayer testnet wallet policy set programmatically + real 403 policy_denied
npx tsx --env-file=.env scripts/testnet/e2e.ts        # FULL flow incl. NEAR AI signed parse/summary, DAO votes, worker, red team: expect 20/20 PASS
npx tsx src/verify/cli.ts data/demo-run/proof-bundle.json   # independent verification of the recorded run: expect 13/13 PASS
cp app/.env.testnet.example app/.env.local && cd app && npm run build && npm start   # dashboard pointed at the testnet DAO
EXEC_MODE=simulated ... npx tsx worker/index.ts       # worker API (see .env.example); EXEC_MODE=live is the default and is UNPROVEN with real money
```
**On testnet, swap fills, payouts and the leftover sweep are SIMULATED** (priced from real read-only 1Click quotes, request ids `sim-*`, source tag `simulated`): NEAR Intents exists only on mainnet, so no trade happens. Everything else in that run (AI parse + signatures, DAO votes, contract state, anchored report hash, OutLayer wallet-policy denials) is real. See [docs/CLAIMS.md](docs/CLAIMS.md).

The recorded testnet run is in `data/demo-run/run.json` (also served by the dashboard from `app/public/demo-run/`) and is labelled **recorded** / **simulated** in the UI. Recorded real-money (mainnet) runs do not exist yet.

## Trust assumptions (read these)
- The worker is **not** in a TEE in v0: it sees the mandates it executes. Wallet keys are in OutLayer's TDX enclave; AI inference is in NEAR AI's TEE.
- OutLayer's team currently holds governance/admin keys. Defuse/1Click solvers see swap details before execution. The private shard has no public RPC but its operator can read it.
- The DAO's funding transfer to the agent is public on chain (mitigation: routine "operations float" top-ups).
- Wallet-policy owner is a single account in v0 (production: the DAO).
- TEEs rely on Intel/NVIDIA hardware trust. Nothing here is audited. **Not investment advice**; demo funds are the authors' own.

## Libraries and templates
near-api-js, zod, @noble/curves, @noble/hashes, vitest, tsx, near-sdk (Rust), Next.js, @near-wallet-selector. Sputnik DAO v2 contract (near-daos/sputnik-dao-contract) is used unmodified. Everything else was written during the hackathon window.

License: MIT.
