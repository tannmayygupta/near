# RUNBOOK - Quiet Treasury (worker + dashboard on NEAR testnet)

Windows + PowerShell. Node 24, Docker Desktop only for the contract build and the local sandbox. Secrets live in `.env` and `data/secret/` (both git-ignored); never paste them in chat or commit them.

## 1. Start everything (public testnet, simulated fills)
```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\start-testnet.ps1
```
Starts the worker API on **http://localhost:8787** (`EXEC_MODE=simulated`, `SIM_AUTOFUND=1`) and the dashboard (`next dev`) on **http://localhost:3100**. Logs: `data\worker-dev.out.log`, `data\worker-dev.err.log`, `data\app-dev.out.log`, `data\app-dev.err.log`.
- Worker only: add `-WorkerOnly`.
- Health: `Invoke-RestMethod http://localhost:8787/health` -> `ok: true`, `needsHuman: []` (anything in `needsHuman` is a payout/return that failed 4 times and waits for a person).
- Stop: `Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'worker.index.ts|next.*dev' } | % { Stop-Process -Id $_.ProcessId -Force }`.
- First page load in `next dev` compiles each route (slow); open every page once before recording.

## 2. Configuration
| Variable | Meaning |
|---|---|
| `NEAR_NETWORK` | `testnet` (default) / `mainnet` / `sandbox` |
| `DAO_ACCOUNT`, `MANDATE_CONTRACT` | public ids from `data/testnet-public.json` |
| `AGENT_ACCOUNT_ID`, `AGENT_SECRET_KEY` | the account whose key signs `mark_funded` / `record_chunk` / `complete` (the contract's `agent`). Secret: from `data/secret/testnet-named.json` |
| `EXEC_MODE` | `simulated` (testnet adapter, fills tagged `simulated`) or `live` (real OutLayer client; default; UNPROVEN with real money) |
| `OUTLAYER_WK`, `OUTLAYER_BASE_URL` | only for `live` |
| `NEAR_AI_API_KEY` | enables `/api/parse` and signed AI summaries. Must be a NEAR AI Cloud inference key (`sk-...`), not the NEAR Builders MCP key (`api_...`) |
| `SEALED_TERMS_KEY` | 64 hex chars, AES-256-GCM key for sealed terms in the worker DB |
| `STATE_DB` | sqlite path (default `data/worker.sqlite`; dev script uses `data/worker-dev.sqlite`) |
| `MANDATE_FROM_ID` | worker ignores mandates below this id (a fresh DB must not re-handle already-settled mandates). The dev script sets 7 - raise it after recording new mandates |
| `SIM_QUOTE_RECIPIENT`, `SIM_AUTOFUND` | simulated adapter: quote recipient; auto-credit the agent's simulated balance (stand-in for the unproven DAO->agent funding) |
| `LAYER_A_SEED`, `LAYER_A_OWNER_ACCOUNT`, `LAYER_A_OWNER_KEY`, `LAYER_A_ALLOWED` | optional: enable the real OutLayer wallet-policy (Layer A) attacks on `/redteam`; values come from `scripts/testnet/layer-a.ts` (`data/testnet-layer-a.json` + `data/secret`). Without them Layer A attacks show NOT RUN |
| `PORT`, `TICK_MS`, `WORKER_CORS_ORIGIN` | worker port (8787), loop period (5000 ms), allowed browser origin (`*`) |
| `TOKEN_PROFILE` | `testnet` / `mainnet` allowed-token set (default follows `NEAR_NETWORK`): testnet uses `wrap.testnet` + `usdt.fakes.testnet` (Ref Finance testnet pools), mainnet uses the Intents asset ids |
| `SOCIAL_PUBLISH`, `SOCIAL_ACCOUNT_ID`, `SOCIAL_ACCOUNT_KEY` | `1` enables near.social publishing of mandate announcements / treasurer reputation (account defaults to the agent). Secret key only in `.env` |
| `NEXT_PUBLIC_*` | dashboard (public, nothing secret): `NEAR_NETWORK`, `NEAR_RPC`, `DAO` / `DAO_ACCOUNT`, `MANDATE_CONTRACT`, `AGENT_ACCOUNT`, `WORKER_API` |
| `NEAR_TESTNET_RPC`, `NEAR_MAINNET_RPC`, `SANDBOX_RPC` | RPC overrides. Testnet default `https://test.rpc.fastnear.com` |

## 3. Restart, replay, cancel
- **Restart the worker**: it is crash-safe. State is sqlite + the chain + OutLayer request ids; a restart never re-executes a chunk (idempotency key = `<mandateId>:<chunkIndex>:<attempt>`; with OutLayer custody the key is also sent to OutLayer, which deduplicates a replay: proven live in `data/demo-run/restart-run.json`). Just run section 1 again.
- **Reset local worker state**: stop the worker, delete `data\worker-dev.sqlite*`, set `MANDATE_FROM_ID` above the last mandate id, start again.
- **Replay a recorded flow** (creates NEW mandates and proposals on public testnet and spends a few testnet NEAR; the Ref testnet pool is open to anyone and drifts, so if the worker keeps answering `floor_not_met` run `npx tsx scripts\dev\ref-rebalance.ts 57 4.5` first):
  `npm run e2e:real` (29/29, key-held vault, **overwrites** `data/demo-run/run.json` and `proof-bundle.json`: back them up first), `npm run e2e:custody` (35/35, OutLayer custody wallet, writes `custody-run.json`), `npm run e2e:sealed` (36/36), `npm run e2e:restart` (12/12, crash-restart, writes `restart-run.json`); then `npm run verify`.
- **Run the worker with OutLayer custody**: `EXEC_MODE=testnet-outlayer` with `AGENT_ACCOUNT_ID` / `AGENT_SECRET_KEY` (the wallet owner) and `CUSTODY_SEED` (the wallet is deterministic for owner + seed; the worker writes each mandate's wallet policy before it trades, `CUSTODY_POLICIES` = where it remembers them). `/health` then reports `custody: outlayer-custody` and the wallet address. See [CUSTODY.md](CUSTODY.md).
- **Cancel a running mandate**: it is a DAO action. Dashboard -> **Votes** -> the `cancel_mandate` proposal -> Approve with council wallets, or `npx tsx scripts\testnet\dao-flow.ts` for the scripted version. The worker stops within one tick, waits for any in-flight swap, returns everything to the DAO and does not pay out. There is no wallet-freeze button yet.
- **A payout stuck in `needs_human`**: read `/health`, fix the cause (balance / address), and re-trigger by restarting the worker.

## 4. Local NEAR sandbox (Docker) - optional, for contract/DAO tests without testnet
```
docker build -q -t qt-sandbox docker\sandbox
docker rm -f qt-sandbox; docker run -d --name qt-sandbox -p 3030:3030 qt-sandbox
Start-Sleep 25
docker exec qt-sandbox cat /data/.near-sandbox/validator_key.json | Set-Content data\secret\sandbox-root.json -Encoding ascii
npx tsx scripts\sandbox\setup.ts        # real Sputnik DAO from the mainnet factory code
npx tsx scripts\sandbox\dao-flow.ts     # 9/9
npx tsx scripts\sandbox\worker-e2e.ts   # worker e2e with a TEST-ONLY OutLayer stand-in
```
Reset the chain by removing and re-running the container, then repeat `setup.ts`. Build/test the contract: `powershell scripts\build-contract.ps1 -Image rust:latest` (16 unit tests, output `contracts/mandate/out/mandate.wasm`; the old `rust:1.86` image is too old for near-sdk 5.30).

## 5. Loops House CLI
`npx --yes loopshouse auth status` / `credits --event near-hackathon` / `project fields --event near-hackathon` / `evaluate --event near-hackathon --sponsor <slug>` (free; run per claimed track) / `knowledge query --event near-hackathon --sponsor near -q "<question>"` (1 credit). Commands are slow (1-3 minutes) - run them with a long timeout. Never pass `--confirm` to `project create/update` without the user's explicit yes.

## 6. Troubleshooting (all seen in this project)
| Symptom | Cause / fix |
|---|---|
| Testnet calls fail with 429 "deprecated" | `https://rpc.testnet.near.org` throttles polling. Use `https://test.rpc.fastnear.com` (`NEAR_TESTNET_RPC`, `NEXT_PUBLIC_NEAR_RPC`) |
| NEAR AI `401 Invalid or expired API key` | wrong key type. The $10 NEAR Builders credits key and the NEAR Builders MCP key (`api_...`) did not work against `cloud-api.near.ai`; a key created at https://cloud.near.ai (`sk-...`) did. Attestation needs no key; signatures and chat do |
| Wizard `Parsing unavailable` / `unterminated JSON` | the model's answer was cut off. Fixed by `maxTokens: 6000` in `src/engine/parser.ts`; bad intents now return HTTP 422 with a reason. If it returns 502, the NEAR AI request itself failed |
| `JSON.parse` error "Unexpected token" reading a key file | UTF-8 BOM. Write key files with `-Encoding ascii` (or strip `﻿` when reading). Windows PowerShell `Set-Content -Encoding utf8` adds a BOM |
| Text like `â€™` / `â€”` in source or UI | mojibake from re-saving files with PowerShell 5.1 `Get-Content`/`Set-Content`. Edit files with an UTF-8-aware editor; repair by re-decoding |
| Worker flags old mandates `needs_human` ("withdraw failed") | fresh DB re-handled settled mandates. Set `MANDATE_FROM_ID` |
| Copycat page shows no public transactions | NearBlocks v1/v2 are retired; the app uses `/v3/accounts/{id}/txns`. Rate limits show as an explicit error |
| Contract rejections show `WebAssembly trap: unreachable` | known: the release wasm loses the `require!` message. The attack is still blocked; the label says which layer |
| Docker commands fail "cannot connect to dockerDesktopLinuxEngine" | start Docker Desktop and wait ~30 s |
| Sandbox container exits with GLIBC errors | base image too old; `docker/sandbox/Dockerfile` uses `node:24-trixie-slim` |
| `npx loopshouse auth login --provider google` fails `EADDRINUSE :54321` | a previous login process is still waiting; stop it (`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? CommandLine -match loopshouse`) or use `--email <address>` (one-time code) |
| `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` after a CLI command | harmless Node-on-Windows shutdown message; the command already finished |
| `next dev` misbehaves after `npm run build` | they share `.next`; stop dev, delete `app/.next`, start again |
| Public faucet says "Invalid account" for hex accounts | create named testnet accounts instead: `POST https://helper.nearprotocol.com/account {newAccountId, newAccountPublicKey}` gives a free 10 NEAR account |
