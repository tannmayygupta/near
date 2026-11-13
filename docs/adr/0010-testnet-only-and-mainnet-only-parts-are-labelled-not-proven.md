# 0010. Testnet only; mainnet-only parts are labelled "not proven"

Status: accepted (2026-11-12); reaffirmed 2026-11-14

No mainnet funds were moved. Everything we call real is a real transaction on public NEAR testnet. NEAR Intents, confidential swaps and OutLayer's Intents endpoints exist only on mainnet; we implemented them behind `EXEC_MODE=live`, recorded **live dry quotes** from 1Click (`data/demo-run/mainnet-readonly.json`), and added `EXEC_MODE=live-dryrun`, which runs the live decision path with every money-moving call blocked. Their status in every document is "quoted, not executed".

Rejected: **claiming mainnet behaviour we did not run** (checkable on-chain in seconds; it would poison every other claim). **Funding a last-minute mainnet run just to claim it** (a rushed run is worse evidence than an honest label). **Hiding the limit** (the README, JUDGES.md, CLAIMS.md and the forms all state it).

Revisit: a small funded mainnet slice (a DAO, the contract, one real swap) is the single biggest upgrade we know of; it needs a funding decision, not more code.
