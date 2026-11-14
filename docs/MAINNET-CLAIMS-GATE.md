# Mainnet claims gate: what we may say today, what we may not, and what changes after a mainnet run

Written 14 Nov 2026. **Rule: a sentence about mainnet is allowed only if a file in this repository proves it.** Today no such file exists, so **every mainnet statement is "pending"**. The deployed site enforces the same rule: `/mainnet` reads `demo-run/mainnet-run.json`; with no file it says "Nothing has run on NEAR mainnet yet", and each track's mainnet cell is computed from the file's contents.

## 1. What we can say today (all true, all evidenced)
| Track | Safe sentence today | Evidence | Mainnet |
|---|---|---|---|
| Social Money | "A Sputnik DAO decides; two of three council votes create the mandate and fund the agent. Verified on NEAR testnet." | `data/demo-run/run.json`, `/votes`, `/recompute` | **pending** |
| Autonomous Business | "After the funding vote no human acts until the anchored report; a killed worker resumes without double-swapping; a DAO cancel stops it. Verified on testnet (37/37, 13/13)." | `custody-run.json`, `restart-run.json` | **pending** (crash-restart and cancel are not in the mainnet slice, so they stay testnet-only even after a run) |
| AI Security & Defense | "Three layers (protocol key scope, wallet policy, contract + executor), six attacks blocked, and where each layer stops. Verified on testnet." | `custody-run.json`, `SECURITY.md` | **pending** (wallet policy and the red team are not in the mainnet slice) |
| Privacy & Private AI | "The mandate is parsed and the settlement summarised inside a NEAR AI TEE; every answer is signed and attested and re-verified independently. Hidden execution is not claimed." | `npm run verify` (13+21+16) | **pending** (AI part only) |
| Real-World Money | "Payouts, fee and returns to named accounts, balances checked on-chain, CSV with a transaction on every row, on testnet with play money." | `custody-run.json`, `/ledger` | **pending** |
| Open Innovation (sealed) | "Sealed commit-reveal mandates, independently verified; the operator can read the terms." | `sealed-run.json`, `docs/SEALED.md` | **never** (not part of the mainnet slice) |
| Unstoppable DeFi | "Real Ref swaps on testnet; cross-chain routes live-quoted, not settled." | `/routes`, `docs/DEFI.md` | **pending** (swaps only; Intents settlement is a separate script that has not run) |

Headline wording that is true today: **"Everything works end to end on public NEAR testnet, with explorer-checked evidence. A mainnet slice is built and rehearsed on testnet; it has not been run."**

## 2. What we cannot claim today
1. That anything was **tested, run or "live" on mainnet**, or any "real money" statement (all runs are testnet, play money).
2. A **mainnet contract, DAO or account address** (none exists), or a "verified on mainnet" code hash.
3. **Confidential swaps, hidden trades, Intents settlement or cross-chain payouts** executed (quoted only).
4. **OutLayer custody or its wallet policy on mainnet** (never part of the mainnet slice).
5. **Independent users, independent governance or a decentralised council** (the council accounts are ours; on mainnet the vault would be a worker-held key).
6. A **live hosted worker** (the hosted site is static; the "live worker" strip appears only if a worker is reachable).
7. **"Audited", "production-ready" or "mainnet-ready"** (our own review, not a formal audit; the release gate says NOT READY).
8. **"CI is green"** for the final commit until GitHub reports it.
9. That the contract is **immutable or locked** (it is not deployed, and locking is optional and irreversible).
10. That **sealed terms are hidden from the operator** (they are not).
11. A **price benefit from chunking** (the report says -1 bp on the thin pool).
12. The **prize address**: `docs/submission.md` still holds `PLACEHOLDER` for the NEAR mainnet account that receives the prize; that is yours to fill and is separate from deploying anything.

## 3. Audit of what we already say
Searched every mainnet mention in `README.md`, `llms.txt`, `docs/submission.md`, `docs/TRACKS.md`, `docs/CLAIMS.md`, `docs/JUDGES.md` and `SECURITY.md` (about 70 lines). **None claims mainnet execution**; each either says "testnet", "no mainnet funds", "not proven" or "quoted only" (for example README lines 14, 23, 40, 197; submission lines 14, 17, 43, 73, 102, 120; CLAIMS lines 16-17, 95-97, 123-124; JUDGES line 57; SECURITY line 36). The new landing page and `/mainnet` say the same. So **the submission as written has no mainnet claim that needs removing**. The risk is in what gets added later: do not add a mainnet sentence before section 5's conditions hold.

## 4. What a successful mainnet run WOULD allow, per track
The mainnet slice is one tiny DAO-voted mandate (at most 0.6 NEAR sold, about US$2). If it completes and its files are published, the claim below becomes allowed, **with the stated caveats**. The `/mainnet` page marks a track "shown by the published run" only when the file proves it:

| Track | Becomes claimable | Caveat that must stay in the same sentence | Still not claimable |
|---|---|---|---|
| Social Money | a real mainnet Sputnik DAO approved the mandate and the funding transfer (>= 2 approved proposals) | the three council accounts are controlled by the authors | independent governance |
| Autonomous Business | a mandate completed on mainnet with an anchored report | one tiny mandate; the vault is a worker-held key | crash-restart and cancel on mainnet |
| AI Security & Defense | the agent drove the mainnet contract with a function-call key limited to five methods | no OutLayer policy on mainnet; no red team on mainnet | Layer A and the red team on mainnet |
| Privacy & Private AI | the intent was parsed in a NEAR AI TEE with a signed, attested result and the verifier passed, on the mainnet run | AI part only | hidden execution |
| Real-World Money | real USDC payouts, fee and returns on mainnet to named accounts | the recipients are accounts the authors control; about US$2 | independent recipients |
| Unstoppable DeFi | real Ref swaps on mainnet under the on-chain price floor | Intents settlement not run | Intents settlement (needs the separate owner-run script) |
| Open Innovation (sealed) | nothing | | everything about mainnet |

## 5. After a mainnet run: edit these sentences, and only then
Preconditions, all required: `npm run mainnet:verify` is VERIFIED; the e2e result file shows all checks passing; `mainnet-run.json` and `mainnet-proof-bundle.json` are committed under `data/demo-run/` and `app/public/demo-run/`; `npm run check:evidence` finds every cited mainnet transaction; the site is redeployed so `/mainnet` switches on; CI is green. Then change, in the same commit as the files:

| File and line (today) | Today it says | After the run, say |
|---|---|---|
| `README.md` 14, 23 | "No mainnet money was moved." | "On <date> one tiny DAO-voted mandate ran on NEAR mainnet with real money (<N> NEAR sold; contract `<id>`, code hash `<hash>`). The council accounts are controlled by the authors and the vault is a worker-held key. Everything else ran on testnet." |
| `README.md` 40, 48, 197 | "No mainnet transactions exist." / "Testnet only. No mainnet funds." / "Not done: no mainnet transactions" | the same dated sentence, with the transaction count and a link to `/mainnet` |
| `docs/submission.md` 43, 69, 73 | "no mainnet funds", "no mainnet transactions" | the same dated sentence (copy it from README so the numbers are identical) |
| `docs/submission.md` 14, 17 | `privacy`, `defi` limits | keep "hidden execution NOT claimed" and "no Intents execution"; add the mainnet fact only for what section 4 allows |
| `docs/JUDGES.md` 57 | "No mainnet money was moved." | the same dated sentence |
| `SECURITY.md` 36 | "Testnet only. No mainnet funds were moved" | keep the limits (OutLayer custody and Intents unproven); add the mainnet slice and its caveats |
| `docs/CLAIMS.md` 9-17, 123 | track rows | add a "mainnet" evidence column per section 4; leave the unproven rows UNVERIFIED |
| `docs/TRACKS.md` 3 | "Nothing was run on mainnet." | per-track status "verified on testnet; mainnet slice: <what the run shows>" |
| `app/components/real.tsx` ("What is real here") | "NOT proven (mainnet-only)" box | move only the items the run proves; keep the rest |
| Loops page and X post | | use the dated sentence; never say "fully on mainnet" |

If the run fails or is only partial, nothing in this table changes; the `/mainnet` page stays "NOT RUN" or shows exactly what the file shows.
