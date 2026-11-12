# SUBMISSION KIT - Quiet Treasury (ready-to-paste; honest; update the `PLACEHOLDER`s)

Deadline **2026-11-14 23:59 UTC** (15 Nov 05:29 IST). Target: submitted by **18:00 UTC** (23:30 IST). Nothing below is submitted anywhere yet.
Rule of this file: every claim points to an evidence file. A track whose end-to-end scenario (PLAN.md section 7) has not passed on the final run is NOT claimed.

---
## 0. TRACK CLAIMS (decide at Sat 14 Nov 06:00 UTC; edit this table first)

| Track id | Claim today? | Scenario status (PLAN.md sec 7) | Evidence | What must land to claim |
|---|---|---|---|---|
| `social` | **YES** | PASSED via scripts on public testnet: real Sputnik proposals + 2-of-3 votes create the mandate; no execution before the vote; DAO cancel stops it; trust score updates (trust=3). NOT browser-verified: wallet-signed proposal creation from the dashboard wizard | `data/demo-run/run.json` (`txs`, `results`), `scripts/testnet/dao-flow.ts` (8/8), `worker/guards.ts` (tier rule) + `tests/worker` | (optional upgrades) near.social reputation posts + named-account identities in UI (lane S) |
| `business` | **YES** | PASSED on testnet: after the vote no human action until the anchored report (20/20); kill switch = DAO cancel (worker stops within a tick). Fee split + payouts are SIMULATED; restart survival is covered by unit tests / sandbox e2e, not the testnet run | `data/demo-run/run.json` (`results`, `cancelRun`), `scripts/testnet/e2e.ts`, `scripts/sandbox/worker-e2e.ts` | real native funding/payout transfers (lane R) would make fee split real |
| `security` | **YES** | PASSED: 6 real attacks blocked, each naming its layer (A = OutLayer wallet policy: real 403 `policy_denied` for unlisted address and over-cap, B = executor guards + contract); independent verifier 13/13. Layer A tested on native transfers only | `data/demo-run/run.json` (`redteam`), `data/testnet-layer-a.json`, `src/verify/cli.ts data/demo-run/proof-bundle.json` | - |
| `privacy` | **NOT YET** | PARTIAL: TEE parse + signed settlement summary + attestation panel verified live; confidential swaps NOT run (simulated); sealed-mandate reveal NOT in the recorded run | `scripts/g4-check.ts`, `docs/CLAIMS.md` | sealed mandate commit-reveal in the recorded run (F15). Do not claim "hidden trades" |
| `realworld` | **NOT YET** | NOT PASSED: no contributor received funds (payouts simulated); PLAN scenario (USDC on Solana AND Base) cannot pass on testnet | `docs/CLAIMS.md` | lane R real testnet payouts + CSV, AND the user accepts the weaker scenario (real testnet payouts to named accounts) |
| `defi` | **NOT YET** | NOT PASSED: no real swap (Intents mainnet-only) | `docs/CLAIMS.md` | real swap execution (lane R real Ref Finance testnet swap) or one tiny real mainnet run. If only Ref: say "NEAR testnet DEX", never "Intents" |
| `open` | **NOT YET** | NOT PASSED: sealed-mandate reveal verifier not demonstrated | - | F15 reveal check run by an independent script |

**Team overlap check:** `docs/TEAM-KIT.md` (draft) gives Security/DeFi to product P2 and Open to P5. Confirm with the team before ticking those tracks, or two team products compete in one track.
**Not claimed on purpose:** swarms, agent, thesis, games, nfts, memecoins.

---
## 1. nearhackathon.com form (`POST /api/applications` or https://nearhackathon.com/#apply) - submit ONCE

| Field | Value |
|---|---|
| `projectName` | `Quiet Treasury` |
| `leadName` | `PLACEHOLDER` (2-80 chars; Loops shows the profile name "Tanmay Gupta" - confirm) |
| `email` | `PLACEHOLDER` (user chooses; max 2 submissions per email) |
| `size` | `PLACEHOLDER` (one of `1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+`) |
| `tracks` | `["social","business","security"]` today; add per section 0 |
| `nearAddress` | `PLACEHOLDER` NEAR **mainnet** account for the prize (2-64 lowercase chars). Team plan: the team DAO |
| `projectUrl` | `PLACEHOLDER` public GitHub repo URL (unique per repo, max 300) |
| `demoUrl` | `PLACEHOLDER` public X post URL with the video |
| `consent` | `true` only after the human reads the contact notice |
| `idea` | text below (20-2000 chars) |

### `idea` text (paste as is; update the bracketed swaps if lanes land)
```
Quiet Treasury lets a DAO approve one plain-English mandate (token, budget, price floor, time window, payouts) and nothing else; an agent then carries it out inside hard limits and publishes a verifiable settlement report. Problem: DAOs sell their own token to fund operations, public lumpy sales move the price and the vote itself telegraphs the trade.

How it works: a NEAR AI Cloud TEE model drafts the mandate (answers are signed and attested; code re-validates every bound, the AI never holds keys). Two of three council votes on a real Sputnik DAO create it on our Rust Mandate contract: only the DAO can create/cancel, only the agent can record progress, budget and window are enforced on-chain, chunks are idempotent, treasurers earn an on-chain trust score. A worker executes randomized chunks with a price floor on each, pays contributors, returns leftovers to the DAO and anchors the report hash on-chain. A DAO cancel proposal stops it within one tick. OutLayer wallet policy, set programmatically by an owner key, returns real 403 policy_denied for unlisted addresses and over-cap transfers; six red-team attacks are blocked and each names the layer that blocked it. Anyone can verify the run (signature recovery, attestation nonce, hash checks: 13/13).

What is real vs simulated: all of the above runs on public NEAR testnet (explorer links in data/demo-run/run.json). NEAR Intents exists only on mainnet, so swap fills, payouts and the DAO funding transfer in that run are SIMULATED (priced from real read-only 1Click quotes, tagged "simulated" in report, CSV, API and UI). The live OutLayer confidential-swap path is implemented but has never been run with real money. Unaudited; not investment advice.

Try it: npm install; npx vitest run (70 tests); npx tsx src/verify/cli.ts data/demo-run/proof-bundle.json.
```
(Length: run `npx tsx scripts/dev/count-chars.ts docs/submission.md` is not needed; measured at authoring time, see section 6.)

---
## 2. Loops House form (`loops project create --event near-hackathon ...`)
Always run the command WITHOUT `--confirm` first; show the draft to the user; add `--confirm` only after a clear yes.

| Field | Value |
|---|---|
| name | `Quiet Treasury` |
| tagline | `A DAO votes once; a bounded agent sells quietly and proves it stayed inside the vote.` |
| pitch | `DAOs that sell their own token in public get front-run and the vote telegraphs the trade. Quiet Treasury turns one plain-English DAO vote into a bounded, verifiable execution: NEAR AI (TEE) drafts the mandate, Sputnik DAO approves it, our Mandate contract enforces it, an agent executes inside an OutLayer wallet policy, and anyone can verify the settlement report.` |
| description | the `idea` text above (Loops asks for a detailed write-up) + the README "How it works" section |
| repoUrl | `PLACEHOLDER` |
| demoUrl | `PLACEHOLDER` (hosted demo is a bonus; keep it alive to 25 Nov) |
| screenshots | `PLACEHOLDER` at least one: capture `/votes`, `/report`, `/verify` from the dashboard |
| Team size (extra, required) | `PLACEHOLDER` (`1`, `2-4`, `4-6`, `6-8`, `8+`) |
| NEAR wallet address (extra, required) | `PLACEHOLDER` user's own mainnet wallet or the team DAO |
| Demo post link (extra, required) | `PLACEHOLDER` public X post |
| bounties | per-track bounty ids come from `loops bounties --event near-hackathon` (the event skill lists 1st-place ids: social-money `07970ccd-f4b4-479f-9ebe-8c14e87aa0d2`, autonomous-business `23793023-5170-48e1-9404-8c9241edb5e3`, ai-security-defense `b3662bb5-e295-497a-8495-d904db7c76d9`, privacy `31122832-489c-41b5-bc9d-99e85f3057b2`, real-world-money `0d46663b-215e-47cc-872c-35db6e249a6a`, unstoppable-defi `652d6afc-2999-4c0f-9d18-39c1f4b6bb85`, open-innovation `46a90bf6-944a-4934-86b6-e4ced6f47a98`). **Verify the ids and ask the user which tracks to select; never choose for them.** |

Command skeleton (draft only):
```
npx loopshouse project create --event near-hackathon --name "Quiet Treasury" --tagline "<tagline>" --repoUrl <url> \
  --description "<description>" --demoUrl <url> --answer "Team size=<v>" --answer "NEAR wallet address=<v>" --answer "Demo post link=<url>" --bountyIds <id> --bountyIds <id>
npx loopshouse evaluate --event near-hackathon --sponsor <slug>      # run per claimed track, fix flags, then re-run
```

---
## 3. X post (video attached; lead with the problem)
**Main post** (short):
```
When a DAO sells its token in public, the price drops and the vote tells everyone.

Quiet Treasury: vote once on a plain-English mandate. A NEAR AI TEE drafts it, Sputnik DAO approves, a bounded agent executes and proves it.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
```
(attach the video; keep the repo link in the reply so the main post stays under 280 characters)
**Reply (honesty + how to run)**:
```
Real on NEAR testnet: AI-signed parsing, Sputnik DAO votes, our Mandate contract, OutLayer wallet-policy denials, anchored report + verifier (13/13).
Simulated (Intents is mainnet-only): swap fills, payouts, DAO funding. Tagged "simulated" everywhere. Repo: [URL]
```
Optional tags: @NearLegion @NearBuilders. Must stay public. The post link goes in `demoUrl` / Loops "Demo post link".

---
## 4. 2-minute video - one take (screen record 1920x1080, dashboard in dark mode)
**Pre-flight (5 min before):** `powershell scripts\dev\start-testnet.ps1` -> http://localhost:3100. Open every page once so Next.js has compiled it. Click "Parse with private AI" once to warm the model. Check `http://localhost:8787/health` is `ok:true`. Close other tabs, browser zoom 110%, hide bookmarks. Mandate #5 (Completed) is the default on `/live`, `/report`, `/verify`.

| Time | Screen / click | Say (voice-over) |
|---|---|---|
| 0:00-0:15 | `/` DAO overview | "When a DAO sells its own token in public, the price drops and the vote tells everyone. Quiet Treasury lets the DAO approve one mandate and nothing else." |
| 0:15-0:35 | `/wizard` -> click **Parse with private AI** on the pre-filled intent; the elapsed timer runs; Review table appears | "I type a plain-English instruction. A NEAR AI TEE model drafts structured terms, and code re-checks every bound. The AI never holds keys." |
| 0:35-0:55 | `/votes` -> scroll the proposal list (Approved 2/0), point at a vote | "Every mandate is a real Sputnik DAO proposal. Two of three council members voted; nothing executes before that." |
| 0:55-1:15 | `/live` (mandate #5): chunks timeline with `recorded` / `simulated` tags | "The agent trades in randomized chunks, each with a price floor, recorded on our contract. On testnet the fills are simulated, because Intents only exists on mainnet, and they are labelled everywhere." |
| 1:15-1:35 | `/redteam` -> click **Run attack** on "Create a mandate without a DAO vote" and "Swap into a token outside the mandate" | "Real attacks, real answers: blocked by the contract and the executor. Our OutLayer wallet policy also returned real 403s for an unlisted address and an over-cap transfer." |
| 1:35-1:50 | `/report` (mandate #5): AI summary, anchored hash; click the CSV download; then `/verify` -> **Run live attestation check** | "The report hash is anchored on chain and the AI summary is signed. Anyone can re-verify it: 13 of 13 checks." |
| 1:50-2:00 | `/` or the GitHub repo page | "Real: DAO votes, contract, AI signatures, wallet policy. Simulated: swaps. Not yet proven: live mainnet trades. Repo link below." |

**60-second fallback** (if parse is slow or anything breaks): `/votes` (0:00-0:15) -> `/redteam` run one attack (0:15-0:30) -> `/report` + `/verify` (0:30-0:50) -> say the real / simulated / unproven line (0:50-1:00).
Recording tips: do not click Approve/Reject on open proposals; do not show `.env` or data/secret; say "simulated" out loud at least once.

---
## 5. Submission checklist
- [ ] Public GitHub repo (see section 7) with LICENSE, README, `data/demo-run`; `npx tsx scripts/dev/secret-scan.ts` shows 0 hits
- [ ] README lists libraries/templates; names other team projects (rule: each README names the others; no shared code)
- [ ] Per-track scenario re-checked on Sat 06:00 UTC; failing tracks removed from `tracks` and from the README header
- [ ] `docs/CLAIMS.md` has no claim without evidence; swap/payout rows still say SIMULATED/UNVERIFIED unless a real run exists
- [ ] Clean-clone check green: `powershell scripts\dev\clean-clone-check.ps1`
- [ ] Video recorded (<= 2 min) + X post public with video, `built at NEAR HACKATHON`, `@NEARProtocol`, `#NEARHackathon`
- [ ] Hosted demo (optional bonus): `docs/DEPLOY.md`; keep alive to 25 Nov
- [ ] **U6 (OPEN):** confirm whether BOTH nearhackathon.com (official form/API) AND Loops House (`loops project create`) submissions are required. HACKATHON.md describes only nearhackathon.com; the Loops skill has its own project form with the same three required items. Ask in the NEAR Discord / Loops support before Sat; if unsure, do both (they are separate systems; nearhackathon.com must be submitted exactly once per repo, fixes via /request-changes)
- [ ] nearhackathon.com submitted ONCE (409 if repo/email reused); Loops draft shown to the user, `--confirm` only after a yes
- [ ] Payout address is a NEAR **mainnet** account (team DAO or user's wallet) - confirm it exists and the key is safe
- [ ] Prize split agreement written down (docs/TEAM-KIT.md section 4)

## 6. Length limits (measured 2026-11-12)
- `idea` text: **1827** characters (limit 20-2000). Re-measure after any edit: nearhackathon.com returns 400 above 2000.
- X main post: 278 characters without a link (limit 280; links count about 24 more, so keep the repo link in the reply); the reply is 263.
- Loops tagline: 85 characters.

## 7. Repo publishing (user action; nothing was pushed or created)
- SSH alias `github-personal` authenticates as GitHub user `tannmayygupta` (personal). `github-work` also exists - never use it. `git@github.com` default key is denied.
- `gh` is logged in only as `developer-cybersmith` (work, active) and `aniruddha1295` - neither is the personal account. Do NOT use `gh repo create` here.
- Plan: user creates an empty PUBLIC repo `quiet-treasury` on github.com while signed in as `tannmayygupta`, then:
  `git remote add origin git@github-personal:tannmayygupta/quiet-treasury.git` -> `git push -u origin main` (run secret-scan first; `.env`, `data/secret`, `.claude` are git-ignored).
