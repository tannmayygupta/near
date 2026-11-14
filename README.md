# Quiet Treasury

**Vote once. The agent does the rest, inside limits it cannot break.**

Quiet Treasury lets a DAO approve a plain-English instruction such as *"sell up to 500 NEAR for USDC over 3 days, never below 3.50, then pay these five contributors"*, and turns that single vote into a bounded, verifiable, autonomous execution on NEAR. A private AI drafts the mandate, a Sputnik DAO approves it, our Rust contract enforces it on-chain, an agent carries it out in price-floored chunks, and anyone can independently verify the settlement report afterwards.

Built for **NEAR HACKATHON 2026**. Everything in this repository was written during the hackathon window. The full flow runs for real on **public NEAR testnet** (every step has an explorer link below); the parts that only exist on mainnet are clearly marked as such in [What is proven](#what-is-proven-and-what-is-not).

[![CI](https://github.com/tannmayygupta/near/actions/workflows/ci.yml/badge.svg)](https://github.com/tannmayygupta/near/actions/workflows/ci.yml)

**Live demo:** https://tannmayygupta.github.io/near/ (static: the recorded runs plus live testnet RPC reads; the wizard's live AI parse and the red-team "Run attack" buttons need the worker, so run those locally).
**For judges (5 minutes):** [docs/JUDGES.md](docs/JUDGES.md) · claims vs evidence: [docs/CLAIMS.md](docs/CLAIMS.md) · track proof map: [docs/TRACKS.md](docs/TRACKS.md) · AI disclosure: [docs/AI_DISCLOSURE.md](docs/AI_DISCLOSURE.md) · security model and limits: [SECURITY.md](SECURITY.md) · machine-readable map: [llms.txt](llms.txt)
**Run it, no keys needed:** `npm ci && npm test && npm run verify` (396 unit tests; independent verifier on three recorded runs) and `npm run demo` (the whole story offline in about 2 seconds: a labelled simulation with a transcript and an exit code).
**No mainnet money was moved.** Everything real here is on public testnet; the mainnet-only parts are listed as *not proven* below.

## Quiet Treasury in 30 seconds

- 🗳️ **One vote, not a hundred trades.** The DAO votes once on a plain-English mandate (token, budget, price floor, window, payouts). It never gives anyone the ability to do more.
- 🤖 **The AI drafts, code decides.** A NEAR AI Cloud TEE model drafts the terms (signed and attested); code re-validates every bound; the AI never holds a key.
- 🔐 **Three independent safety layers.** The NEAR protocol scopes the agent's key to five methods, an OutLayer wallet policy is written per mandate, and our contract plus executor enforce budget, window, token and destination. Every refusal names its layer.
- ♻️ **It survives a crash.** Kill the worker right after a real swap landed: a new one finishes without swapping twice (live on testnet, 13/13).
- 🔍 **Don't trust us, check.** `npm run demo` (offline story), `npm run verify` (independent verifier, tamper cases), `npm run check:evidence` (every cited transaction exists: 201/201), `npm run verify:contract` (the deployed contract is the committed wasm).
- 🧪 **Honest about testnet.** No mainnet funds were moved; what is quoted but not executed is labelled in every document.

## Live on NEAR testnet

| What | Where |
|---|---|
| Dashboard (recorded runs + live testnet reads) | [tannmayygupta.github.io/near](https://tannmayygupta.github.io/near/) |
| Sputnik DAO | [`quietdao-83872.sputnikv2.testnet`](https://explorer.testnet.near.org/accounts/quietdao-83872.sputnikv2.testnet) |
| Mandate contract (v2: events, versioned state, pause, two-step DAO handover) | [`qtmandate2-83872.testnet`](https://explorer.testnet.near.org/accounts/qtmandate2-83872.testnet) (code hash `Goj1eumf...dFHV9` equals the committed wasm; [deploy tx](https://explorer.testnet.near.org/transactions/D7e16u1nLErsVgm8nrxNqo84mP7yYpCfAmF8m3bE5H7T)) |
| Vault: an OutLayer agent wallet | [`98b125db...f89f7`](https://explorer.testnet.near.org/accounts/98b125dbd9790b6fd836825fb3b94d0f23df6e931fad5ad62fd74f14739f89f7) |
| A real swap signed by that wallet | [`14ogHdLi...DTEk`](https://explorer.testnet.near.org/transactions/14ogHdLiEmeHPie2gvwpfxAyV4Tfu9m3qEchfxk7DTEk) |
| The per-mandate wallet policy the worker wrote | [`8SgePXQe...bEy`](https://explorer.testnet.near.org/transactions/8SgePXQewWGvtEniHAFRk1P2wQKrgMhy6Uz8bvH44bEy) |
| The report hash anchored on-chain | [`9A3dfgH4...rrpW`](https://explorer.testnet.near.org/transactions/9A3dfgH4PohJc5u9HoXcXkPpQ3fEakGsnYDxGmMJrrpW) |
| The agent's scoped function-call key being added | [`C7CEeEoH...g2FC`](https://explorer.testnet.near.org/transactions/C7CEeEoHR2jGwzKJCk9nqVuyEf8MxCnBtzwj2pjpg2FC) |
| Check a run yourself, in the browser | [`/recompute`](https://tannmayygupta.github.io/near/recompute/): re-reads the contract and the transactions from public RPC |
| Recorded runs and proof bundles | [`data/demo-run/`](data/demo-run/) (`custody-run.json`, `restart-run.json`, `sealed-run.json`, `run.json`) |

Everything above is public **testnet**. As of 14 November 2026: 6 real Ref swaps and 4 payouts/fee/returns in the custody run, a 13/13 crash-restart, 396 unit tests plus 36 contract tests, 201 cited transactions all found on-chain. No mainnet transactions exist.

### How this maps to how we are judged
The Loops page shows this rubric for the Social Money, Autonomous Business, Privacy and Real-World Money tracks: NEAR technology usage 35%, real not simulated 25%, track fit 20%, execution and completeness 20%.

| Criterion | Where to check | Honest status |
|---|---|---|
| NEAR technology usage (35%) | Sputnik DAO v2 proposals, our Rust contract (deployed code hash equals the committed wasm: `npm run verify:contract`), NEAR AI Cloud TEE (signed, attested), **OutLayer agent wallet as the vault + per-mandate wallet policy** ([docs/CUSTODY.md](docs/CUSTODY.md)), near.social, NEAR Intents quotes. Map: [NEAR technology map](#near-technology-map-where-to-look-in-the-code) | Intents execution and confidential swaps are quoted only |
| Real, not simulated (25%) | Every transaction in the recorded runs is on public testnet and checked to exist (`npm run check:evidence`, `data/evidence-check.json`): DAO votes and funding transfers, real Ref swaps, payouts, returns, report anchoring | **Testnet only. No mainnet funds.** Tokens are play money; chunking gives no price gain on the thin pool and the report says so |
| Track fit (20%) | One section per track below: what it means, the problem it solves here, a scenario, proof, the limit | Seven tracks claimed, each scoped honestly |
| Execution and completeness (20%) | 396 unit tests, 36 contract tests (31 unit + 5 property tests), CI, four end-to-end runs (30/30, 37/37, 37/37 and a 13/13 crash-restart), 15-page dashboard, three independent-verifier bundles | Hosted demo is static (no worker behind it); see Status |

---

## Why this exists

DAOs and foundations constantly sell their own token to pay for operations. Today that goes one of three bad ways:

| Today | What goes wrong |
|---|---|
| Sell it all in public | The price drops and bots front-run the sale. |
| Hand the keys to a trusted operator | Nothing stops the operator from selling more, selling cheaper, or paying themselves. |
| Ask the council to sign every trade | Slow, error-prone, and the vote itself telegraphs the trade. |

**Quiet Treasury turns the DAO's decision into a standing, bounded mandate.** The DAO votes on *what may happen* (token, budget, price floor, time window, payouts). It never gives anyone the ability to do more.

### One scenario, end to end

> A treasurer types: *"Sell up to 5 wNEAR for USDT over 2 days, not below 3 per NEAR, in chunks of 0.5 to 1 every 10 to 20 minutes. Pay 30% of proceeds to alice."*
> 1. A private AI inside a NEAR AI Cloud TEE drafts a structured mandate. Code re-validates every bound; the AI never holds keys.
> 2. Two of three council members vote on real Sputnik DAO proposals: one creates the mandate on our contract, one funds a vault.
> 3. The agent wakes up only after the vote. It sells in randomized chunks, each with a price floor enforced as `min_amount_out`.
> 4. It pays alice, pays the service fee, and returns every leftover token to the DAO.
> 5. It anchors the report hash on-chain. Anyone can re-verify the report, the AI signature and the price floors.
> 6. If the council changes its mind mid-run, one DAO cancel proposal stops it and everything unspent returns to the DAO.

That exact flow is recorded in [`data/demo-run/run.json`](data/demo-run/run.json) and re-checkable with one command (see [Verify it yourself](#verify-it-yourself)).

---

## How we use NEAR: each track, and the problem it solves here

NEAR's hackathon tracks name real capabilities. Here is what each one means and what it does for Quiet Treasury. We claim a track only where we built something that depends on it.

### Social Money - *shared budgets, collective ownership, reputation-based access on Sputnik DAO and Trezu*
**What the track is about:** communities that already own a treasury and want to do more with it than collect signatures.
**The problem it solves for us:** a DAO needs to delegate treasury work without delegating trust.
**How it works in our scenario:** the council does not sign trades; it votes on a *mandate*. The agent only starts after a real Sputnik proposal executes, and a second proposal moves native NEAR into the vault. Approval tiers decide how many votes a mandate needs (small: one, mid: a council majority, large: all). Every settled mandate raises its treasurer's **on-chain trust score**, and that reputation is mirrored to **near.social** against their named account, so every point traces to a finished mandate. The DAO even posts its own announcements to near.social through a voted proposal.
**Proof:** [funding proposal](https://explorer.testnet.near.org/transactions/Fdhj7e497DvCBwYoYFabMsHewcnYf8E8nhYY6WfW398p) and [the vote that executes it](https://explorer.testnet.near.org/transactions/8qUeXDBPsRWS9SXY2gBC6E4y8qUuPPb53ohDHNFCij1Y), [DAO-voted near.social post](https://explorer.testnet.near.org/transactions/9Z3Tef3hXnuDSLoMwwWEHdCZgygwDiCzDqQHtDtGQ3c5), the dashboard `/votes` and `/reputation` pages, `worker/guards.ts`, `src/near/sputnik.ts`, `src/near/social.ts`.
**Honest limit:** Trezu needs a wallet sign-in so we could not view our DAO there; a Trezu treasury is a Sputnik DAO v2, the same contract we run (see [docs/TREZU.md](docs/TREZU.md)).

### Autonomous Business - *AI-native businesses that run treasury and payments, where humans only set constraints*
**What the track is about:** operations that run themselves inside rules a human wrote once.
**The problem it solves for us:** a treasury sale is a business process (sell, pay people, return the rest, report) that should not need a human at every step.
**How it works in our scenario:** after the funding vote there is **zero human action** until the anchored report. The agent sells, pays contributors and a service fee, returns leftovers to the DAO and publishes the report by itself. The constraints (budget, window, floor, recipients) live on-chain; the kill switch is a DAO cancel proposal.
**Proof:** [first swap](https://explorer.testnet.near.org/transactions/AJaDUjuhuqfvinxUCuk4sX1vqiye1ng1XReaxZcjFgSS), [alice's payout](https://explorer.testnet.near.org/transactions/GXUbfg94LfZkZdiarJrsKb2KKqWxC22iTn12MwNwQPyy), [report anchored on-chain](https://explorer.testnet.near.org/transactions/2TXgtQbDvycDNtp12Wk9sofUA3yDD22yWhipEzAtE1ZP), [DAO cancel mid-run](https://explorer.testnet.near.org/transactions/8JxWt7nxs2mmaRMZ4kCyWGJbFudihh9fYEr6GqeCtAEh); `worker/executor.ts`.
**It survives a crash (live, not just unit tests):** `npm run e2e:restart` kills the worker right after a real swap landed on chain, then starts a new worker from the same files. It finishes the mandate, does **not** swap that chunk a second time (OutLayer deduplicates the replayed idempotency key), pays exactly once and anchors the report: 13/13 checks, recorded in [`data/demo-run/restart-run.json`](data/demo-run/restart-run.json).

### AI Security & Defense - *give AI money without giving it the keys to everything*
**What the track is about:** spending limits, policy engines and attestation for agents that touch money.
**The problem it solves for us:** an autonomous agent with a wallet is only safe if it *cannot* exceed its brief, even if it is wrong or compromised.
**How it works in our scenario:** there are three independent layers. **Layer 0** is the NEAR protocol itself: the key the worker uses to drive the mandate contract is a function-call access key limited to that contract and its five agent methods, with no deposit (`scripts/testnet/scoped-key.ts`); the protocol refuses `create_mandate`, `set_agent`, any other contract, any transfer and any deposit before contract code runs (`data/testnet-scoped-key.json`, shown on `/custody`). **Layer A** is an OutLayer agent-wallet policy. The vault *is* an OutLayer wallet, and **the worker writes a policy for each mandate from the DAO-approved terms before that mandate may trade** (only the contracts it needs and the DAO; native NEAR capped at the mandate budget). OutLayer then returns a real HTTP 403 `policy_denied` for a call to a contract outside the mandate, or native NEAR to any account but the DAO or above the budget. **Layer B** is our Mandate contract plus the executor guards: over-budget chunks, wrong tokens, trading after expiry, payouts to unlisted addresses, and creating a mandate without a DAO vote are all rejected. Six red-team attacks are runnable from the dashboard and each reports which layer stopped it.
**Proof:** `data/demo-run/custody-run.json` (`layerA.policies`, `layerA.probes`, `redteam`), the `/custody` and `/redteam` pages, `worker/adapters/mandate-policy.ts`, `src/near/outlayer-policy.ts`, `contracts/mandate/src/lib.rs` (36 tests), [docs/CUSTODY.md](docs/CUSTODY.md).
**Honest limit (probed, not assumed):** OutLayer's policy checks the contract a call goes to and native NEAR, but **not** who receives a token payout and **not** token amounts (`data/testnet-outlayer-findings.json`). Those are enforced by Layer B. So against a stolen worker credential, Layer A alone would not stop a token drain on testnet. The confidential endpoints were not exercised.

### Privacy & Private AI - *intelligence without exposure*
**What the track is about:** AI and finance that protect sensitive data, with proof rather than promises.
**The problem it solves for us:** the intent (budget, floor, recipients) is commercially sensitive, and a normal LLM API would read it with nothing to verify.
**How it works in our scenario:** the mandate is drafted and the settlement is summarised by a **confidential-TEE model on NEAR AI Cloud** (the recorded runs used GLM 5.3 Flash; the worker's `/api/parse` defaults to Qwen3.8-27B). Every answer carries a hardware-backed signature; our verifier recovers the signer, checks it against the attestation report fetched with a fresh nonce, and re-hashes the exact request and response bytes. The dashboard can run the live attestation check in your browser.
**Proof:** `scripts/g4-check.ts`, `src/near/ai.ts`, `src/verify/`, the `/verify` page, `data/demo-run/proof-bundle.json` (13/13).
**Honest limit:** we verify the signer is attested, not the Intel quote itself. Confidential *execution* (hidden trades) is designed against OutLayer and Confidential Intents but is mainnet-only and **not proven**.

### Real-World Money - *payroll, invoicing and rails a normal organization could use tomorrow*
**What the track is about:** boring money, moved reliably, with records an accountant accepts.
**The problem it solves for us:** the sale is pointless unless contributors actually get paid and the books balance.
**How it works in our scenario:** proceeds are split into real token transfers to **named accounts**, a service fee is paid to the operator, and every leftover goes back to the DAO. Balances are checked on-chain before and after, and the ledger exports an accountant-ready CSV with a transaction link on every row.
**Proof:** `real.payouts` and `real.balanceDeltas` in `data/demo-run/run.json`, the `/ledger` page and CSV.
**Honest limit:** testnet payouts are on NEAR. Cross-chain payouts through Intents are implemented and live-quoted but not executed with real money.

### Open Innovation - *something we have not seen*
**What the track is about:** new ways for money, intelligence and ownership to work together.
**The problem it solves for us:** a DAO may want to sell *without telling the market the terms first*, yet members still need proof it followed the vote.
**How it works in our scenario:** **sealed mandates**. The chain holds only `sha256(salt | terms)` and the budget while the agent executes; terms are AES-256-GCM encrypted off-chain and released only to council members who sign a NEP-413 request. After settlement the terms are published on-chain and an independent verifier proves the commitment, the price floors, the budget and every recipient match, and rejects five kinds of tampering.
**Proof:** mandate #13: [create](https://explorer.testnet.near.org/transactions/GGwhzq4HFeL8yYyvwCUgsagEanrHKoGieATHdArbvH9f), [first swap](https://explorer.testnet.near.org/transactions/JjGn1Wmxq3QaefAYp4bjme4xSjVn57DPcTQqReP43WF), [settlement + reveal](https://explorer.testnet.near.org/transactions/2PviWNGSjGg9tF96eFNvUmdtbk3Q2BFHefkYUx86WuVz); `data/demo-run/sealed-proof-bundle.json` (21/21), the `/sealed` page, [docs/SEALED.md](docs/SEALED.md).
**Honest limit:** our worker is not in a TEE, so its operator can read sealed terms; testnet payouts reveal recipients when they execute.

### Unstoppable DeFi - *trading agents that settle across chains through NEAR Intents, no custodian, nobody to switch it off*
**What the track is about:** markets that no single party controls.
**The problem it solves for us:** treasury sales should not depend on a custodian or an operator's goodwill.
**How it works in our scenario:** the DAO funds a vault by vote; the agent can only trade what the on-chain mandate allows, so no operator can redirect funds, and only a DAO vote can stop it. Execution on testnet is **real on-chain swaps on Ref Finance** with a price floor on every chunk. The cross-chain leg is implemented against NEAR Intents' 1Click API and **live dry-run quotes** are recorded for the sell leg and each payout chain.
**Proof:** the swap transactions above; `src/near/routes.ts` and `src/near/intents.ts`; recorded live 1Click quotes in `data/demo-run/mainnet-readonly.json` (5 wNEAR to about 16.8 USDC on NEAR, then USDC legs to Solana, Base, Arbitrum and Ethereum, each with minimum out and time estimate); an `EXEC_MODE=live-dryrun` worker mode that takes a real quote, applies the price floor and records the exact OutLayer request it *would* send while blocking every money-moving call (`data/demo-run/mainnet-dryrun-decision.json`); the `/routes` dashboard page; [docs/DEFI.md](docs/DEFI.md).
**Honest limit:** Intents has no testnet and we did not fund mainnet, so Intents execution, OutLayer-custody swaps and confidential swaps are **not proven with real money**. On the thin testnet pool, chunked selling does not beat one swap (about the 0.3% fee), and the report says so.

---

## Architecture

```
 Member types intent
        │
        ▼
 NEAR AI Cloud (TEE) ── drafts mandate ──► zod + hard bounds re-check ──► human confirms
        │
        ▼
 Sputnik DAO proposals ── council votes (tiers) ──► Mandate contract (Rust, on-chain truth)
   ① create_mandate                                  DAO-only create/cancel, agent-only progress,
   ② fund the vault (Transfer)                       budget + window + idempotent chunk records
        │
        ▼
 Agent worker (TypeScript) ── price-floored chunks ──► OutLayer custody wallet ──► Ref swap (testnet) / Intents (mainnet, quoted only)
        │                                              (policy written per mandate; key in OutLayer's TEE)
        │                                              │
        │                                              ▼
        │                                     payouts · fee · leftovers back to the DAO
        ▼
 Settlement report ── NEAR AI signed summary ──► hash anchored on the Mandate contract
        │
        ▼
 Verifier (CLI + dashboard)  ·  near.social reputation  ·  red-team page
```

## NEAR technology map (where to look in the code)

| NEAR capability | Used for | Where |
|---|---|---|
| Sputnik DAO v2 | approvals, funding, cancel, DAO-authored posts | `src/near/sputnik.ts`, `scripts/testnet/` |
| Rust smart contract (near-sdk) | mandate registry and state machine, trust score | `contracts/mandate/` |
| NEAR AI Cloud (TEE inference, attestation, signatures) | mandate drafting, settlement summaries, verification | `src/near/ai.ts`, `src/engine/parser.ts`, `worker/summarizer.ts` |
| OutLayer agent wallet (TEE keys, wallet policy, `/call`, idempotency) | **the vault that signs wraps, swaps, payouts and returns**; Layer A policy written per mandate; red-team denials | `worker/adapters/signers.ts`, `worker/adapters/mandate-policy.ts`, `src/near/outlayer-policy.ts`, `src/near/outlayer.ts`, [docs/CUSTODY.md](docs/CUSTODY.md) |
| NEAR Intents (1Click API) | cross-chain route quotes; live execution path | `src/near/intents.ts`, `worker/` |
| near.social (FastData) | announcements and named-account reputation | `src/near/social.ts`, `worker/social-publisher.ts` |
| Named accounts and NEP-413 | identities and council-only sealed-term access | `worker/auth.ts` |
| Ref Finance (testnet DEX) | real on-chain swaps | `worker/adapters/ref-testnet.ts` |

## What is proven, and what is not

| | Status |
|---|---|
| DAO votes create, fund and cancel mandates; no execution before approval | **Proven on public testnet** (real transactions) |
| Chunked swaps with a price floor, real payouts, fee, leftover returns, anchored report | **Proven on public testnet** (`run.json`, key-held vault, 30/30 checks) |
| The same flow with an **OutLayer agent wallet as the vault**, a wallet policy written per mandate, and real 403 denials | **Proven on public testnet** (`custody-run.json`, 37/37 checks, verifier 16/16) |
| Worker killed after a real swap landed; a new worker resumes without double-swapping | **Proven on public testnet** (`restart-run.json`, 13/13) |
| Sealed commit-reveal with tamper detection | **Proven on public testnet** (37/37 run, verifier 21/21) |
| Private-AI outputs signed, attested and independently verified | **Proven** (live NEAR AI Cloud; verifier 13/13) |
| near.social posts and reputation from named accounts | **Proven on testnet** |
| OutLayer's policy restricting token payout recipients or token amounts | **Not provided by OutLayer in our probes** (Layer B enforces both); see CUSTODY.md |
| Confidential (hidden) swaps, Intents cross-chain payouts | **Implemented and quoted against live APIs; not executed with real money** (mainnet-only; no funds were committed) |

Testnet tokens are play money. The wallet key is in OutLayer's TEE, but testnet trades are ordinary public transactions, so there is no confidentiality on testnet. Full row-by-row status with evidence: [docs/CLAIMS.md](docs/CLAIMS.md).

### Status, 14 Nov 2026
* **Tests:** 396 unit tests (vitest), 36 Rust contract tests (31 unit + 5 property tests); `npm run verify` re-checks three recorded proof bundles (13 + 21 + 16 checks).
* **End-to-end runs on public testnet:** 30/30 (key vault), 37/37 (OutLayer custody, 6 real swaps, 4 payouts/fee/returns), 37/37 (sealed), 13/13 (crash-restart).
* **Evidence:** all 201 distinct transactions cited here, in the docs and in the recorded runs were looked up on public testnet and all 201 exist (`npm run check:evidence`, result in `data/evidence-check.json`). The deployed contract's code hash equals the committed wasm (`npm run verify:contract`).
* **Protocol-level scoping:** the worker drives the mandate contract with a function-call key (5 methods, no deposit); the NEAR protocol refuses everything else (6 live probes in `data/testnet-scoped-key.json`; the custody and crash-restart runs use this key).
* **Recompute in your browser:** the [/recompute](https://tannmayygupta.github.io/near/recompute/) page re-reads the mandate from the contract and every chunk and completion transaction from public RPC, then re-derives the sums, the price floor and the report hash. No server of ours is involved (`app/lib/recompute.ts`, `tests/recompute.test.ts`).
* **A flaw we found and fixed on 14 Nov:** the price sanity band was skipped when its reference quote failed, so two recorded runs had traded through an absurdly priced pool while every check passed. The guard now fails closed, every end-to-end run checks that its swaps happened at a market-like price, and all four runs were re-recorded on contract v2 ([incident note](docs/incidents/2026-11-14-price-band-skipped.md)).
* **Not done:** no mainnet transactions; the hosted demo is static (no worker behind it); Trezu is not integrated; a Telegram alert has been exercised only against Telegram's real API error path, not into a real chat (`scripts/dev/alert-test.ts` does it with your own bot token).
* **Feedback for OutLayer, with reproductions:** [docs/OUTLAYER-FEEDBACK.md](docs/OUTLAYER-FEEDBACK.md).

## Verify it yourself

```bash
npm ci
npm test                                  # 396 unit tests: parser, planner, settlement, verifier, worker edge cases, sealed checks, custody policy
npm run verify                            # independent verifier on three recorded proof bundles (13 + 21 + 16 checks, incl. tamper cases)
npm run secret-scan                       # 0 findings expected
npm run verify:contract                   # needs network: deployed contract code hash == committed wasm
npm run check:evidence                    # needs network: every cited transaction exists on public testnet
powershell scripts/build-contract.ps1     # build + test the Rust contract in Docker
npm --prefix app ci && npm run dashboard  # dashboard on :3100 (reads the committed recorded runs and live testnet RPC)
```

To reproduce the live testnet runs (needs a `NEAR_AI_API_KEY` in `.env`; testnet accounts are free) see [docs/RUNBOOK.md](docs/RUNBOOK.md): `npm run e2e:real` (about 12 minutes), `npm run e2e:custody`, `npm run e2e:sealed`, `npm run e2e:restart`.

Deployed testnet ids: DAO `quietdao-83872.sputnikv2.testnet`, mandate contract `qtmandate2-83872.testnet` (v2; the v1 contract `qtmandate-83872.testnet` stays on chain, its recordings are in git history under the tag `v1-recorded-runs`), key-held vault `vault.qtagent-68669.testnet`, OutLayer custody wallet `98b125dbd9790b6fd836825fb3b94d0f23df6e931fad5ad62fd74f14739f89f7` ([`data/testnet-public.json`](data/testnet-public.json), [`data/demo-run/custody-run.json`](data/demo-run/custody-run.json)).

## What you trust us for (and what the chain does not prove)

* **The worker's operator.** It runs outside a TEE. It sees the terms of every mandate it executes (including sealed ones) and holds the owner credential that writes wallet policies. Against a misbehaving worker, the contract, the wallet policy and the DAO cancel bound the damage; against a stolen owner credential on testnet, OutLayer's policy would not stop a token drain (it does not check token recipients or amounts).
* **OutLayer.** The vault's signing key is in OutLayer's TEE and OutLayer holds governance keys. We probed its policy engine and documented where it does and does not enforce (`data/testnet-outlayer-findings.json`).
* **NEAR AI Cloud.** We verify that the answer's signer is attested and that the bytes match; we do not verify the Intel quote itself.
* **Prices.** The Ref testnet pool is thin and open to anyone; prices there say nothing about mainnet.
* **The contract is a registry.** It enforces budget, window, roles and idempotent chunk records; it does not custody funds. Version 2 emits NEP-297 events, has versioned state with a migration, a pause switch and a two-step DAO handover ([docs/CONTRACT.md](docs/CONTRACT.md)); it still has no near-workspaces sandbox tests, and its wasm is built in a pinned Docker image, not with `cargo near build reproducible-wasm` (`docs/review-2026-11-14.md`).
* **Nothing is audited.** All demo funds are test tokens; this is not investment advice.

## Security and trust model

- The AI only *proposes*. Hard bounds are re-checked in the parser, the worker and the contract; the AI never holds keys.
- The worker is not in a TEE in v0, so it sees the mandates it executes. AI inference runs in NEAR AI's TEE; the vault's signing key lives in OutLayer's Intel TDX enclave (proven on testnet in the custody run). The worker's own calls to the mandate contract are still signed by an agent key.
- OutLayer's wallet policy does not check token payout recipients or amounts, so a stolen worker credential could still move tokens through `/call` on testnet; the executor guards and the mandate contract stop a misbehaving mandate, not a stolen credential.
- OutLayer's team holds governance keys today; Defuse/1Click solvers see swap details before execution; the confidential shard's operator can read it.
- The DAO's funding transfer is public on chain (mitigation: routine operations-float top-ups).
- The wallet-policy owner is a single account in v0 (production: the DAO itself). TEEs rely on Intel and NVIDIA hardware trust.
- Nothing here is audited. This is not investment advice, and all demo funds are test tokens.

## Repository map

`contracts/mandate/` Rust contract · `src/engine/` schema, parser, planner, settlement · `src/near/` NEAR integrations · `src/verify/` independent verifier · `worker/` agent, API, red-team, adapters · `app/` dashboard (Next.js) · `scripts/testnet/` end-to-end runs · `data/demo-run/` recorded runs and proof bundles · `docs/` judges' path, claims, OutLayer custody and feedback, architecture, runbook, sealed mandates, DeFi routes, Trezu notes · `llms.txt` machine-readable map.

## Roadmap

1. A funded mainnet run of the Intents path and confidential swaps, turning today's "quoted" into "proven" (OutLayer custody is already proven on testnet).
2. The DAO itself as the wallet-policy owner (today a single owner account writes the per-mandate policy), and one wallet per mandate so concurrent mandates never share a policy.
3. Token-recipient and token-amount checks at the wallet layer once OutLayer supports them (see docs/OUTLAYER-FEEDBACK.md).
4. The worker inside a TEE so even the operator cannot read sealed terms.

## Libraries and license

near-api-js, zod, @noble/curves, @noble/hashes, vitest, tsx, near-sdk (Rust), Next.js and @near-wallet-selector. The Sputnik DAO v2 contract (near-daos/sputnik-dao-contract) is used unmodified.

License: MIT.

## Hackathon notes

* Built for NEAR HACKATHON 2026. First commit 11 November 2026; the repository history is the working history, including the failures we kept (`docs/incidents/`).
* **AI-assisted:** most code and documentation was written with Claude Code under human direction and review; how each part was verified is in [docs/AI_DISCLOSURE.md](docs/AI_DISCLOSURE.md).
* Decisions and what they rejected: [docs/adr/](docs/adr/). Shared vocabulary: [CONTEXT.md](CONTEXT.md). Self-review: [docs/review-2026-11-14.md](docs/review-2026-11-14.md). Per-track proof map: [docs/TRACKS.md](docs/TRACKS.md).
* Tracks claimed: Social Money (main), Autonomous Business, AI Security & Defense, Privacy & Private AI (private AI only), Real-World Money (testnet payouts), Open Innovation (sealed mandates), Unstoppable DeFi (quoted Intents routes, weakest claim).