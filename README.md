# Quiet Treasury

**A DAO votes once on a plain-English mandate. An agent executes it inside hard limits, pays out, returns the leftovers, and publishes a verifiable settlement report.** The real run (swaps, payouts, returns) is on public NEAR testnet; the *confidential/hidden* execution design is mainnet-only and **not proven**.
Built for NEAR HACKATHON 2026. **Tracks claimed: Social Money (main), Autonomous Business, AI Security & Defense, Privacy & Private AI (private inference + signed, attested outputs only; no hidden-trades claim), Real-World Money (real testnet payouts to named accounts + CSV; no cross-chain payout claim), Open Innovation (sealed commit-reveal mandates: a DAO approves terms that stay off-chain until settlement, then they are revealed and independently verified; proven on public testnet, see [docs/SEALED.md](docs/SEALED.md)).** Not claimed: Unstoppable DeFi (swaps run on a NEAR testnet DEX, not Intents). Evidence per track: [docs/submission.md](docs/submission.md) section 0. Status of every claim: [docs/CLAIMS.md](docs/CLAIMS.md). Plan: [PLAN.md](PLAN.md). Docs: [architecture](docs/ARCHITECTURE.md), [runbook](docs/RUNBOOK.md), [deploy](docs/DEPLOY.md).

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
npx tsx --env-file=.env scripts/testnet/e2e-real.ts   # FULL flow with REAL on-chain money movement (EXEC_MODE=testnet-real): expect 29/29 PASS (~12 min, real tx hashes)
npx tsx --env-file=.env scripts/testnet/e2e.ts        # older flow with SIMULATED fills (kept for reference): expect 20/20 PASS
npx tsx src/verify/cli.ts data/demo-run/proof-bundle.json   # independent verification of the recorded run: expect 13/13 PASS
cp app/.env.testnet.example app/.env.local && cd app && npm run build && npm start   # dashboard pointed at the testnet DAO
EXEC_MODE=testnet-real ... npx tsx worker/index.ts    # worker API doing REAL testnet swaps (env: see worker/README.md); EXEC_MODE=live is the default and is UNPROVEN with real money
```
**What is real on testnet (recorded run `mode: testnet-real`, every step has an explorer link in `data/demo-run/run.json`):** the NEAR AI TEE parse and signed completions, the Sputnik DAO votes, a **real Sputnik `Transfer` proposal that funds the agent vault with native NEAR**, **real Ref Finance swaps** (wNEAR to USDT.e, request id = the swap transaction hash), **real USDT.e payouts and fee to named accounts**, **real leftover returns to the DAO**, a real DAO cancel mid-run, the anchored report hash and OutLayer wallet-policy denials.

**What is NOT proven (mainnet-only):** OutLayer TEE custody swaps, confidential swaps/withdraws, Intents cross-chain payouts. On the testnet path custody is a vault key held by the worker, there is no confidentiality, testnet tokens are worthless play money, and the thin Ref pool has no arbitrageurs, so chunked selling does **not** beat one swap there (the report states what one swap would have returned: about -1 bp, i.e. the fee). See [docs/CLAIMS.md](docs/CLAIMS.md).

The recorded testnet run is in `data/demo-run/run.json` (also served by the dashboard from `app/public/demo-run/`) and is labelled **recorded** in the UI; the older simulated-fills run is kept as `run-simulated.json`. Recorded mainnet runs do not exist yet.

## Sealed mandates (commit-reveal), proven end to end on public testnet
A DAO can approve a mandate whose terms stay off the public chain until it settles: the proposal and contract hold only `terms_hash = sha256(salt | terms)` plus the budget; the worker keeps the terms AES-256-GCM encrypted and releases them only to council members who sign a NEP-413 request (unsigned, non-council, wrong-action and impersonation requests all get 401). After settlement `complete(revealed_terms)` publishes the terms and anyone can check them.
- Run: `npx tsx --env-file=.env scripts/testnet/e2e-sealed.ts` (36/36 on mandate #12: real DAO vote, real funding Transfer, 5 real Ref swaps, real payouts, signed AI summary, reveal). Recorded in `data/demo-run/sealed-run.json`; verify with `npx tsx src/verify/cli.ts data/demo-run/sealed-proof-bundle.json` (21/21, including 5 tamper cases that must FAIL: changed floor, changed salt, swapped recipient, terms public early, leaked secret). Details and limits: `docs/SEALED.md`.
- Honest limits: the worker is not in a TEE, so its operator can read sealed terms; on testnet the swaps and payouts are public and recipients become visible when payouts execute. Hidden (confidential) execution is mainnet-only and unproven.

## Trust assumptions (read these)
- The worker is **not** in a TEE in v0: it sees the mandates it executes. Wallet keys are in OutLayer's TDX enclave; AI inference is in NEAR AI's TEE.
- OutLayer's team currently holds governance/admin keys. Defuse/1Click solvers see swap details before execution. The private shard has no public RPC but its operator can read it.
- The DAO's funding transfer to the agent is public on chain (mitigation: routine "operations float" top-ups).
- Wallet-policy owner is a single account in v0 (production: the DAO).
- TEEs rely on Intel/NVIDIA hardware trust. Nothing here is audited. **Not investment advice**; demo funds are the authors' own.

## Other projects by our team (hackathon rule: each README names the others; independent, no shared code)
PLACEHOLDER - names and repo links of the teammates' projects (see docs/TEAM-KIT.md) once their repos are public.

## Libraries and templates
near-api-js, zod, @noble/curves, @noble/hashes, vitest, tsx, near-sdk (Rust), Next.js, @near-wallet-selector. Sputnik DAO v2 contract (near-daos/sputnik-dao-contract) is used unmodified. Everything else was written during the hackathon window.

License: MIT.
