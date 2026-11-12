# Trezu findings (checked 2026-11-12)

Sources: https://trezu.app (browser, no sign-in), https://github.com/NEAR-DevHub/trezu (README, contracts/README), https://github.com/NEAR-DevHub/trezu-docs (confidential-treasuries, swap, payments/bulk-payment).

## What Trezu is
A treasury UI + backend on top of **Sputnik DAO v2**: members/roles (Requestor, Finance, ...), proposals, votes, single + bulk payments (NEAR, NEP-141, cross-chain via NEAR Intents), vesting, **swaps via NEAR Intents (0.7% fee, each swap = one proposal open 24 h)**, CSV export, and **confidential treasuries** (the same multisig contract deployed on a private shard).

## Can it show our DAO (`quietdao-83872.sputnikv2.testnet`)? Not verifiable by us
- `trezu.app` shows a sign-in wall (passkey / NEAR wallet / Ledger / Phantom / EVM wallets) and "Create one". We did **not** sign in or create anything (out of scope, third-party account).
- The repo/docs describe a production backend and mainnet usage; no testnet deployment or testnet DAO flow is documented. The backend can "register an account for monitoring" (nt-be) - that is a write to a third-party service, which we did not do.
- Compatibility in principle: a Trezu treasury **is** a Sputnik DAO v2 contract, the same contract our DAO runs. Roles, policy, proposals and votes our app reads/writes are the standard Sputnik ones, so a mainnet Quiet Treasury DAO created through Trezu would work with our contract/worker unchanged (our mandate contract only needs "predecessor == DAO account"). **This is unverified on mainnet.**
- Therefore: **no deep link was added** to the dashboard (we cannot show that Trezu renders our DAO).

## Bulk payments (possible optional payout path, mainnet only, untested)
- Contract `bulk-payment.near` (mainnet) in `contracts/bulk-payment`: `buy_storage`, `submit_list`, DAO proposal `approve_list` (a plain Sputnik FunctionCall), anyone calls `payout_batch`; supports NEAR, NEP-141, and Intents multi-tokens; <= 100 payments per batch.
- We probed `bulkpayment.testnet`, `bulk-payment.testnet`, `bulk.trezu.testnet`, `trezu.testnet`: none exist, so there is **no known testnet deployment** to test against.
- Proposed (not built, does not change current behaviour): for a **mainnet** run, the settlement step could, instead of the worker paying each contributor itself, submit a payment list and let the DAO approve it with a normal Sputnik `FunctionCall` proposal - payouts then need a second DAO vote (more governance, less autonomy). Only worth it if judges want Trezu in the payout path; the current worker payout path remains the default.

## How Quiet Treasury positions itself relative to Trezu (for the README)
- We build on the same DAO substrate and do **not** rebuild a multisig (the Social Money track asks for exactly this).
- Trezu's swap = one proposal per swap. A Quiet Treasury **mandate** = one vote that authorises a bounded, time-boxed series of private chunks plus payouts and a settlement proof - what communities do *with* the DAO.

## Open items / risks
- Verify on mainnet that a Trezu-created DAO works with our `create_mandate` FunctionCall (needs a mainnet DAO and ~a few NEAR; not done).
- Trezu is mainnet-oriented; the public-testnet run uses a plain Sputnik DAO from `sputnikv2.testnet`.
