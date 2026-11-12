# DEPLOY (config only - nothing has been deployed and no accounts were logged in)

A hosted demo is a bonus ("keep it up to 2026-11-18, ideally 2026-11-25"). Judges can run the repo locally, so deployment never blocks submission.

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
