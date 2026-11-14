# For judges: a 5-minute path

Quiet Treasury: a NEAR DAO votes once on a plain-English mandate; a bounded agent executes it in price-floored chunks, pays contributors, returns leftovers and anchors a verifiable settlement report on-chain. Everything below runs on **public NEAR testnet**; nothing was run with mainnet money (see "Not proven").

## 1. Run it (no keys needed)

```
npm ci
npm test              # 176 unit tests (vitest): executor, guards, parser, verifier, custody policy, routes; the Rust contract's 36 tests (31 unit + 5 property tests) run in CI (cargo test --release)
npm run demo          # the whole story offline (simulation, ~2 s, exit code 0 only if every check holds)
npm run verify        # independent verifier on three recorded proof bundles (13 + 21 + 16 checks), offline
npm run secret-scan   # 0 findings expected
```

`npm run verify` re-checks, from the bundle alone: NEAR AI nonce echo, EIP-191 signature recovery, signer attested in the TEE report, report hash, every fill >= the price floor, no violations. For the sealed mandate it also proves `sha256(salt|terms)` equals the commitment that was public from the start, and that five kinds of tampering are rejected.

With network access, two more checks:

```
npm run verify:contract   # the contract deployed on testnet has exactly the code hash of the committed contracts/mandate/out/mandate.wasm
npm run check:evidence    # every transaction cited in the README, docs and recorded runs exists on public testnet (writes data/evidence-check.json; ~10 minutes, rate-limited API)
```

## 2. Check the on-chain claims (public explorer, ~2 minutes)

| Claim | Where to look |
|---|---|
| A DAO vote (2 of 3) creates the mandate; one vote does nothing | `data/demo-run/run.json` -> `txs` (explorer links), DAO `quietdao-83872.sputnikv2.testnet` |
| The DAO funds the agent with a Sputnik `Transfer` proposal | same file, `DAO proposal: Transfer budget` and `funding vote 2/3 -> executes` |
| Real swaps on Ref Finance testnet, real payouts, real returns | `real.swaps`, `real.payouts` in `data/demo-run/run.json` and `data/demo-run/custody-run.json` (every row has a tx hash) |
| The vault is an **OutLayer custody wallet** and the worker writes its policy per mandate | `docs/CUSTODY.md`, `data/demo-run/custody-run.json` -> `layerA.policies` (policy store txs) and `layerA.probes` (403s) |
| A worker killed after a real swap landed does not swap twice | `data/demo-run/restart-run.json` (13/13): the in-flight chunk resolves to the same swap tx |
| Sealed (commit-reveal) mandate | `docs/SEALED.md`, `data/demo-run/sealed-run.json`, dashboard `/sealed` |
| Cross-chain routes are **quoted**, not settled | `docs/DEFI.md`, `data/demo-run/mainnet-readonly.json`, dashboard `/routes` |

Full claim-by-claim table with status (VERIFIED-TESTNET / LOCAL / UNVERIFIED): `docs/CLAIMS.md`.

## 3. See it, and check a run in your own browser

`npm --prefix app ci && npm run dashboard` -> http://localhost:3100 (reads the same recorded runs and live testnet RPC), or the hosted static copy: https://tannmayygupta.github.io/near/. Pages: DAO, wizard, votes, reputation, live run, copycat view, red team, report, routes, **custody**, sealed, verify, ledger, **recompute**.

**`/recompute`** is the shortest proof: pick a recorded run and your browser re-reads the mandate from the contract (`qtmandate2-83872.testnet`) and every chunk and completion transaction from public RPC, then re-derives the commitment hash, the chunk sums, the price floor and the report hash. Nothing of ours is trusted in that path: no worker, no database. It is the same code the unit tests run (`app/lib/recompute.ts`, `tests/recompute.test.ts`).

## 4. Re-run the end-to-end yourself (needs funded testnet accounts and a NEAR AI key; ~10 minutes each)

```
npm run e2e:real       # key-held vault, 30 checks
npm run e2e:custody    # OutLayer custody wallet + per-mandate policy, 37 checks
npm run e2e:sealed     # sealed mandate, 37 checks
npm run e2e:restart    # kill the worker right after a swap landed; a new worker must not swap it twice
```

## Not proven (read this)

* **No mainnet money was moved.** Confidential swaps, Intents cross-chain payouts and OutLayer's Intents path are implemented behind `EXEC_MODE=live` but have never run with real funds. `EXEC_MODE=live-dryrun` runs the live decision path against real 1Click quotes with every money-moving call blocked.
* Testnet tokens have no value and the Ref testnet pool is thin and open to anyone; chunking does **not** beat a one-shot swap there (the report says so, about -2 bp). Because that pool is open to anyone, the executor refuses any pool whose price is outside a 0.2x-5x band around a live reference quote and fails closed when the quote is unavailable (`worker/adapters/price-guard.ts`; we shipped without this fail-closed behaviour once and found it ourselves, see `docs/incidents/2026-11-14-price-band-skipped.md`).
* The wallet key is in OutLayer's TEE, but testnet execution is public: there is no hidden-trade claim on testnet.
* OutLayer's wallet policy (Layer A) bounds contracts and native NEAR; it does **not** restrict token payout recipients or token amounts (probed, `data/testnet-outlayer-findings.json`). Those are enforced by the executor guards and the mandate contract (Layer B).
* Trezu (a Sputnik DAO front end) is not integrated; our DAO is a plain Sputnik DAO v2.
