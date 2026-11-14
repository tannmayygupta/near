# The mainnet slice: what it is, what it costs, how to run it

Quiet Treasury was built and proven on public NEAR testnet. This slice puts one **tiny** real mandate on **NEAR mainnet** so that the main claim ("a DAO votes once, a bounded agent executes, anyone can verify") is also shown with real money. It is deliberately small (about US$2 of NEAR is sold). It proves that the machine works with real money; it is not a treasury and makes no claim about size.

Everything runs through the same scripts as the testnet runs, with a network profile (`scripts/mainnet/net.ts`). The scripts can be **rehearsed for free on testnet** (`QT_NET=testnet`) before any real money moves; that rehearsal is what we ran before the real run.

## What is real, and what is not
| | Status |
|---|---|
| A real Sputnik DAO on mainnet (`sputnik-dao.near` factory), council of 3, 2 votes to pass | real; the council accounts are sub-accounts of the owner account, **controlled by the authors**, not by independent people |
| The committed mandate contract wasm, deployed, code hash checked against the file | real |
| The agent drives the contract with a **function-call key** (5 methods, no deposit) | real (Layer 0) |
| NEAR AI Cloud (TEE) parses the intent; signed + attested; independent verifier re-checks the bundle | real |
| A DAO `Transfer` proposal funds the vault; the worker waits for the vote | real |
| About 0.6 NEAR sold in chunks on Ref Finance (pool 4512, wNEAR/USDC) with a price floor, USDC paid to named accounts, a 0.5% fee, leftovers returned to the DAO, report hash anchored | real |
| The vault is a **key held by the worker** | OutLayer custody and its wallet policy (Layer A) are **not** part of the mainnet slice; they are proven on testnet only |
| Cancel run, red team | proven on testnet, not repeated on mainnet |
| Confidential swaps, Intents payouts by the agent | not implemented on mainnet, not claimed |

## What it costs (about 16 NEAR must be in the owner account; most of it stays in accounts you own)
| Line | NEAR | Where it goes |
|---|---|---|
| DAO creation (factory deposit) | 6 | becomes the DAO treasury; the mandate funds from it, leftovers return to it |
| Mandate contract account | 4.3 | about 3.7 is storage staking of the 369 KB wasm (returned only if the account is deleted; **locking it makes it permanent**) |
| Council members | 2.8 | council1 2.0 (the DAO's proposal bond is 1 NEAR and is refunded when a proposal executes), council2 and council3 0.4 each |
| Agent account | 1.9 | 1.5 of it becomes the vault float |
| Three payee accounts | 0.15 | alice, bob, fee |
| Gas for everything | about 0.3 | |
| Sold on Ref | 0.6 | comes back as USDC (to payees, fee and the DAO) |

Use the real NEAR price of the day to convert (about US$3.3 per NEAR on the Ref pool when this was written, so roughly US$50 of NEAR must be on hand, of which only a few dollars are "spent").

## Before you start
0. `$env:QT_SECRET_DIR='D:\qt-secrets'` (or any folder outside OneDrive), then `npm run mainnet:preflight`. It lists, without printing any key, what is missing.
1. A **named** mainnet account (for example `yourname.near`; sub-accounts cannot be created under a 64-hex implicit account) with at least 16 NEAR.
2. Give the scripts its id and full-access secret key. **Do not write the key into `.env` while this repository sits inside OneDrive/Dropbox/iCloud** (the file would be uploaded; the preflight refuses it). Set it only in the shell of the command, for example `$env:QT_FUNDER_ACCOUNT='yourname.near'; $env:QT_FUNDER_KEY='ed25519:...'`, and close the shell afterwards. Never paste the key into a chat, an issue or a commit. If your `.env` is outside a synchronised folder, this also works:
   ```
   QT_FUNDER_ACCOUNT=yourname.near
   QT_FUNDER_KEY=ed25519:...
   NEAR_AI_API_KEY=sk-...        # already there for the testnet runs
   ```
3. Note that every sub-account is named `<something>.yourname.near`, so your owner account id will be visible on mainnet explorers and in the committed run files. That is inherent to using sub-accounts.
4. `git pull`, `npm ci`, `npm test`.

## Rehearsal on testnet (free; recommended once)
```powershell
$env:QT_NET='testnet'
npx tsx --env-file=.env scripts/mainnet/setup.ts          # creates its own free testnet owner, DAO, contract, vault, scoped key
npx tsx --env-file=.env scripts/mainnet/e2e-mainnet.ts    # the same script as the real run, on testnet
Remove-Item Env:QT_NET
```
It writes only to git-ignored files (`data/secret/rehearsal-*`).

## The real run (mainnet)
Each command asks for `ALLOW_MAINNET=1` in its own environment and refuses otherwise.
```powershell
$env:ALLOW_MAINNET='1'
npx tsx --env-file=.env scripts/mainnet/setup.ts          # 1. accounts, DAO, contract, vault, scoped key  (about 15 NEAR leaves the owner account)
npx tsx --env-file=.env scripts/mainnet/e2e-mainnet.ts    # 2. one DAO-voted mandate, real swaps and payouts (about 10 minutes)
npm run verify:mainnet                                    # 3. verifier over the mainnet bundle, offline
$env:LOCK_CONFIRM='I-UNDERSTAND-THIS-IS-IRREVERSIBLE'
npx tsx --env-file=.env scripts/mainnet/lock-contract.ts  # 4. optional, irreversible: delete every key of the contract account
Remove-Item Env:ALLOW_MAINNET, Env:LOCK_CONFIRM
```
Step 4 is optional. It makes the contract immutable (nobody can upgrade it, including us) and costs the ability to ever fix it; do it only after step 2 passed.

## Safety rails in the scripts
* `ALLOW_MAINNET=1` is required by every money-moving command and **must be set in the shell of that command**. A line `ALLOW_MAINNET=...` in `.env` is refused (`scripts/mainnet/net.ts`, tested), so consent can never become permanent and invisible. (An earlier version of this page said it was "never read from `.env`"; that was not enforced until now.)
* Secret files go to `QT_SECRET_DIR` (default `data/secret`). A mainnet command refuses to run when that directory is inside OneDrive/Dropbox/iCloud. This repository sits under OneDrive: set `QT_SECRET_DIR=D:\qt-secrets` first.
* **Contract deploy and `new` are ONE atomic transaction** (no window in which someone else can initialise the contract); one attempt, never a blind retry; the account is read back and checked. Details: `docs/CONTRACT.md`.
* `npm run mainnet:preflight` (read-only) must show READY before setup; `npm run mainnet:verify` and `npm run mainnet:test` (read-only) check the result afterwards. They are different from `npm run verify:mainnet`, which re-checks the *proof bundle* of the e2e run.
* The owner key is read only from the environment and is never printed or written anywhere.
* The mandate budget is capped at 0.6 NEAR in code (`LIMITS.maxSellNear`); the AI cannot raise it.
* The setup refuses to start if the owner holds less than 16 NEAR, and refuses a non-named owner.
* The run refuses to start unless the contract's code hash equals the committed wasm and the contract is initialised for this DAO and agent.
* Swaps only go through Ref pool 4512 and only inside a price band around a live reference quote; if the reference is unavailable the run does not trade (fail closed).
* Every step is idempotent: re-running setup after a failure resumes instead of duplicating; a retried swap cannot act twice (idempotency keys, see ADR 0008).
* If anything fails after the funding vote, **stop and look** before re-running: the DAO can cancel the mandate and the worker returns everything.

## After the run
The scripts write `data/demo-run/mainnet-run.json`, `mainnet-proof-bundle.json` (and `mainnet-lock.json`), plus copies in `app/public/demo-run/`. Public ids go to `data/mainnet-public.json`. None of them contains a key. Then: `npm run check:evidence` (every transaction exists), the dashboard's Recompute page re-derives the mainnet run from mainnet RPC in the browser, and README/CLAIMS/TRACKS get a dated "live on mainnet" row with the real numbers, including the inconvenient ones (authors control the council; a few dollars).
