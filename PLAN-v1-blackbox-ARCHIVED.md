# PLAN.md - Black Box Fund (NEAR HACKATHON)

STATUS: **DRAFT v1 - AWAITING USER APPROVAL. No project code is written until the locks in section 15 are approved.**
Written: 2026-11-11 ~15:15 UTC. Deadline: **2026-11-14 23:59 UTC** (= 15 Nov 05:29 IST). Time left at writing: ~80 hours.
Chat rule: simple 15-year-old language, one question at a time. Honest docs only (AI judges run the repo).

---

## 0. What is already PROVEN vs NOT YET PROVEN (my own tests, 2026-11-11)

| # | Fact | Status | How I know |
|---|---|---|---|
| F1 | Official scoring: Technical 30 / Innovation 25 / Sponsor-Track Fit 25 / Execution & Completeness 20 | PROVEN | Loops House skill (`near-hackathon`) |
| F2 | AI judges screen (run it, match README), humans decide; AI also greps repo to confirm sponsor tools are really used | PROVEN | HACKATHON.md Q-017 + rubric text |
| F3 | A brand-new unfunded OutLayer wallet gets `confidential/swap/quote` and `confidential/balance` with HTTP 200 (no invite, no 503) | PROVEN (quote only) | real call, 10 USDC -> ~2.66 NEAR, ~12 s |
| F4 | NEAR AI Cloud attestation works with NO key: fresh nonce echoed, Intel TDX quote + NVIDIA payload present | PROVEN | real call |
| F5 | 1Click `confidentiality: basic` directly needs user auth (401) | PROVEN - so we use OutLayer's confidential endpoints instead, not raw 1Click | real call |
| F6 | Intents has no testnet; real trades = real (tiny) mainnet money | PROVEN | HACKATHON.md Q-007 |
| F7 | Shade Agent Framework is deprecated; OutLayer is on the hackathon's recommended list | PROVEN | NEAR docs + HACKATHON.md |
| F8 | Rust/cargo/near-cli NOT installed on this PC; Node 24, git, gh are | PROVEN | local check |
| U1 | A REAL confidential swap with real money settles and shows `swap_details` | NOT YET - **OutLayer's own docs say internal confidential swap/transfer is "inferred by protocol symmetry, not yet exercised live"; only SHIELD and cross-chain deposit/withdraw were verified on mainnet. THIS IS THE HINGE RISK.** | Gate G3 (run FIRST) |
| U7 | OutLayer free tier = 1000 custody operations per wallet per rolling 24h (quotes and dry-runs count). Not a funds limit | PROVEN (docs) | fine for us, budget calls |
| U2 | OutLayer "custody ceiling" (docs mention it) - does it limit us? | NOT YET | Gate G2 |
| U3 | Policy can be set so attack calls return `policy_denied` (403) on confidential endpoints | docs say yes, NOT YET tested | Gate G5 |
| U4 | `social.near` (NEAR Social DB) still accepts `set` from the fund wallet via `/call` for on-chain anchoring | NOT YET | Gate G6 |
| U5 | Intel TDX quote can be verified locally with `@phala/dcap-qvl` (needs Intel collateral fetch) | NOT YET | Gate G4 |
| U6 | Two submission systems (nearhackathon.com form/API AND Loops House `loops project create`) - are both needed? | UNKNOWN | ask organizers/Discord before submitting |

Known honest limits (go in README "Trust assumptions"): (a) Defuse/1Click solvers see swap details before execution; (b) OutLayer team still holds governance/admin keys today; (c) TEE = trust Intel/NVIDIA; (d) the fund's policy owner is a single NEAR account in v0 (production: DAO); (e) confidential entry/exit are visible, only in-shard trades are hidden; (f) the private shard has no public RPC but its operator can read it.

---

## 1. The idea in one sentence

**Black Box Fund: an AI-run fund whose trading recipe stays secret, but anyone can check that (1) nobody can steal the money, (2) the trades are hidden from copycats, and (3) after the recipe is revealed later, every trade provably came from exactly that recipe.**

For a 15-year-old: a chef keeps a secret recipe in a locked glass box. You cannot read it, but you can see the box is sealed, the chef cannot reach into the till, and every dish comes with a receipt stamped by a sealed oven. On "Reveal Day" the box opens and you can check each receipt matches the recipe.

Motto: **Seal -> Trade -> Reveal -> Verify.**

## 2. The problem (and why today's tools fail)

- A trading strategy is only worth money while it is secret. If it is public, others copy and front-run it.
- But investors will not give money to a secret they cannot check ("trust me" = rug risk).
- The AI that reads the secret recipe is itself a leak: normal AI companies can read every prompt you send.
- Trades on normal DEXs are public, so copycats can rebuild the secret from the trade history.

No single existing tool fixes all four. Each of our NEAR pieces fixes exactly one (section 4).

## 3. How it works - the five locks

1. **Sealed brain** - the recipe is sent only to a NEAR AI Cloud TEE model (private inference). Each answer is signed by the chip.
2. **Sealed hands** - the fund's wallet is an OutLayer agent wallet: keys come from NEAR's MPC network into an Intel TDX chip; a policy (caps, allowed tokens, allowed destinations, freeze) is enforced inside the enclave. The brain server never holds a key.
3. **Hidden moves** - trades are done as confidential swaps on NEAR's private shard (`intents.far`). Strongest-privacy path from OutLayer's own docs: fund via cross-chain deposit -> trade inside the shard -> exit via cross-chain withdraw (avoid shield/unshield).
4. **Receipts** - every decision produces a receipt: NEAR AI signature (covers hash of the exact request + response), OutLayer request id / intent hash, NAV statement signed by the fund wallet, all anchored on NEAR mainnet.
5. **Commit and reveal** - at launch we publish `commit = sha256(salt || recipe)` on-chain. On Reveal Day we publish salt + recipe + the exact request bodies. Anyone recomputes: (a) commit matches, (b) each request-body hash equals the `request_hash` the chip signed. That proves the signed decisions came from that recipe.

## 4. Why each NEAR piece is irreplaceable ("remove it and X breaks")

| Piece | The one problem only it fixes here | If we remove it | Closest alternative and why it falls short (honest) |
|---|---|---|---|
| NEAR AI Cloud (TEE inference + signed answers) | The AI must read a secret recipe without the AI company seeing it, and prove which request produced which answer | Recipe goes to a normal API (provider can read it) and there is nothing for investors to verify | OpenAI/Anthropic: provider sees prompts, no proof. Self-hosted model: nothing verifiable to outsiders. Other TEE-AI services exist, but none sits in the same stack as the wallet and the private shard |
| OutLayer wallet (MPC keys in TDX + policy) | Autonomy without a person who can steal: AI can trade, cannot withdraw outside the cage | Keys sit on our server = operator can rug | Multisig: a human must sign every trade (not autonomous). Hot wallet / Privy / Turnkey: company-run policy, no on-chain policy or enclave proof |
| Confidential Intents (private shard, via OutLayer) | Copycats must not rebuild the recipe from public trades | Every trade is public on a normal chain, recipe leaks within days | Public DEX/CEX: public or custodial. Zcash-style: not a multi-asset cross-chain trading venue |
| Intents cross-chain deposit/withdraw | Investor holds USDC on any chain, no bridge UI | Single-chain only | Bridges: extra hops and risk |
| Commit-reveal anchored on NEAR | Proof the secret recipe was fixed before trading | "Trust me, that was our recipe" | Plain database: can be rewritten |

README must say "the only way in this stack", never "the only thing in the world", and must list the closest alternatives. (Rule: no overclaiming.)

## 5. Track coverage (we do NOT target all 13)

| Track | Why we honestly belong | What the judge sees in the repo |
|---|---|---|
| **Privacy & Private AI** (core) | Private inference + private trades + attestation panel ("Verified") | `src/near/ai.ts`, attestation verifier, copycat view |
| **AI Security & Defense** (core) | Cage + policy + red-team demo: attack calls really return `policy_denied` | `src/near/outlayer.ts`, `redteam` page, policy JSON |
| **Unstoppable DeFi** (core) | A vault that trades across chains via Intents with no custodian | confidential swap + cross-chain deposit code, NAV |
| **Open Innovation** (core) | New primitive: provable-after-reveal private strategy | reveal verifier |
| Autonomous Business (STRETCH, only if performance-fee split ships) | fund pays fee split with no human in the loop | not promised |

Skipped on purpose: Swarms, Agent Economy, Real-World Money, Games, NFTs, Memecoins, Social, Thesis.

## 6. Rubric map (what scores points)

- **Technical 30%**: typed TS, schema-validated AI output, idempotent execution (`X-Idempotency-Key`), signature recovery check, attestation nonce check, tests for verifiers, clear error handling.
- **Innovation 25%**: Seal->Trade->Reveal->Verify; "request_hash binding" trick; private AI + private trades + MPC cage in one loop.
- **Track Fit 25%**: integration code in clearly named files so a repo grep finds it: `cloud-api.near.ai`, `attestation/report`, `api.outlayer.ai`, `confidential/swap`, `confidential/deposit/cross-chain`, `intents.far`. README table "if we remove X".
- **Execution 20%**: one command per proof, recorded real run committed, judge mode needs no funds, frequent meaningful git commits (rubric says git activity is a positive sign), LICENSE, README for machines ("do X -> see Y").

## 7. Architecture

```
Investor (any chain, USDC) --send--> bridge address (from /confidential/deposit/cross-chain)
                                         |
                                         v
        FUND WALLET (OutLayer agent wallet: keys from NEAR MPC in Intel TDX, policy cage)
          ^  confidential balance on private shard intents.far
          |
 Market data --> ORCHESTRATOR (TypeScript, runs one "epoch" per call)
                   1. build request = system prompt + SECRET recipe + market snapshot
                   2. POST NEAR AI Cloud (TEE model) -> decision JSON
                   3. GET /v1/signature/{chat_id} immediately (expires ~60 min) + attestation (fresh nonce)
                   4. validate decision (schema, caps, allowed tokens) -> trades
                   5. POST OutLayer /confidential/swap (idempotent) -> poll request_id
                   6. build receipt; fund wallet signs NAV statement; anchor hash on NEAR (social.near via /call)
                   7. append to data/receipts.json (public) ; request bodies kept ENCRYPTED until Reveal Day
DASHBOARD (Next.js) reads: receipts, live attestation, on-chain policy, public RPC (copycat view)
VERIFIER CLI (`npm run verify`): works offline on recorded run + live checks that need no funds
```

Trust boundaries (what the README states): brain server is NOT in a TEE in v0 (it sees the recipe because its author wrote it); it cannot move money outside the cage; AI inference is inside a TEE; wallet keys are inside a TEE. Roadmap (NOT built, labelled as such): run the orchestrator itself inside OutLayer so even the operator cannot read the recipe.

## 8. Planned repo layout

```
near/
  README.md            machine+human README, "do X -> see Y", trust assumptions, removal table
  LICENSE (MIT)  PLAN.md  .env.example  .gitignore (.env, data/secret/, .claude/)
  src/near/ai.ts           NEAR AI Cloud client + attestation + signature verify
  src/near/outlayer.ts     OutLayer wallet client (register, balance, confidential, call, sign-message)
  src/near/anchor.ts       on-chain anchoring + commitment
  src/engine/              recipe loader, prompt builder, decision schema, risk caps, epoch runner
  src/verify/              commit check, request-hash check, signature recovery, attestation checks
  app/                     Next.js dashboard: Investor, Copycat, Red-team, Reveal pages
  data/demo-run/           recorded REAL run (receipts, attestations, tx ids)
  scripts/                 epoch, redteam, reveal, fund-address
  tests/
```

## 9. Scope (MoSCoW) and cut order

MUST: fund wallet + funding; 1 real confidential swap; NEAR AI decision + signature + attestation checks; receipts; commit/reveal verifier; policy cage + live red-team denial; dashboard (4 views); README + judge mode; demo video + X post; submissions.
SHOULD: on-chain anchoring of every epoch; NAV statements signed by the wallet; investor deposit via cross-chain bridge address shown in UI.
COULD: performance-fee split (Autonomous Business track), drawdown auto-freeze, second recipe.
CUT ORDER if late: COULD -> anchoring beyond commit hash -> polish of Red-team page -> Open Innovation page copy. Never cut: real trade, verifier, honest README, video.

## 10. Schedule (UTC | IST) with acceptance gates

| When | Work | Gate that must pass |
|---|---|---|
| Wed 11 Nov evening | Lock plan; scaffold repo (public, no secrets); user tasks (sec. 11); Loops login | - |
| Wed night - Thu 12 Nov 06:00 UTC | Fund wallet; **G2** money in via cross-chain deposit; **G3** one real confidential swap + balance read; **G4** NEAR AI signature + attestation verified locally | G2, G3, G4 |
| **Thu 12 Nov 06:00 UTC - GO/NO-GO** | If G3 fails and cannot be fixed by 12:00 UTC: Plan B = same project, public Intents swaps (OutLayer `/intents/swap`), drop the "hidden trades" claim in all copy, keep cage + reveal | decision recorded |
| Thu 12 Nov | Epoch runner end-to-end with real money; receipts; commit published; **G6** anchoring | G6 |
| Fri 13 Nov | **G5** cage + red-team denials; verifier CLI; dashboard; Reveal flow; README judge mode; 3+ recorded epochs | G5, G7 |
| Sat 14 Nov 00:00-06:00 UTC | Bug-fix only. **Code freeze 06:00 UTC (11:30 IST)** | - |
| Sat 14 Nov 06:00-12:00 UTC | `loops evaluate` per track, fix flags; clean-clone test **G8**; record video; deploy | G8 |
| Sat 14 Nov by 18:00 UTC (23:30 IST) | **Submit everywhere** (target 6h before deadline) | submitted |
| Sat 14 Nov 23:59 UTC | Hard deadline | - |

Acceptance gates: G2 deposit credited | G3 real confidential swap success | G4 sig recover == attested signer, nonce echoed | G5 3 attack calls return 403 `policy_denied` | G6 anchor tx visible on explorer | G7 reveal check passes on recorded run | G8 fresh clone: `npm i && npm run verify` prints all green.

## 11. Money, accounts, and what the user must do (one item at a time after approval)

Money (real, tiny): ~$25 USDC float (trades of $2-8), ~0.05 NEAR for gas (made from a little of the USDC via the wallet), NEAR AI credits $10 free via NEAR Builders (or buy ~$5). If the user can fund less, we shrink trade size; if $0, we run the "quotes + recorded run" variant and say so honestly.
User tasks (in order): 1) NEAR mainnet wallet (prize address + policy owner) 2) NEAR Builders profile -> claim $10 AI credits -> put key in local `.env` (never in chat) 3) send USDC to the deposit address I generate 4) `! npx loopshouse auth login` so I can use `knowledge query`, `ideate`, `evaluate` 5) X account + record the video (I write the script) 6) final "yes" before any submit.
Security rules: never paste keys in chat; `.env` git-ignored; rotate the `wk_` key after the demo; no outside investor money (demo funds are ours; README says "not investment advice").

## 12. Demo video (2 minutes) and X post

0:00 problem (secret vs trust) -> 0:20 Seal (commit hash on-chain) -> 0:40 Trade (one epoch live, receipts) -> 1:00 Copycat view (explorer shows nothing; `intents.far` UNKNOWN_ACCOUNT on public RPC) -> 1:20 Red-team (send-everything-to-attacker = denied) -> 1:40 Reveal (hash matches, request hashes match) -> 1:55 what's real vs roadmap.
X post: says "built at NEAR HACKATHON", tags @NEARProtocol, #NEARHackathon, video attached, lead with the user problem, NEAR's role concrete.

## 13. Submission checklist

[ ] repo public + LICENSE + README lists libraries/templates [ ] README: do-X-see-Y, removal table, trust assumptions, what is real vs roadmap [ ] data/demo-run committed [ ] X post public [ ] nearhackathon.com submit ONCE (never twice; fixes via /request-changes) [ ] Loops House `project create` draft shown to user, `--confirm` only after user says yes [ ] tracks chosen: privacy, security, defi, open [ ] NEAR mainnet payout address [ ] hosted demo link (bonus) kept alive to 25 Nov [ ] resolve U6 first.

## 14. Risks and fallbacks

| Risk | Fallback |
|---|---|
| Confidential swap fails on real money (G3) | Plan B at GO/NO-GO, honest copy |
| OutLayer custody ceiling / rate limits | smaller amounts, spread epochs |
| NEAR AI credits / model outage | second TEE model; recorded decisions are labelled "recorded" |
| TDX quote local verify too hard (U5) | verify nonce binding + signer locally, link NEAR's own verifier, say exactly which checks run where |
| `social.near` anchoring fails (U4) | anchor hash via wallet NEP-413 signature + public commit; label honestly |
| Crowded field (498+ projects; 7+ "agent wallet with limits") | never pitch "policy firewall"; pitch the mechanism |
| Solo time pressure | MoSCoW cut order, code freeze |

## 15. LOCKS (each needs user approval)

| Lock | Decision | Status |
|---|---|---|
| L1 | Idea = Black Box Fund (Seal -> Trade -> Reveal -> Verify) | AWAITING |
| L2 | Tracks = Privacy, AI Security, DeFi, Open Innovation (Autonomous Business only as stretch) | AWAITING |
| L3 | Architecture = TypeScript + OutLayer wallet API + NEAR AI Cloud + social.near anchoring, NO custom Rust contract | AWAITING |
| L4 | Scope + cut order (section 9) and honesty rules (no overclaiming, labelled roadmap) | AWAITING |
| L5 | Money plan ~$25 + user tasks (section 11) | AWAITING |
| L6 | Schedule, GO/NO-GO and code freeze (section 10) | AWAITING |
| L7 | Submission rule: nothing submitted without the user seeing it and saying yes | AWAITING |

---

## 16. BRUTAL REVIEW (2026-11-11, after user asked "is the plan concrete?") - these CHANGE v1

Verdict: plan is ~70% concrete. Not ready to build until the hinge test and 3 user decisions are done.

Cracks found (and the fix):
1. **Hinge risk (U1)**: real confidential swap unproven. FIX: run G3 FIRST, tonight, ~$10, before any other build work. Layer the build: L1 sealed brain + commit/reveal + receipts (low risk), L2 cage + red-team (medium), L3 hidden trades (hinge). If L3 fails by Thu 12 Nov 06:00 UTC -> Plan B: ship L1+L2, remove "hidden trades" from all copy.
2. **"Nobody can steal" is false for the owner**: the policy owner key (single NEAR account in v0) can change rules; OutLayer team holds admin keys. FIX wording: "the AI/brain server cannot steal; owner is one account in v0, production = DAO". Say it in README before judges ask.
3. **"Provably followed the recipe" overclaims**: reveal proves each signed DECISION came from the committed recipe. Execution inside the private shard cannot be independently checked by outsiders. FIX wording: "decisions provably came from the recipe; execution is evidenced by wallet receipts + public entry/exit amounts".
4. **Not really a multi-investor fund** (no share ledger). DeFi track is the weakest fit ("unstoppable" vs OutLayer admin keys). FIX: v0 = single-investor flow (any-chain deposit -> trade -> any-chain withdraw); multi-investor shares = labelled roadmap; DeFi stays claimed but honestly scoped.
5. **Pitch**: lead with the broad pain "how do you trust an AI with money you cannot inspect?"; the secret-strategy fund is the showcase. Do NOT claim profits (3 days, ~$25 = noise).
6. **Brain server is not in a TEE**: operator sees the recipe. Already in trust assumptions; keep it.
7. **Time**: ~80h solo, 4 external systems barely touched, real money. Estimated ~60% to finish all MUST at good quality. Cut order in section 9 is binding.

Honest odds: top-3 in one track ~15-25% if executed well, ~5% if half-built; grand prize ~2-3%. Problem importance as a business ~5/10, as a hackathon story ~8/10.

Decisions still open: (A) user money amount [blocks G3], (B) user has a NEAR mainnet wallet? [policy owner + prize address], (C) user approval of L1-L7 as amended here, (D) U6 submission path (ask NEAR Discord / Loops).
