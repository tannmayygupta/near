# OutLayer custody on testnet (what is proven, what is not)

Until 2026-11-13 the testnet run used a vault key held by the worker, and OutLayer was only probed for a policy denial. This page covers the change:
**the vault that holds the DAO-funded budget is now an OutLayer agent wallet**, and the worker writes that wallet's policy for each mandate.

## What changed

| Before | Now |
|---|---|
| Vault = `vault.qtagent-68669.testnet`, secret key on the worker | Vault = an OutLayer agent wallet (`testnet-api.outlayer.ai`): the signing key lives in OutLayer's TEE; the worker holds an *owner* credential that can ask the wallet to act and write its policy |
| Wraps, swaps, payouts and returns signed by the worker | Signed by OutLayer through `POST /wallet/v1/call` and `POST /wallet/v1/transfer` |
| Layer A policy: one hand-made policy, native-NEAR probes only | The worker **derives a policy from the DAO-approved terms and stores it before the mandate trades** (`worker/adapters/mandate-policy.ts`, executor hook `prepare`) |

Code: `worker/adapters/signers.ts` (`KeySigner`, `OutLayerCustodySigner`), `worker/adapters/mandate-policy.ts`, `worker/adapters/ref-testnet.ts` (takes a signer), `worker/executor.ts` (`prepare` hook), `worker/index.ts` (`EXEC_MODE=testnet-outlayer`).

## The policy the worker writes for a mandate

* transaction types `call` and `transfer` only
* destinations (whitelist): the sell-token contract, the buy-token contract, the Ref DEX and the DAO (the only account native NEAR may be sent to)
* native NEAR per transaction capped at the mandate budget (never below a 0.05 NEAR floor for storage registrations)
* a rate limit scaled to the number of chunks

Payout and fee accounts are deliberately **not** in the whitelist: token payouts are `ft_transfer` calls whose outer destination is the token contract, so a payee list would look like a protection Layer A does not provide (see below).

It is encrypted by OutLayer's TEE and stored on `outlayer.testnet` by the owner (0.1 NEAR storage deposit per write). It is rewritten when a mandate starts, and only if the rules changed.

## What OutLayer's policy does and does not enforce (probed, `data/testnet-outlayer-findings.json`)

| | Observed |
|---|---|
| Call to a contract not on the whitelist | **Refused**, 403 `policy_denied` |
| Native transfer to an unlisted account, or above the per-transaction cap | **Refused**, 403 `policy_denied` |
| `ft_transfer` sent through `/call` to an unlisted account | **Not inspected**: it went through (only the outer contract is checked) |
| Per-token amount limit (`per_transaction[<token>]`) on a token sent through `/call` | **Not enforced**: 5000 passed a cap of 1000 |
| `POST /wallet/v1/transfer` with a `token` field | **Pitfall**: the field is ignored and `amount` is sent as yoctoNEAR (success + tx hash, token balance unchanged). We first misread this as a token transfer; the end-to-end run caught it (payouts "paid" but balances did not move) and every payout is now an `ft_transfer` call |

So Layer A is real but narrower than we first wrote: it bounds **which contracts** the wallet may touch and **how much native NEAR** may move and to whom. It does **not** restrict who receives a token payout or how many tokens: that is Layer B (executor guards, price floor, chunk sizes, the budget and terms on the mandate contract). That matters for the threat model: Layer B protects against a misbehaving mandate or executor; against a *stolen owner credential* only Layer A applies, and on testnet it would not stop a token drain through `/call`. Mainnet semantics (and the Intents endpoints with recipient pins) were not tested.

## Reproduce

```
npx tsx --env-file=.env scripts/testnet/e2e-custody.ts    # full run with OutLayer custody -> data/demo-run/custody-run.json
npx tsx --env-file=.env scripts/testnet/e2e-restart.ts    # live crash-restart           -> data/demo-run/restart-run.json
npx tsx scripts/testnet/outlayer-probe.ts swap|ft|policyB|policyC   # the probes behind the findings table (note: the `ft`/`policyC` modes use /transfer with a token field: see the pitfall row)
npx vitest run tests/custody.test.ts                      # unit tests (policy derivation, signer mapping, prepare hook)
```

Dashboard page: `/custody`.

## Honest limits

* Testnet has **no hidden execution**: the wallet key is in OutLayer's TEE, but the swaps and payouts are ordinary public testnet transactions. Confidential swaps and Intents payouts remain mainnet-only and unproven.
* OutLayer holds governance keys for its TEE and its coordinator builds the Intents artifacts; we do not claim to remove that trust.
* One wallet serves one mandate at a time: the policy is rewritten per mandate, so concurrent mandates would share the latest policy. A production deployment would use one wallet (seed) per mandate.
* Ref Finance testnet pools are open to anyone and drift: before recording we restored pool 57 with `scripts/dev/ref-rebalance.ts`. Prices on testnet say nothing about mainnet.
