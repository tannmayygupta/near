# PLAN.md v3 - QUIET TREASURY (NEAR HACKATHON)

STATUS: **v3.1 - APPROVED by user 2026-11-11 ("let's go") after final audit (addenda in section 18). IMPLEMENTATION STARTED.**
Written 2026-11-11 ~18:30 UTC. Deadline **2026-11-14 23:59 UTC** (= 15 Nov 05:29 IST). ~77 h left.
v3 = v2 + full audit fixes (section 0). Old plans archived: PLAN-v1-blackbox-ARCHIVED.md. Chat rule: simple language, one question at a time. Honest docs only.

---

## 0. AUDIT: what v2 was MISSING and where v3 fixes it
| # | Gap found in v2 | Fixed in |
|---|---|---|
| 1 | No per-track end-to-end acceptance test (a track was "claimed" but not provably working) | sec 7 (E2E scenarios per track) |
| 2 | No mandate specification: schema, state machine, partial fills, price floor never met, expiry, cancel mid-run, failed swap, leftover funds | sec 5 |
| 3 | No path to RETURN unspent budget/proceeds to the DAO | sec 5 |
| 4 | Conflict: OutLayer address whitelist is owner-set, but payout addresses change per mandate | sec 5.4 (honest two-layer cage) |
| 5 | No hosting/deployment, storage, secrets plan (agent is a long-running process) | sec 11 |
| 6 | No wallet login / signing flow for council members | F23 |
| 7 | No test strategy (contract, verifier, parser, e2e) and no definition of done per feature | sec 8 |
| 8 | No security plan: prompt injection in the intent parser, sealed-terms key management, API auth, contract access control, secret scanning | sec 9 |
| 9 | No price/benchmark source defined; demo token and payout chains undefined | sec 5.5 |
| 10 | No repo layout, pinned versions, commit/branch policy | sec 12 |
| 11 | No video/X-post/Loops-form/idea-text drafts; no parallel build lanes; no working-hours plan | sec 13, 14 |
| 12 | Tracks Agent Economy, Investment Thesis, Swarms were dropped without trying; Social Money prompt wants reputation-based trust | F13 (trust score), F21, F22, F18 |
| 13 | No testnet/mainnet matrix; no observability/runbook; no Loops-agent usage plan | sec 10, 11, 15 |
| 14 | v2 hour total ignored that calendar time (77 h) < raw work; no parallelism plan | sec 14 |

## 1. The idea
**Quiet Treasury: a DAO votes once on a plain-English "mandate" (e.g. "sell $X of our token over 3 days, not below price Y, then pay these contributors on their own chains"). A sealed-chip agent executes it in hidden chunks, pays out, returns the leftovers, can never exceed the mandate, and publishes a verifiable settlement report.**
Kid version: a club must sell its sticker stash. If it shouts "we're selling everything", the price crashes and others jump ahead. So members vote on a sealed instruction card; a robot with a limited wallet follows it quietly; at the end it posts a receipt proving it stayed inside the card and gives back what it didn't use.

## 2. Problem and honest value
DAOs/foundations/protocol treasuries sell their own token to fund operations; public lumpy sales move the price, get front-run, and the vote itself telegraphs it. NEAR's co-founder proposed a sovereign treasury fund (Aug 2026) so treasury ops are a live NEAR topic. Business value 7/10 (niche buyers; fee on executed volume). Hackathon story 8/10. Trezu (trezu.app) already does DAO payments, bulk pay (100/batch), vesting, Intents pay - we use it for custody/approvals and do NOT rebuild it. We add: AI mandate authoring, bounded private execution, settlement proof.
Competition research (11 Nov): 200+ repos; crowded = agent spend-guards, job boards, games; thin = Social Money (~1), Privacy (~4), Real-World Money (~5). Honest odds (guess): >=1 top-3 ~30-35% if fully working live, ~5-10% if half-built; grand prize ~2-3%.

## 3. Architecture
```
Member types intent -> NEAR AI (TEE) parse -> MANDATE JSON (schema+bounds validated, injection-safe) -> human review/confirm
 -> app builds Sputnik proposals, council signs with NEAR wallets:  P1 FunctionCall mandate.create   P2 Transfer budget -> agent Intents balance
 -> Sputnik vote (tiers) -> MANDATE CONTRACT (own, Rust, Docker build) = on-chain source of truth + state machine
 -> AGENT WORKER (TypeScript, OutLayer wallet keys in TDX) polls chain: approved+funded mandate ->
      loop: randomized chunk -> confidential swap quote -> price-floor check -> confidential swap (idempotent) -> receipt -> record_chunk on chain
      -> payouts (confidential withdraw per contributor chain) -> fee split -> sweep leftovers back to DAO -> settlement
 -> REPORT: totals, avg price vs benchmark, slippage, fees, per-chunk receipts, payouts; AI summary (TEE signed+attested); hash anchored on contract
 -> DASHBOARD (Next.js on Vercel) + AGENT API (read-only, Railway) + VERIFIER (CLI+page)
```
Trust boundaries (README states them): worker is not in a TEE in v0; wallet keys in OutLayer TDX; AI parse/report in NEAR AI TEE; OutLayer team holds admin keys; Defuse/1Click solvers see swap details pre-execution; private shard has no public RPC but operator can read; the DAO funding transfer is PUBLIC (mitigation: routine "operations float" top-ups); wallet-policy owner in v0 = one NEAR account (production = DAO).

## 4. FEATURES (all planned; P0 must ship, P1 next, P2 only after P1; cut order in sec 14)
| # | Feature | Tier | Tracks earned |
|---|---|---|---|
| F1 | Intent -> mandate parser (NEAR AI TEE, JSON schema, bounds, injection defences, human confirm) | P0 | Privacy, Autonomous |
| F2 | Mandate contract + tests (create/cancel DAO-only; progress agent-only; anchor report; full state machine sec 5.2) | P0 | Social, Security |
| F3 | DAO integration: app creates/reads Sputnik proposals+votes, funds agent (Transfer msg), Trezu-compatible DAO | P0 | **Social** |
| F4 | Agent worker: budget/time/token/price enforcement, idempotent, crash-safe resume, cancel-aware | P0 | Autonomous, DeFi |
| F5 | Hidden execution: confidential swaps, randomized size/timing | P0 (fallback B2) | Privacy, DeFi |
| F6 | Payouts to contributors on their own chains + failure retry | P0 | Real-World |
| F7 | Return of leftovers: unspent budget + proceeds remainder sent back to DAO | P0 | Autonomous |
| F8 | Settlement report + AI summary (signed) + on-chain anchor | P0 | Privacy, Autonomous |
| F9 | Verifier CLI+page (attestation nonce, signature recovery, hash checks, chain reads, policy reads) | P0 | Security, Privacy |
| F10 | Dashboard: DAO, Wizard, Votes, Live run, Report | P0 | Social, all |
| F11 | Copycat view (public RPC shows only funding+payouts; `intents.far` UNKNOWN_ACCOUNT; "reconstruct the sale" returns nothing) | P0 | Privacy |
| F12 | Red-team page: 5 real attacks denied (over-budget, wrong token, after expiry, unlisted payout address, non-DAO create_mandate) | P0 | Security |
| F13 | Approval tiers + trust score: small mandate = 1 treasurer, mid = council majority, large = full vote; a treasurer's tier limit rises with past mandates settled with zero violations (reputation tied to named accounts, traceable to settled mandates). Enforced by contract+worker reading proposal votes | P1 | **Social** |
| F14 | Kill switch: DAO `cancel_mandate` stops worker; wallet freeze path if OutLayer API allows | P1 | Autonomous, Security |
| F15 | Sealed mandate mode (hash+budget on-chain; terms visible to council in app; revealed in report; commit-reveal) | P1 | Open, Privacy |
| F16 | Fee split: operator/protocol fee auto-paid from proceeds; contributor revenue share | P1 | Autonomous |
| F17 | CSV export for accountants + public ledger page (every sale/cost/payout) | P1 | Real-World, Autonomous |
| F18 | Execution swarm: coordinator splits slices across K OutLayer sub-agent wallets so chunks cannot be clustered | P2 | Swarms (claim only if shipped+tested) |
| F19 | Judge mode: recorded REAL run in data/demo-run, offline verify, labelled "recorded" | P0 | Execution score |
| F20 | README (machine+human), removal table, trust assumptions, LICENSE | P0 | all |
| F21 | Agent pays for its own market data via x402/PingPay Agent Pay paywall, from fee revenue (agent earns + spends) | P2 | Agent Economy (claim only if shipped; gate G12) |
| F22 | Pre-trade market-impact model from public on-chain/Intents data with re-runnable queries; mandate wizard shows estimated impact; report compares estimate vs realised | P2 | Investment Thesis (claim only if shipped; honest: this is a treasury-impact thesis, not a NEAR price thesis) |
| F23 | Wallet login + signing (near wallet-selector, NEP-413 login) for council actions and sealed-term access | P0 | Social |
| F24 | Ops: structured logs, health endpoint, alert on failed/stuck chunk, runbook (sec 11) | P1 | Execution |
| F25 | Security hardening checklist executed (sec 9) | P0 | Technical |
| F26 | Test suite (sec 8) | P0 | Technical |
| F27 | Submission assets: video, X post, Loops/nearhackathon forms (sec 13) | P0 | all |

Tracks NOT claimed: **Games, NFTs, Memecoins** - brutal reason: no feature earns them honestly; bolting on a gimmick NFT/game would lower Innovation and Track-Fit scores and credibility with the human judges. If you disagree, the cheapest honest option is a NEP-171 "treasurer credential" NFT (access right gating F13 tiers) as a P2 add - tell me and I add it as F28.

## 5. MANDATE SPEC (the core object)
### 5.1 Schema (JSON, validated by zod + contract)
`id, dao, creator, sell_token, buy_token, max_sell_amount, min_price (buy per sell, floor), start_ts, end_ts, chunk_min, chunk_max, interval_min_s, interval_max_s, jitter_seed_hash, payouts[{label, chain, address, token, amount|percent}], fee_bps, fee_recipient, return_to (default dao), sealed (bool), terms_hash, tier, status, proposal_ids[]`
### 5.2 State machine
`Draft -> Proposed -> Approved -> Funded -> Executing -> {Settling -> Completed | Cancelled | Expired | Failed}`; contract rejects illegal transitions; only DAO may Cancel; only registered agent account may record progress; Expired when end_ts passes: worker stops, settles, returns leftovers.
### 5.3 Edge cases (each has a test)
partial fills; price floor never met (no trade, report says so, funds returned at expiry); swap refunded by solver (retry with new idempotency key, count against budget only on success); payout fails (retry N times, surface "needs human", never silently skip); cancel mid-run (stop, settle done chunks, return rest); worker crash (resume from on-chain record_chunk + OutLayer request ids); duplicate chunk (idempotency key = mandate id + chunk index); budget exhausted; insufficient liquidity quote; clock skew (use chain time).
### 5.4 The cage is TWO layers (honest)
Layer A = OutLayer wallet policy (enforced inside enclave): per-tx and daily caps, allowed tokens, rate limit. Layer B = mandate contract + worker (destinations restricted to payout list + DAO return address). OutLayer's address whitelist is owner-set and cannot change per mandate unless the owner updates it; gate G13 checks whether policy can be updated programmatically by the owner key. If yes, worker requests a policy update per mandate (still owner-signed); if no, Layer B enforces destinations and README says so. The red-team page labels which layer blocked each attack.
### 5.5 Demo economics
Sell token: wNEAR held by the DAO (we hold real NEAR; no fake "DAO token"). Buy: USDC. Budget ~$20-30 real. Benchmark = 1Click dry quotes at each chunk + public price history (Binance klines) for TWAP/VWAP comparison; both recorded in report with source tags. Payout chains: Solana and Base addresses controlled by us (named as "contributor wallets"). Fee: 0.5% demo value. Claims: we do NOT claim profit or price improvement beyond what the report measures; at this size the market impact is ~0 and the report says so honestly (we show mechanics, and F22 estimates impact for realistic sizes).

## 6. Mainnet / testnet matrix
| Component | Dev/rehearsal | Final demo |
|---|---|---|
| Sputnik DAO + mandate contract + proposals | testnet (free) | **mainnet** |
| NEAR AI Cloud | mainnet API (credits) | same |
| OutLayer wallet, confidential swaps, withdraws | mainnet only (Intents has no testnet) tiny amounts | mainnet |
| Dashboard/agent API | local | Vercel + Railway |

## 7. END-TO-END ACCEPTANCE per TRACK (a claimed track must pass its scenario on the final run)
| Track | Scenario that must pass live | Evidence captured |
|---|---|---|
| Social Money | create mandate from app -> 2+ council wallets vote on real Sputnik proposals -> tier logic visibly changes the required approvals for small vs large -> worker refuses to act before approval -> DAO cancel stops it -> trust score updates after settlement | proposal ids, tx hashes, screenshots |
| Autonomous Business | after the vote ZERO human actions until report; worker survives a forced restart; kill switch works; fee split paid; ledger page matches chain | logs, tx hashes, ledger |
| Privacy & Private AI | parse + report inference with attestation panel green; swaps via confidential path; copycat view empty; sealed mandate reveal hash matches | attestation JSON, hash check output |
| Real-World Money | contributor receives USDC on Solana AND Base; CSV opens with correct totals; every payout status shown with explorer link | dest-chain tx hashes, CSV |
| AI Security & Defense | 5 attacks denied with real error codes; verifier green; layer (A or B) labelled | request ids, outputs |
| Unstoppable DeFi | cross-chain execution via Intents, realised price >= floor on every chunk, no human custody of funds at any step | quotes vs fills |
| Open Innovation | sealed-mandate commit-reveal verified by independent script | verifier output |
| Swarms (if F18) | K sub-wallets each execute slices; clustering demo shows no single-wallet link | sub-wallet ids |
| Agent Economy (if F21) | agent pays a real paywalled data call from its own earned fee | payment receipt |
| Investment Thesis (if F22) | impact model re-runs from committed queries; estimate vs realised shown | query files, outputs |
Any track whose scenario fails by Sat 06:00 UTC is REMOVED from the submission (no false claims).

## 8. TEST STRATEGY and DEFINITION OF DONE
Unit: contract (every state transition, access control, edge cases in 5.3), mandate schema, parser validation incl. injection samples, verifier (good + tampered inputs), chunk planner (bounds, randomness), report math. Integration: testnet DAO+contract script, OutLayer client against real API with tiny amounts, NEAR AI parse + signature recovery. E2E: `npm run e2e` runs the full flow (testnet governance + mainnet tiny execution) and writes data/demo-run. Done = code merged, test passes, UI shows real data with source tag (chain|api|recorded), README step exists, committed.
No-fake rule: a test greps UI/data for hard-coded balances/prices; every number must carry a source tag.

## 9. SECURITY PLAN
Prompt injection: parser output is only a PROPOSAL, validated by schema + hard bounds (max budget, allowed tokens list, max duration, payout sum = 100%/<= budget), diffed against the user's text, and requires human confirm + DAO vote; the AI never holds keys. Sealed terms: encrypted at rest (AES-GCM, key in server env), readable only by NEP-413-authenticated council members. API: read-only public endpoints, council endpoints need signed NEP-413 login, rate limits, input validation. Contract: access control tests, no unbounded loops, storage costs bounded. Secrets: .env + .gitignore, gitleaks scan before every push, rotate wk_/API keys after demo, never in chat. Funds: demo money only; no outside investor funds; README "not investment advice".

## 10. Loops House agent plan
After user login: `loops knowledge query` (1 credit each) for Sputnik/Trezu/OutLayer/Intents integration questions (list kept in docs/questions.md), `loops ideate` once to sanity-check the pitch, `loops evaluate` per claimed sponsor/track on Sat 06:00-12:00 UTC and fix flagged gaps, `loops project fields/create` drafts shown to user before `--confirm`.

## 11. HOSTING, STORAGE, OPS
Dashboard: Next.js on Vercel (install `npm i -g vercel`, user login). Agent worker + read-only API: Railway (personal account, Dockerfile, volume for SQLite) - fallback: run worker locally during demo and keep recorded run. State: SQLite (receipts, sealed terms encrypted, chunk log) + chain as source of truth. RPC: FastNEAR/public list with fallback. Observability (F24): JSON logs, /health, alert (Telegram or log file) on stuck chunk, runbook in docs/RUNBOOK.md (restart, replay, cancel). Keep hosted demo alive until 25 Nov.

## 12. Repo layout, versions, git policy
```
near/  README.md LICENSE(MIT) PLAN.md .env.example .gitignore
  contracts/mandate/        Rust contract + tests (Docker build script)
  src/near/{ai,outlayer,sputnik,intents,mandate,wallet}.ts   (greppable integrations)
  src/engine/{parser,planner,executor,settlement,benchmark}.ts
  src/verify/               attestation, signatures, hashes, chain reads
  app/                      Next.js dashboard (DAO, Wizard, Votes, Live, Copycat, Red-team, Report, Verify, Ledger)
  worker/                   agent worker + API
  data/demo-run/            recorded REAL run   docs/ RUNBOOK.md questions.md
  tests/ scripts/
```
Pin dependency versions. Commit small and often with meaningful messages (rubric rewards git activity). Repo public from first commit; branches per lane merged via PR-like commits; secrets scan pre-push.

## 13. Submission assets (all drafted before Sat 12:00 UTC)
Video 2:00 storyboard: 0:00 sticker problem -> 0:15 type intent -> 0:30 mandate + real Sputnik vote (two wallets) -> 0:55 agent runs live, restart survives -> 1:15 copycat empty + red-team denied -> 1:35 payouts on Solana/Base + report + verify ticks -> 1:50 real vs roadmap. Record with OBS/screen recorder, captions burned in; user records, I write script + shot list. X post: says "built at NEAR HACKATHON", tags @NEARProtocol, #NEARHackathon, video attached, leads with the user problem, concrete NEAR role. nearhackathon.com fields: projectName, leadName, email, size, tracks[], nearAddress (mainnet), projectUrl (repo), demoUrl (X post), idea <=2000 chars (draft in docs/submission.md), submitted ONCE. Loops House: name, tagline, pitch, description, repoUrl, demoUrl, videoUrl, bountyIds, team size, NEAR wallet, demo post link; draft shown, `--confirm` only after user yes. Open U6: confirm whether both systems are needed (ask NEAR Discord/Loops).

## 14. SCHEDULE, PARALLEL LANES, CUT ORDER
Honest capacity: raw P0+P1 work is more than 77 h for one person. Plan: Claude Code runs **parallel lanes** (separate subagents/worktrees) - Lane A contract+DAO (F2,F3,F23), Lane B agent worker+OutLayer+Intents (F4-F7,F16), Lane C AI+verifier+report (F1,F8,F9), Lane D dashboard+copycat+red-team+ledger (F10-F12,F17), Lane E tests+docs+ops (F19,F20,F24-F27). User time = tasks in sec 15 + 3 daily check-ins.
| When (UTC) | Work |
|---|---|
| Wed 11 evening | approve; G0 Docker; scaffold public repo; testnet DAO (G1); keys in .env; Loops login |
| Thu 12 00:00-06:00 | G2, G4, G13; lanes A-C start. **06:00 = GO/NO-GO on DAO path (B1)** |
| Thu 12 06:00-18:00 | G3 mainnet funding, G5/G6 real swap + payout (needs money); worker end-to-end; lane D UI |
| Fri 13 | P0 complete; P1 features; **12:00 UTC P1 checkpoint**; night: G8 full real run recorded |
| Sat 14 00:00-06:00 | bug-fix only; **code freeze 06:00** |
| Sat 06:00-12:00 | per-track E2E check (sec 7), remove failing claims, `loops evaluate`, G9 clean clone, record video |
| Sat by 18:00 | submit everywhere; hard deadline 23:59 |
P2 (F18, F21, F22) start only after P1 checkpoint passes. Cut order if late: F21 -> F22 -> F18 -> F24 -> F17 -> F16 -> F15 -> F14 -> F13. P0 never cut.

## 15. Gates, money, user tasks
Gates: G0 Docker builds contract | G1 testnet DAO proposal flow from app | G2 mandate contract: DAO-only create, non-DAO rejected | G3 mainnet DAO Transfer-with-msg funds agent Intents balance | G4 NEAR AI parse + signature recovers to attested signer | G5 real confidential swap settles | G6 real confidential withdraw pays on another chain | G7 5 attacks denied | G8 full e2e run recorded | G9 fresh clone `npm i && npm run verify` green | G10 restart-survival test | G11 sweep leftovers back to DAO | G12 x402/PingPay paid call (F21) | G13 OutLayer policy updatable programmatically? | G14 per-track scenarios (sec 7).
Money: ~12 NEAR (mainnet DAO + contract; exact DAO cost unknown until tested) + ~$25-30 float + gas ~ $70-80 total; testnet free; less money = smaller float / dry quotes + recorded run, labelled.
User tasks (one at a time): 1 start Docker Desktop; 2 NEAR wallet(s) (two for tier demo); 3 NEAR Builders -> $10 AI credits -> .env; 4 `! npx loopshouse auth login --provider google`; 5 fund mainnet after G1-G4; 6 Vercel + Railway personal logins; 7 X account + record video; 8 final yes before any submit.

## 16. Backup plans
B1 (DAO custom path fails by Thu 06:00): drop our contract; plain Sputnik/Trezu proposals, mandate JSON in proposal description (hash-checked), worker reads `get_proposal`. B2 (confidential swap fails): public Intents swaps in randomized chunks, remove hidden claims. B3 (Transfer-msg funding fails): DAO Transfer to agent NEAR account, agent deposits to Intents. B4 (time): cut order sec 14. B5 (NEAR AI outage): second TEE model / typed-JSON form. B6 (Railway fails): run worker locally + recorded run. B7 (policy not programmable, G13): Layer B only, honest copy.

## 17. LOCKS (need user approval)
| Lock | Decision | Status |
|---|---|---|
| L1 | Idea = Quiet Treasury; Social Money main target | APPROVED 2026-11-11 |
| L2 | Tracks: Social, Autonomous, Privacy, Real-World, Security, DeFi, Open (+Swarms, Agent Economy, Thesis only if P2 ships and scenario passes); NOT Games/NFTs/Memecoins (F28 option) | APPROVED 2026-11-11 |
| L3 | Features F1-F27 + mandate spec (sec 4-5) | APPROVED 2026-11-11 |
| L4 | Per-track E2E acceptance + remove-if-failing rule (sec 7) | APPROVED 2026-11-11 |
| L5 | Architecture, hosting, security, tests, repo (sec 3, 8, 9, 11, 12) | APPROVED 2026-11-11 |
| L6 | Schedule, parallel lanes, gates, GO/NO-GO, freeze, cut order, backups (sec 14-16) | APPROVED 2026-11-11 |
| L7 | Money ~$70-80 and user tasks (sec 15) | APPROVED 2026-11-11 |
| L8 | Honesty rules + nothing submitted without user yes | APPROVED 2026-11-11 |


## 18. FINAL AUDIT ADDENDA (pass 3, 2026-11-11) - last gaps found and closed
| # | Gap | Resolution |
|---|---|---|
| 1 | No NEAR CLI on PC | use JS libs (`near-api-js` / `@near-js/*`) in scripts; no near-cli needed |
| 2 | How testnet accounts get created/funded | scripts/create-accounts.ts: generate ed25519 keypairs we control (council-1..3, agent-owner, contributors); fund via testnet faucet/helper; if faucet fails, fund from one account created via the official testnet helper; fallback = ask user to create one testnet account at a wallet and fund the rest |
| 3 | Demo council voters | 3 test council accounts we control (labelled "demo council" in UI/README, not impersonating real people); user's real wallet = prize address + treasurer role |
| 4 | Team size / identity fields | solo (team size 1) unless user says otherwise; email = user's choice at submit time (asked then, never guessed) |
| 5 | Repo must be its own git repo, public, pushed via user's personal GitHub | `git init` inside near/ (it sits under another repo); local git identity from memory; creating the GitHub repo + push needs the user's personal SSH alias; ask user once when first push is needed |
| 6 | Docker Desktop not running | start it from the script; if it needs the user (first-run/WSL), ask the user once |
| 7 | Responsive/mobile + empty/error/loading states in UI | part of F10 definition of done |
| 8 | Final-day collisions: video recording, forms, deploy all on Sat | video script + shot list finished Fri night; deploy dry-run Fri; Sat is verification only |
| 9 | Loops login still needed for knowledge/evaluate | user task #4; until then use official docs directly |
| 10 | Claims vs reality at submit time | a `docs/CLAIMS.md` table: every claim in README/video -> evidence file/tx; anything without evidence is deleted before submit |
Audit verdict: no remaining unplanned feature, track, gate, or deliverable. Known unknowns are the listed gates (G0-G14); each has a backup (sec 16).
