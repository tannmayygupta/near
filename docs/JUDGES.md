# For judges: a 5-minute path

Quiet Treasury: a NEAR DAO votes once on a plain-English mandate; a bounded agent executes it in price-floored chunks, pays contributors, returns leftovers and anchors a verifiable settlement report on-chain. Everything below runs on **public NEAR testnet**; nothing was run with mainnet money (see "Not proven").

## 1. Run it (no keys needed)

```
npm ci
npm test              # 134 unit tests (vitest): executor, guards, parser, verifier, custody policy, routes
npm run verify        # independent verifier on three recorded proof bundles (13 + 21 + 13 checks), offline
npm run secret-scan   # 0 findings expected
```

`npm run verify` re-checks, from the bundle alone: NEAR AI nonce echo, EIP-191 signature recovery, signer attested in the TEE report, report hash, every fill >= the price floor, no violations. For the sealed mandate it also proves `sha256(salt|terms)` equals the commitment that was public from the start, and that five kinds of tampering are rejected.

## 2. Check the on-chain claims (public explorer, ~2 minutes)

| Claim | Where to look |
|---|---|
| A DAO vote (2 of 3) creates the mandate; one vote does nothing | `data/demo-run/run.json` -> `txs` (explorer links), DAO `quietdao-83872.sputnikv2.testnet` |
| The DAO funds the agent with a Sputnik `Transfer` proposal | same file, `DAO proposal: Transfer budget` and `funding vote 2/3 -> executes` |
| Real swaps on Ref Finance testnet, real payouts, real returns | `real.swaps`, `real.payouts` in `data/demo-run/run.json` and `data/demo-run/custody-run.json` (every row has a tx hash) |
| The vault is an **OutLayer custody wallet** and the worker writes its policy per mandate | `docs/CUSTODY.md`, `data/demo-run/custody-run.json` -> `layerA.policies` (policy store txs) and `layerA.probes` (403s) |
| Sealed (commit-reveal) mandate | `docs/SEALED.md`, `data/demo-run/sealed-run.json`, dashboard `/sealed` |
| Cross-chain routes are **quoted**, not settled | `docs/DEFI.md`, `data/demo-run/mainnet-readonly.json`, dashboard `/routes` |

Full claim-by-claim table with status (VERIFIED-TESTNET / LOCAL / UNVERIFIED): `docs/CLAIMS.md`.

## 3. See it

`npm --prefix app ci && npm run dashboard` -> http://localhost:3100 (reads the same recorded runs and live testnet RPC). Pages: DAO, wizard, votes, reputation, live run, copycat view, red team, report, routes, **custody**, sealed, verify, ledger.

## 4. Re-run the end-to-end yourself (needs funded testnet accounts and a NEAR AI key; ~10 minutes each)

```
npm run e2e:real       # key-held vault, 29 checks
npm run e2e:custody    # OutLayer custody wallet + per-mandate policy, 35 checks
npm run e2e:sealed     # sealed mandate, 36 checks
npm run e2e:restart    # kill the worker right after a swap landed; a new worker must not swap it twice
```

## Not proven (read this)

* **No mainnet money was moved.** Confidential swaps, Intents cross-chain payouts and OutLayer's Intents path are implemented behind `EXEC_MODE=live` but have never run with real funds. `EXEC_MODE=live-dryrun` runs the live decision path against real 1Click quotes with every money-moving call blocked.
* Testnet tokens have no value and the Ref testnet pool is thin and open to anyone; chunking does **not** beat a one-shot swap there (the report says so, about -1 bp).
* The wallet key is in OutLayer's TEE, but testnet execution is public: there is no hidden-trade claim on testnet.
* OutLayer's wallet policy (Layer A) bounds contracts and native NEAR; it does **not** restrict token payout recipients or token amounts (probed, `data/testnet-outlayer-findings.json`). Those are enforced by the executor guards and the mandate contract (Layer B).
* Trezu (a Sputnik DAO front end) is not integrated; our DAO is a plain Sputnik DAO v2.
