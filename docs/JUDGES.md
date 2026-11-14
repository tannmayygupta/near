# For judges: a 5-minute path

**Quiet Treasury** turns one DAO vote into a bounded, autonomous, independently verifiable treasury operation on NEAR. A DAO approves a plain-English mandate; a NEAR AI Cloud TEE drafts it; our Rust contract enforces it; an agent executes it in price-floored chunks from an OutLayer wallet, pays contributors, returns leftovers and anchors a settlement report on-chain; anyone can recompute that report in their browser.

The complete flow is demonstrated on **public NEAR testnet**. Every result below names its environment (local, CI or NEAR testnet); the full table is in the [README](../README.md#verification-evidence). Security model and what each layer stops: [SECURITY.md](../SECURITY.md).

## The path

| Min | Do this | You will see |
|---|---|---|
| 0:00 | Open the dashboard: https://tannmayygupta.github.io/near/ | The product story, with the figures read live from the recorded run (37/37 checks, 6 real swaps, 6/6 attacks blocked). |
| 1:00 | **`/recompute`**, pick "OutLayer custody run", click **Recompute in my browser** | Your browser re-reads the mandate from the contract and every chunk and completion transaction from public RPC, then re-derives the commitment hash, sums, price floor and report hash: **11 of 11 agree**. No server of ours is in that path. |
| 2:00 | **`/custody`** and **`/redteam`** | The vault is an OutLayer wallet; the swaps and payouts it signed (each with a transaction link); the wallet policy the worker wrote for the mandate; six attacks, each attributed to the layer that stopped it. |
| 3:00 | **`/votes`** | The Sputnik DAO proposals behind every mandate and every funding transfer, with the council votes. |
| 4:00 | Terminal: `npm ci && npm test && npm run verify` (no keys) | 396 tests pass; the independent verifier passes 13 + 21 + 16 checks over three proof bundles, including tamper cases. |
| 5:00 | `/mainnet` | What has run on mainnet, computed from published files. Today it states that no mainnet run has been executed; the mainnet deployment kit is rehearsed on testnet. |

## 1. Run it (no keys needed)

```
npm ci
npm test              # 396 unit tests (24 files): executor, guards, parser, verifier, custody policy, recompute, deployment sequence, preflight
npm run demo          # the whole story offline (simulation, ~2 s, exit code 0 only if every check holds)
npm run verify        # independent verifier on three recorded proof bundles (13 + 21 + 16 checks), offline
npm run secret-scan   # 0 findings expected (working tree and history)
```

The contract's 36 tests (31 unit + 5 property tests; 37 with the migration build) run in CI and locally in the pinned image (`cargo test --release`). `npm run verify` re-checks, from the bundle alone: NEAR AI nonce echo, EIP-191 signature recovery, signer attested in the TEE report, report hash, every fill at or above the price floor, no violations. For the sealed mandate it also proves `sha256(salt|terms)` equals the commitment that was public from the start, and rejects five kinds of tampering.

With network access:

```
npm run verify:contract   # the contract deployed on testnet has exactly the code hash of the committed contracts/mandate/out/mandate.wasm
npm run check:evidence    # every transaction cited in the README, docs and recorded runs exists on public testnet (201/201; writes data/evidence-check.json; ~10 minutes)
npm run contract:methods  # the contract's public methods, derived from the source and cross-checked against the compiled wasm
```

## 2. Check the on-chain claims (public explorer, ~2 minutes)

| Claim | Where to look |
|---|---|
| A DAO vote (2 of 3) creates the mandate; one vote does nothing | `data/demo-run/run.json` -> `txs` (explorer links), DAO `quietdao-83872.sputnikv2.testnet` |
| The DAO funds the agent with a Sputnik `Transfer` proposal | same file, `DAO proposal: Transfer budget` and `funding vote 2/3 -> executes` |
| Real swaps on Ref Finance testnet, real payouts, real returns | `real.swaps`, `real.payouts` in `data/demo-run/run.json` and `custody-run.json` (every row has a transaction hash) |
| The vault is an **OutLayer custody wallet** and the worker writes its policy per mandate | `docs/CUSTODY.md`, `custody-run.json` -> `layerA.policies` (policy transactions) and `layerA.probes` (403s) |
| A worker killed after a real swap landed does not swap twice | `data/demo-run/restart-run.json` (13/13): the in-flight chunk resolves to the same swap transaction |
| Sealed (commit-reveal) mandate | `docs/SEALED.md`, `data/demo-run/sealed-run.json`, dashboard `/sealed` |
| Cross-chain routes are live-quoted | `docs/DEFI.md`, `data/demo-run/mainnet-readonly.json`, dashboard `/routes` |

Claim-by-claim table with status: [CLAIMS.md](CLAIMS.md). Per-track proof map: [TRACKS.md](TRACKS.md).

## 3. The dashboard

`npm --prefix app ci && npm run dashboard` -> http://localhost:3100 (the same recorded runs and live testnet RPC), or the hosted copy. Sixteen pages: home, wizard, votes, reputation, live run, **my payouts** (`/me`: any account's payouts, fee and returns in the recorded runs plus its live token balance), copycat view, red team, report, routes, **custody**, sealed, verify, ledger, **recompute**, **mainnet**.

## 4. Re-run the end-to-end yourself (funded testnet accounts and a NEAR AI key; ~10 minutes each)

```
npm run e2e:real       # key-held vault, 30 checks
npm run e2e:custody    # OutLayer custody wallet + per-mandate policy, 37 checks
npm run e2e:sealed     # sealed mandate, 37 checks
npm run e2e:restart    # kill the worker right after a swap landed; a new worker must not swap it twice
```

## Scope and environment
* **Demonstrated on public NEAR testnet** (play-money tokens): everything above. **A mainnet run has not been executed**; a deployment kit (atomic deploy-and-initialise, read-only preflight, on-chain verification, contract test script) is implemented and rehearsed on testnet ([MAINNET.md](MAINNET.md)).
* **Live-quoted, not settled:** cross-chain Intents routes and confidential swaps (`EXEC_MODE=live-dryrun` runs the live decision path against real 1Click quotes with every money-moving call blocked).
* **Layer split:** OutLayer's wallet policy bounds contracts and native NEAR; token recipients and amounts are enforced by the executor guards and the mandate contract (probed: `data/testnet-outlayer-findings.json`).
* **Pool behaviour:** the Ref testnet pool is thin and open to anyone, so the executor refuses any pool priced outside a 0.2x-5x band around a live reference quote and fails closed when the quote is missing (`worker/adapters/price-guard.ts`; found and fixed by our own checks: `docs/incidents/2026-11-14-price-band-skipped.md`).
* Trezu (a Sputnik DAO front end) is not integrated; our DAO is a plain Sputnik DAO v2.
