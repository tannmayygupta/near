# Feedback for OutLayer (from building Quiet Treasury on OutLayer testnet, 13 Nov 2026)

We moved our testnet vault onto an OutLayer agent wallet (`docs/CUSTODY.md`). Four things we hit, with reproductions. Transaction hashes are on public testnet; list a tx's actions with `npx tsx scripts/dev/tx-inspect.ts <wallet> <hash>`. Wallet: `98b125dbd9790b6fd836825fb3b94d0f23df6e931fad5ad62fd74f14739f89f7`.

## 1. `POST /wallet/v1/transfer` accepts a `token` field and ignores it (silent wrong action)
`{"chain":"near","to":"qtcontrib-68669.testnet","amount":"5000","token":"usdt.fakes.testnet"}` answers `status: success` with a tx hash, but the transaction is a native `Transfer{deposit: 5000}` (5000 yoctoNEAR). The wallet's USDT.e balance does not change.
Evidence: `DZWckMfTyURkAnfqQvinLSFUM7md51pgNeXz1UeweoUH` (5000), `HGNChkKAndJTjLzV6hYdxoZ3TnQMn3pQ7zbSwxs8Ag7g`, `FqRnfv6zWF5Xdrj6bgEcE6RF7XumN1XzN6roAK71EcN8` (2000 each).
Why it hurts: our first end-to-end run reported every payout as paid while recipients received nothing. Suggestion: reject unknown fields, or support FT transfers on this endpoint (and apply the recipient whitelist to them).

## 2. The wallet policy does not look inside an `ft_transfer` sent through `/call`
With a whitelist that excludes `qttreasurer-83872.testnet`, `/call` `ft_transfer` to that account succeeds (`6qL3FxJqdmhEgFTv6NFbUY5du4Bkm7oXsLfYmbbj1tpF`); only the outer contract (`usdt.fakes.testnet`) is checked. A per-token cap `limits.per_transaction[usdt.fakes.testnet] = 1000` did not stop an `ft_transfer` of 5000 (`6HPv2eU119PodesGj6Rbox4hPUk9x9mmPSdmGrxSaFPj`; policy store `3xrbwDZMggK5k75CxMQQg14viRnFEttnJJUjBKftoiu1`).
The docs say FT sends go through `/call` with `ft_transfer`, so a recipient whitelist cannot protect token payouts today. Suggestion: decode `ft_transfer` / `ft_transfer_call` arguments in the policy engine, or document that token recipients are not policy-checked.

## 3. A replayed idempotency key answers HTTP 200 without a top-level `tx_hash`
Replaying `X-Idempotency-Key` on `/wallet/v1/call` returns `{"error":"duplicate_idempotency_key","status":"success","request_id":...,"result":{"tx_hash":"...","result":"0",...}}`: the hash is under `result.tx_hash`, while a first call returns it at the top level. Clients that read `tx_hash` at the top level see "success without a hash". We handle both (`txOfResponse` in `worker/adapters/signers.ts`); a consistent shape, or a 409, would be easier.

## What worked well (and we rely on)
* Programmatic policy: `encrypt-policy` -> `sign-policy` -> `store_wallet_policy` (`src/near/outlayer-policy.ts`), rewritten per mandate.
* `/call` for arbitrary contract calls (wrap, Ref `ft_transfer_call`, `storage_deposit`) with correct on-chain failure reporting (HTTP 422 `onchain_tx_failed`).
* Idempotency really deduplicates: after a simulated worker crash a replayed swap resolved to the original transaction instead of swapping twice (`data/demo-run/restart-run.json`, 13/13).
* Clear 403 `policy_denied` messages naming the address or limit.
