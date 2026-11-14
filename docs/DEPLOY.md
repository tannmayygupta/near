# DEPLOY (config only - nothing has been deployed and no accounts were logged in)

A hosted demo is a bonus ("keep it up to 2026-11-18, ideally 2026-11-25"). Judges can run the repo locally, so deployment never blocks submission.

## Option 0 (recommended for judges): static hosted demo on GitHub Pages (no login, no server, no secrets)
The dashboard exports as a fully static site: `.github/workflows/pages.yml` builds `app/` with `STATIC_EXPORT=1`, `NEXT_PUBLIC_STATIC_DEMO=1` and `NEXT_PUBLIC_BASE_PATH=/<repo name>`, using only the public ids in `data/testnet-public.json`, and publishes `app/out`.
- **One-time owner step:** GitHub repo **Settings > Pages > Build and deployment > Source = "GitHub Actions"**. The next push to `main` that touches `app/` (or *Actions > Deploy static demo to GitHub Pages > Run workflow*) deploys it.
- **Final URL:** https://tannmayygupta.github.io/near/ (the `/near` sub-path comes from the repo name; the sealed page is `/near/sealed/`).
- **What works there:** every page reads the committed recorded runs (`app/public/demo-run/*.json`) and the public NEAR testnet RPC (`https://test.rpc.fastnear.com`) live from the visitor's browser: DAO, votes, reputation, live run, report, sealed, verify, ledger, copycat. Wallet login uses MyNearWallet in the browser.
- **What needs the worker (shown as "run it locally" instead of an error):** parsing a new intent in the wizard and firing live red-team attacks. Recorded results of the attacks are shown. If the owner hosts a worker and sets the `WORKER_API` repository variable (next section), the page pings it at run time, shows a green "Live worker connected" strip and switches those two features on; if the worker is unreachable it falls back to exactly this recorded mode.
- **Local check of the export:** `cd app && STATIC_EXPORT=1 NEXT_PUBLIC_STATIC_DEMO=1 NEXT_PUBLIC_BASE_PATH=/near npm run build`, then serve `app/out` under `/near` (for example copy it to a temp folder named `near` and run `npx serve <parent>`).

## Hosted worker (testnet): make the static site live for a stranger
Config only: `render.yaml` (Render Blueprint, recommended) and `fly.toml` (alternative) are in the repo root, both build the existing `Dockerfile`. **Nothing has been deployed, no account was logged in, and no value below is a real secret.** With a worker attached, a visitor to https://tannmayygupta.github.io/near/ can parse a new intent with the private AI, fire the live red-team attacks and see the worker's live attestation check; without it (or when it is asleep or down) the site is exactly today's recorded, read-only demo.

**What the public worker exposes (everything on testnet):** `GET /health` (rate-limit exempt: tick age, items needing a human, attestation age and result), `GET /attestation` (live NEAR AI check, below), the read-only `/api/*` views, `POST /api/parse` (spends your NEAR AI credits) and `POST /api/redteam/:attack`. It never exposes a key or a sealed term: `/api/sealed-terms` and sealed `/terms` need a council wallet signature (NEP-413).

### Environment variables (names are the real ones from `worker/config.ts` and `worker/index.ts`)
| Variable | Required | Value / where it comes from | Secret |
|---|---|---|---|
| `EXEC_MODE` | **yes** | `testnet-outlayer` (the default is `live`, which needs a mainnet OutLayer key: never use it here) | no |
| `NEAR_NETWORK` | no (default `testnet`) | `testnet` | no |
| `REQUIRE_SCOPED_KEY` | recommended | `1`: the worker refuses to start unless `AGENT_SECRET_KEY` is the 5-method function-call key | no |
| `WORKER_CORS_ORIGIN` | **yes** (default `*`) | `https://tannmayygupta.github.io` (origin only: no path, no trailing slash) | no |
| `DAO_ACCOUNT` | **yes** | `dao` in `data/testnet-public.json` (`quietdao-83872.sputnikv2.testnet`) | no |
| `MANDATE_CONTRACT` | **yes** | `mandateContract` in `data/testnet-public.json` (`qtmandate2-83872.testnet`) | no |
| `AGENT_ACCOUNT_ID` | **yes** | `agent` in `data/testnet-public.json` (`qtagent-68669.testnet`) | no |
| `AGENT_SECRET_KEY` | **yes** | `secretKey` in `data/secret/agent-scoped-key.json`: the **function-call** key limited to `mark_funded`, `record_chunk`, `begin_settlement`, `complete`, `expire` on the mandate contract | **yes** |
| `CUSTODY_OWNER_KEY` | **yes** in this mode | `accounts.agent.secretKey` in `data/secret/testnet-config.json`: the agent account's **full-access** key, needed because writing an OutLayer wallet policy attaches a deposit (a scoped key cannot) | **yes** |
| `CUSTODY_SEED` | **yes** in this mode | `quiet-treasury-custody-<suffix>`, the seed of the recorded custody run (`scripts/testnet/custody.ts`; `<suffix>` is `suffix` in `data/secret/testnet-config.json`, the number in the DAO account name). The wallet is deterministic for owner + seed | treat as yes |
| `SIM_QUOTE_RECIPIENT` | **yes** in this mode | the public 64-hex `wallet.address` in `data/testnet-layer-a.json`: only the recipient of a read-only 1Click price quote | no |
| `SEALED_TERMS_KEY` | **yes in practice** (the worker's state store throws at boot without it) | any 64 hex characters: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | **yes** |
| `MANDATE_FROM_ID` | **yes** | `14` = 1 + the highest mandate id on the contract (ids 0 to 13 existed on 2026-11-14, read with `list_mandates`). A fresh worker must not re-handle settled or **cancelled** mandates: it would try to return their budget again and park the items in `needsHuman`. Raise it if you create more mandates | no |
| `NEAR_AI_API_KEY` | for parsing | a NEAR AI Cloud inference key (`sk-...`; the Builders MCP key `api_...` does not work). Without it `/api/parse` answers 503 and `/attestation` reports `ok:false` ("signature check was not run") | **yes** |
| `NEAR_TESTNET_RPC` | recommended | `https://test.rpc.fastnear.com` | no |
| `STATE_DB`, `REF_LEDGER`, `CUSTODY_POLICIES` | recommended | `/data/worker.sqlite`, `/data/ref-ledger.json`, `/data/custody-policies.json` (the last two default to a relative `data/` path inside the container; keep all three on the disk if you attach one) | no |
| `PORT` | no | **Do not set it on Render** (Render injects its own and detects it). `8787` on Fly | no |
| `ATTESTATION`, `ATTESTATION_MODEL` | no | `ATTESTATION=0` turns the live check off; `ATTESTATION_MODEL` defaults to the parse model (`PARSE_MODEL`, default `Qwen/Qwen3.8-27B`) | no |
| `PARSE_PER_HOUR` | no (60) | global cap on `/api/parse` calls per hour for all visitors together | no |
| `REDTEAM_CACHE_S`, `REDTEAM_CHAIN_PER_HOUR`, `REDTEAM_CHAIN_PER_DAY`, `REDTEAM_WALLET_PER_HOUR` | no (600 s, 6, 30, 6) | red-team protections below | no |
| `ALERT_TELEGRAM_TOKEN`, `ALERT_TELEGRAM_CHAT` | no | both or neither; alerts for stuck items, a stale tick, a low vault | token: yes |
| **Never set on a public host** | | `OUTLAYER_WK`, `ALLOW_MAINNET`, `LAYER_A_*` (see below), `VAULT_SECRET_KEY` | |

### Owner steps, Render (recommended)
1. Push this repo state to GitHub (`render.yaml` is read from the repo).
2. https://dashboard.render.com > **New > Blueprint** > connect the repository > pick the branch. Render reads `render.yaml`, lists the service `quiet-treasury-worker` and **asks for the five secret values** (`AGENT_SECRET_KEY`, `CUSTODY_OWNER_KEY`, `CUSTODY_SEED`, `SEALED_TERMS_KEY`, `NEAR_AI_API_KEY`). Paste them from the files named in the table above (open the file locally, copy the single field; never paste a whole file, never commit one). Everything else is prefilled.
3. Click **Apply**. The first build takes a few minutes (it runs `npm ci`). If you want state to survive restarts, first change `plan` and uncomment `disk` in `render.yaml` (paid instances only).
4. When the service is **Live**, copy its URL (`https://quiet-treasury-worker-xxxx.onrender.com`; the real name is shown in the dashboard) and check it, replacing `$W` with that URL:
   ```
   curl.exe -s $W/health
   curl.exe -s $W/attestation
   ```
   `/health` must show `"ok":true`, `"execMode":"testnet-outlayer"`, `"custody":"outlayer-custody"`, `"needsHuman":[]` and an `attestation` object. `/attestation` must show `"ok":true` and a `signingAddress` after about a minute (the first check runs at boot). If the service does not start, **Logs** has one JSON line listing every configuration problem at once (`invalid configuration`).
5. Point the site at it: GitHub repo **Settings > Secrets and variables > Actions > Variables > New repository variable**: name `WORKER_API`, value `$W` (https, no trailing slash; it is a public URL, not a secret). Then **Actions > Deploy static demo to GitHub Pages > Run workflow** (a variable change alone does not trigger a build). `NEXT_PUBLIC_WORKER_API` is inlined at build time, so every change of the URL needs this re-run.
6. Open https://tannmayygupta.github.io/near/ : a green **Live worker connected** strip replaces the grey banner, **Parse with private AI** (New mandate) and **Run attack** (Red team) switch on. If it stays grey the worker is unreachable (see caveats); the page keeps retrying every 15 s while the tab is open.
7. To turn it off again: delete the `WORKER_API` variable and re-run the Pages workflow (or suspend the Render service: the site falls back to the recorded demo by itself).

### Owner steps, Fly.io (alternative; commands are also at the top of `fly.toml`)
`fly launch --no-deploy --copy-config --name <your-app> --region <region>`, `fly volumes create qt_data --region <region> --size 1`, `fly secrets set AGENT_SECRET_KEY=... CUSTODY_OWNER_KEY=... CUSTODY_SEED=... SEALED_TERMS_KEY=... NEAR_AI_API_KEY=...`, `fly deploy`. Then steps 4 to 7 above with your `https://<your-app>.fly.dev`. Fly no longer has an unconditional free tier: check the current pricing first. The `app` name in `fly.toml` must be globally unique.

### Free-tier caveats (read before relying on it)
- **Sleep and cold start (Render free):** a web service with no inbound request for 15 minutes spins down and the next request takes about a minute to wake it. The first `/health` ping from the dashboard wakes it (the strip turns green after up to a minute, on its own). While a visitor keeps the tab open the 15 s ping keeps it awake; an idle site lets it sleep, and while asleep **no agent loop runs and no alerts are sent** (the mandates need no worker until someone creates one).
- **Ephemeral disk:** a free Render service cannot attach a persistent disk. The sqlite state, the Ref ledger and the wallet policy file are lost on every restart, redeploy and spin-down. That is safe here only because the chain is the source of truth and `MANDATE_FROM_ID` hides every old mandate. **Do not run a real mandate (new funding vote, sealed terms delivered to the worker) on a worker without a persistent disk**: it would forget its in-flight chunks and delivered sealed terms on the next sleep. The crash-safety proven in `restart-run.json` assumes sqlite survives.
- **750 free instance hours per month** per Render workspace: a service that never sleeps (kept awake by pings) uses about 720, so one always-on free service just fits and a second one does not. Cold start also means the first red-team/parse request after a sleep is slow.
- **Browser rules:** the site is https, so the worker URL must be https (Render and Fly are); `WORKER_CORS_ORIGIN` must equal the site's origin exactly or the browser blocks every call and the strip stays grey.
- **A restart re-runs the attestation check** (one cheap signed completion, then at most one per hour) and the OutLayer wallet lookup; if OutLayer's testnet API is down at boot the worker exits and the platform restarts it.

### Keys on a third-party host are TESTNET keys only
`AGENT_SECRET_KEY` and `CUSTODY_OWNER_KEY` become environment variables on a company's servers you do not control, and `CUSTODY_OWNER_KEY` is a **full-access key of the agent account**. Only testnet accounts (`*.testnet`, no value) may ever be used this way: the worker refuses `mainnet` without `ALLOW_MAINNET=1` and a cross-network account mix-up, and this guide never sets either. Do **not** put a mainnet key, an OutLayer mainnet `OUTLAYER_WK`, a wallet seed phrase or any key that guards real money on this host. Rotate the keys if a service log or dashboard is ever shared. The worker is written not to log them (the startup guard logs only the public key and its scope; the Telegram sink is unit-tested not to log its token), but a host's own dashboard shows you the values you typed.

### What a stranger can and cannot do to a public worker (checked in `tests/redteam-safety.test.ts`, `tests/attestation.test.ts`)
- **Red team.** Every attack can only be refused: an expiry attack is sent to the contract only where the contract must refuse it for good (a finished mandate or an elapsed window plus 30 s), never to an `Approved` mandate that could still be funded (the contract would record the 1-unit chunk and corrupt the mandate's accounting: fixed 2026-11-14); a "success" of an over-budget call that the contract merely ignored is reported as inconclusive, not as accepted. An attack that was not attempted answers `layer: "n/a"` (shown as NOT RUN), never blocked.
- **Cost.** A reverted contract call still burns gas from the agent key's 2 NEAR allowance. So the attacks that send a transaction (`non_dao_create`, `over_budget`, `after_expiry`) share a **global** budget (6 per hour, 30 per day, all visitors together; attacks that were not attempted are refunded), a repeat of the same attack on the same mandate is answered from memory for 10 minutes and labelled `cachedAgeS`, concurrent identical requests share one attack, and each client gets 6 red-team requests a minute (`429` with `retry-after`). `/api/parse` has 20 a minute per client and `PARSE_PER_HOUR` (60) for everyone.
- **Default target.** The Red team page attacks the recorded run's mandate #11 (completed, public terms). The worker reads an explicit target straight from the chain, so `MANDATE_FROM_ID` does not hide it. Without a mandate in an executable state the guard attacks still run against #11, and `over_cap` (Layer A) answers NOT RUN.
- **Layer A probe: leave `LAYER_A_*` unset.** With it, `unlisted_payout` and `over_cap` make real OutLayer testnet transfers (0.01 and 0.5 NEAR) from that probe wallet that the wallet policy is expected to refuse; if the policy ever failed open they would move that testnet NEAR. They are budgeted (6 per hour) but the safe public setting is to leave them unconfigured: the dashboard then shows the recorded Layer A results.
- **No secrets, no sealed terms in answers.** Every red-team answer and every API 500 passes a scrubber (the exact secret values of the worker's environment plus key, bearer-token and API-key shapes). Guard messages only name the attacker's own input and public budget numbers, so a sealed mandate's payout list, fee recipient and price floor never appear (tested).
- **Attestation endpoint.** `GET /attestation` returns `{ok, checkedAt, ageSeconds, nonce, model, signingAddress, checks[], note}`. It checks: fresh 256-bit nonce, confidential TEE model, attestation report fetched for that nonce, nonce echoed by gateway and model attestations, one signed completion whose signed text matches `sha256(request):sha256(response)`, whose signature recovers to the claimed address, and whose address is listed in the attestation report. **Not checked: the Intel TDX / NVIDIA quote itself** (`docs/CLAIMS.md`). The result is cached for an hour (a failure for one minute), refreshed in the background, shared by concurrent requests and never throws: NEAR AI unreachable or `NEAR_AI_API_KEY` missing is `ok:false` with the reason. Each fresh check costs one tiny completion.

## Option 1: free Cloudflare quick tunnel (no login, PC must stay on)
`powershell scripts\dev\tunnel.ps1` (needs `C:\Program Files (x86)\cloudflared\cloudflared.exe`). It tunnels the worker (8787) and the dashboard (3100) and prints two `https://*.trycloudflare.com` URLs; links change on every restart. Use `-RestartDashboard` so the dashboard is rebuilt with `NEXT_PUBLIC_WORKER_API` pointing at the worker tunnel (browser-side code cannot reach `localhost`). **The public worker URL also exposes `/api/parse`, which spends your NEAR AI credits** - leave the tunnel up only while demoing or set `NEAR_AI_API_KEY` empty for the tunnelled worker.

## Option 2: Railway (worker) + Vercel (dashboard)
**Worker on Railway** (personal account only; the Railway CLI on this PC was logged into the WORK account earlier - do not deploy there):
1. New project from the GitHub repo; Railway reads `railway.json` and builds the root `Dockerfile` (a Dockerfile build avoided the Railpack GitHub-download timeouts seen before).
2. Add a **volume mounted at `/data`** (dashboard setting; cannot be set in `railway.json`). The worker keeps sqlite at `/data/worker.sqlite`.
3. Variables: `NEAR_NETWORK=testnet`, `EXEC_MODE=simulated`, `SIM_AUTOFUND=1`, `DAO_ACCOUNT`, `MANDATE_CONTRACT`, `AGENT_ACCOUNT_ID`, `AGENT_SECRET_KEY`, `SIM_QUOTE_RECIPIENT`, `SEALED_TERMS_KEY` (64 hex), `MANDATE_FROM_ID`, `NEAR_TESTNET_RPC=https://test.rpc.fastnear.com`, optional `NEAR_AI_API_KEY`, `WORKER_CORS_ORIGIN=<dashboard URL>`. Never put the mainnet `OUTLAYER_WK` here unless running `EXEC_MODE=live`.
4. Health check path `/health` (set in `railway.json`).

**Dashboard on Vercel** (`app/` as the project root, framework Next.js): set the public env vars in the project settings, then deploy:
`NEXT_PUBLIC_NEAR_NETWORK=testnet`, `NEXT_PUBLIC_NEAR_RPC=https://test.rpc.fastnear.com`, `NEXT_PUBLIC_DAO=<dao>`, `NEXT_PUBLIC_DAO_ACCOUNT=<dao>`, `NEXT_PUBLIC_MANDATE_CONTRACT=<contract>`, `NEXT_PUBLIC_AGENT_ACCOUNT=<agent>`, `NEXT_PUBLIC_WORKER_API=https://<railway-worker-url>`. Values for testnet are in `data/testnet-public.json` (public). `NEXT_PUBLIC_*` values are inlined at build time, so redeploy after changing them. The Vercel CLI is not installed here (`npm i -g vercel` then `vercel login`).

## Local Docker check of the worker image
`docker build -t qt-worker .` then `docker run --rm -p 8787:8787 -v qt-data:/data --env-file <your-worker-env-file> qt-worker` (the env file is yours; it is not in the repo and `.dockerignore` keeps `.env` and `data/secret` out of the image).
