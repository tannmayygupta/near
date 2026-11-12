# Quiet Treasury

**Vote once. The agent does the rest, inside limits it cannot break.**

Quiet Treasury lets a DAO approve a plain-English instruction such as *"sell up to 500 NEAR for USDC over 3 days, never below 3.50, then pay these five contributors"*, and turns that single vote into a bounded, verifiable, autonomous execution on NEAR. A private AI drafts the mandate, a Sputnik DAO approves it, our Rust contract enforces it on-chain, an agent carries it out in price-floored chunks, and anyone can independently verify the settlement report afterwards.

Built for **NEAR HACKATHON 2026**. Everything in this repository was written during the hackathon window. The full flow runs for real on **public NEAR testnet** (every step has an explorer link below); the parts that only exist on mainnet are clearly marked as such in [What is proven](#what-is-proven-and-what-is-not).

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
**Proof:** [funding proposal](https://explorer.testnet.near.org/transactions/EdKYXFLoYpQiUAmyPd9nRaZmBd4Jhb6jmHBZbw5PWq36) and [the vote that executes it](https://explorer.testnet.near.org/transactions/Myy7nEZhAhP3SUBSB3vSD7XKio1At8UFYyPhtnW5cma), [DAO-voted near.social post](https://explorer.testnet.near.org/transactions/9Z3Tef3hXnuDSLoMwwWEHdCZgygwDiCzDqQHtDtGQ3c5), the dashboard `/votes` and `/reputation` pages, `worker/guards.ts`, `src/near/sputnik.ts`, `src/near/social.ts`.
**Honest limit:** Trezu needs a wallet sign-in so we could not view our DAO there; a Trezu treasury is a Sputnik DAO v2, the same contract we run (see [docs/TREZU.md](docs/TREZU.md)).

### Autonomous Business - *AI-native businesses that run treasury and payments, where humans only set constraints*
**What the track is about:** operations that run themselves inside rules a human wrote once.
**The problem it solves for us:** a treasury sale is a business process (sell, pay people, return the rest, report) that should not need a human at every step.
**How it works in our scenario:** after the funding vote there is **zero human action** until the anchored report. The agent sells, pays contributors and a service fee, returns leftovers to the DAO and publishes the report by itself. The constraints (budget, window, floor, recipients) live on-chain; the kill switch is a DAO cancel proposal.
**Proof:** [first swap](https://explorer.testnet.near.org/transactions/EL2WhifXaNvx71FPyUTuNJX4XajThDnTww3wSBQixsq9), [alice's payout](https://explorer.testnet.near.org/transactions/FDLQ3ckR1vaoMG7xSSLeT37BSjrbXWhzAMhRGromnwxy), [report anchored on-chain](https://explorer.testnet.near.org/transactions/Euvz3HaJmEpU8cM87LHJn7HxjjbQE7ySgEGy75PBo89b), [DAO cancel mid-run](https://explorer.testnet.near.org/transactions/7J6kTGdY2gfRcoEM8rj4Fi2Lq3GontgAfkBsK3xSCx2Y); `worker/executor.ts`.

### AI Security & Defense - *give AI money without giving it the keys to everything*
**What the track is about:** spending limits, policy engines and attestation for agents that touch money.
**The problem it solves for us:** an autonomous agent with a wallet is only safe if it *cannot* exceed its brief, even if it is wrong or compromised.
**How it works in our scenario:** there are two independent layers. **Layer A** is an OutLayer agent-wallet policy (set programmatically by an owner key) that returns a real HTTP 403 `policy_denied` for an unlisted destination or an over-cap transfer. **Layer B** is our Mandate contract plus the executor guards: over-budget chunks, wrong tokens, trading after expiry, payouts to unlisted addresses, and creating a mandate without a DAO vote are all rejected. Six red-team attacks are runnable from the dashboard and each reports which layer stopped it.
**Proof:** `data/testnet-layer-a.json`, the `/redteam` page, `data/demo-run/run.json` (`redteam`), `src/near/outlayer-policy.ts`, `contracts/mandate/src/lib.rs` (16 unit tests).
**Honest limit:** Layer A was exercised on native NEAR transfers; the confidential endpoints use the same policy engine per OutLayer's docs but were not exercised.

### Privacy & Private AI - *intelligence without exposure*
**What the track is about:** AI and finance that protect sensitive data, with proof rather than promises.
**The problem it solves for us:** the intent (budget, floor, recipients) is commercially sensitive, and a normal LLM API would read it with nothing to verify.
**How it works in our scenario:** the mandate is drafted and the settlement is summarised by a **confidential-TEE model on NEAR AI Cloud** (Qwen3.8-27B). Every answer carries a hardware-backed signature; our verifier recovers the signer, checks it against the attestation report fetched with a fresh nonce, and re-hashes the exact request and response bytes. The dashboard can run the live attestation check in your browser.
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
**Proof:** mandate #12: [create](https://explorer.testnet.near.org/transactions/BFKKpZZ2zo2FfagzLKuEqMU1f7k6PvAM5WXNeNEpiWod), [first swap](https://explorer.testnet.near.org/transactions/5TsHsLYMrHJ4hxdua7T4Ko6EUv5q8S7eTzs1ho4iNVq1), [settlement + reveal](https://explorer.testnet.near.org/transactions/FdSsFwgcCCch3TVaiyegfUichg4RViLkZLEEcTAqbiQ8); `data/demo-run/sealed-proof-bundle.json` (21/21), the `/sealed` page, [docs/SEALED.md](docs/SEALED.md).
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
 Agent worker (TypeScript) ── price-floored chunks ──► DEX swap (Ref on testnet; OutLayer/Intents on mainnet)
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
| OutLayer agent wallet (MPC keys, policy) | Layer A spending policy and red-team denials | `src/near/outlayer.ts`, `src/near/outlayer-policy.ts` |
| NEAR Intents (1Click API) | cross-chain route quotes; live execution path | `src/near/intents.ts`, `worker/` |
| near.social (FastData) | announcements and named-account reputation | `src/near/social.ts`, `worker/social-publisher.ts` |
| Named accounts and NEP-413 | identities and council-only sealed-term access | `worker/auth.ts` |
| Ref Finance (testnet DEX) | real on-chain swaps | `worker/adapters/ref-testnet.ts` |

## What is proven, and what is not

| | Status |
|---|---|
| DAO votes create, fund and cancel mandates; no execution before approval | **Proven on public testnet** (real transactions) |
| Chunked swaps with a price floor, real payouts, fee, leftover returns, anchored report | **Proven on public testnet** (`mode: testnet-real`, 29/29 checks) |
| Sealed commit-reveal with tamper detection | **Proven on public testnet** (36/36 run, verifier 21/21) |
| Private-AI outputs signed, attested and independently verified | **Proven** (live NEAR AI Cloud; verifier 13/13) |
| OutLayer wallet policy blocks attacks | **Proven on testnet** (native transfers) |
| near.social posts and reputation from named accounts | **Proven on testnet** |
| OutLayer-custody swaps, confidential (hidden) swaps, Intents cross-chain payouts | **Implemented and quoted against live APIs; not executed with real money** (mainnet-only; no funds were committed) |

Testnet tokens are play money. On testnet the agent signs with a worker-held vault key, so there is no confidentiality there; the OutLayer-custody design is the mainnet path. Full row-by-row status with evidence: [docs/CLAIMS.md](docs/CLAIMS.md).

## Verify it yourself

```bash
npm install
npx vitest run                                              # 100+ tests: parser, planner, settlement, verifier, worker edge cases, sealed checks
npx tsx src/verify/cli.ts data/demo-run/proof-bundle.json   # independent verification of the recorded run (13/13)
npx tsx src/verify/cli.ts data/demo-run/sealed-proof-bundle.json   # sealed commit-reveal verification (21/21, incl. tamper cases)
powershell scripts/build-contract.ps1                       # build + test the Rust contract in Docker
cd app && npm install && npm run dev                        # dashboard (reads the committed recorded run)
```

To reproduce the live testnet run (needs a `NEAR_AI_API_KEY` in `.env`; testnet accounts are free) see [docs/RUNBOOK.md](docs/RUNBOOK.md): `scripts/testnet/setup.ts`, `e2e-real.ts` (about 12 minutes), `e2e-sealed.ts`.

Deployed testnet ids: DAO `quietdao-83872.sputnikv2.testnet`, mandate contract `qtmandate-83872.testnet`, vault `vault.qtagent-68669.testnet` ([`data/testnet-public.json`](data/testnet-public.json)).

## Security and trust model

- The AI only *proposes*. Hard bounds are re-checked in the parser, the worker and the contract; the AI never holds keys.
- The worker is not in a TEE in v0, so it sees the mandates it executes. AI inference runs in NEAR AI's TEE; on mainnet the wallet keys would live in OutLayer's Intel TDX enclave.
- OutLayer's team holds governance keys today; Defuse/1Click solvers see swap details before execution; the confidential shard's operator can read it.
- The DAO's funding transfer is public on chain (mitigation: routine operations-float top-ups).
- The wallet-policy owner is a single account in v0 (production: the DAO itself). TEEs rely on Intel and NVIDIA hardware trust.
- Nothing here is audited. This is not investment advice, and all demo funds are test tokens.

## Repository map

`contracts/mandate/` Rust contract · `src/engine/` schema, parser, planner, settlement · `src/near/` NEAR integrations · `src/verify/` independent verifier · `worker/` agent, API, red-team, adapters · `app/` dashboard (Next.js) · `scripts/testnet/` end-to-end runs · `data/demo-run/` recorded runs and proof bundles · `docs/` architecture, runbook, claims, sealed mandates, Trezu notes.

## Roadmap

1. A funded mainnet run of the OutLayer-custody and Intents path, turning today's "quoted" into "proven".
2. The DAO itself as the wallet-policy owner, with per-mandate policy updates.
3. The worker inside a TEE so even the operator cannot read sealed terms.

## Libraries and license

near-api-js, zod, @noble/curves, @noble/hashes, vitest, tsx, near-sdk (Rust), Next.js and @near-wallet-selector. The Sputnik DAO v2 contract (near-daos/sputnik-dao-contract) is used unmodified.

License: MIT.
