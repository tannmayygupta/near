# 0004. The vault is an OutLayer custody wallet, with a policy written per mandate

Status: accepted (2026-11-13)

The first recorded run used a vault key held by the worker. That is the weakest part of any "bounded agent" story, so the custody run moves the budget into an **OutLayer agent wallet**: its signing key lives in OutLayer's TEE; the worker holds only an owner credential. Wraps, Ref swaps, payouts, fee and returns are signed by OutLayer through `/wallet/v1/call` and `/transfer`, with an idempotency key on every money-moving call. Before a mandate trades, the worker derives a wallet policy from the DAO-approved terms and stores it (`worker/adapters/mandate-policy.ts`).

Rejected: **keeping the worker-held key as the final design** (kept only as `EXEC_MODE=testnet-real` for comparison). **Binding the wallet to the DAO account** (OutLayer answers 409). **A policy that lists payout addresses** (probed: OutLayer does not inspect `ft_transfer` arguments, so that would look like protection it does not give; ADR 0005).

Consequences: one wallet serves one mandate at a time (the policy is rewritten per mandate). Testnet has no hidden execution: the key is in a TEE, the trades are public.
