# 2026-11-13: payouts "paid" but nobody received a token

Status: closed (fixed in `b60efc9`, re-verified by the 36/36 custody run)

## Summary
The first end-to-end run with the vault on an OutLayer wallet reported every payout, the fee and the leftover return as `item_paid`. The end-to-end balance checks then failed: Alice +0 (expected 752,605), Bob +0, operator +0, DAO USDT.e unchanged. The worker had sent token payouts with `POST /wallet/v1/transfer` and a `token` field. OutLayer **ignores** that field and sends `amount` as yoctoNEAR: the request answers `success` with a transaction hash.

## Identifiers
| What | Value |
|---|---|
| Wallet | `98b125dbd9790b6fd836825fb3b94d0f23df6e931fad5ad62fd74f14739f89f7` |
| Dust "payouts" (actions are `Transfer{deposit: 5000 / 2000 / 2000}` yoctoNEAR) | `DZWckMfTyURkAnfqQvinLSFUM7md51pgNeXz1UeweoUH`, `HGNChkKAndJTjLzV6hYdxoZ3TnQMn3pQ7zbSwxs8Ag7g`, `FqRnfv6zWF5Xdrj6bgEcE6RF7XumN1XzN6roAK71EcN8` |
| Real token transfers through `/call` (balance moved) | `6qL3FxJqdmhEgFTv6NFbUY5du4Bkm7oXsLfYmbbj1tpF`, `6HPv2eU119PodesGj6Rbox4hPUk9x9mmPSdmGrxSaFPj` |
| Evidence | `data/testnet-outlayer-findings.json` F3; list a tx's actions with `npx tsx scripts/dev/tx-inspect.ts <wallet> <hash>` |

## Timeline (UTC, 13 Nov)
* 16:10 first custody run starts; trading and policy writes succeed.
* 16:25 run finishes trading; payout checks fail (balances unchanged) while items say paid.
* 16:30 the stopped run is inspected on-chain: the "payouts" are 2000-5000 yoctoNEAR transfers.
* 16:45 payouts changed to `ft_transfer` calls; rerun passes 35/35.

## Why
Ours: our first probe read `success` + a tx hash as proof of a token transfer and we did not check the token balance. Theirs: the endpoint accepts an unknown field and silently does something else (reported in `docs/OUTLAYER-FEEDBACK.md`).

## What changed
* `OutLayerCustodySigner.sendToken` sends `ft_transfer` through `/call` (`worker/adapters/signers.ts`); `OutLayerWallet.transfer` is documented native-only.
* Test: "token payouts are ft_transfer CALLS (never /transfer with a token field ...)" in `tests/custody.test.ts`.
* The wallet policy no longer lists payees (they would look like a protection Layer A does not provide): ADR 0005.
* Findings file corrected: our first reading ("recipient whitelist is enforced for token transfers") was wrong.

## Risks that remain
The wallet policy does not check token recipients or amounts. Layer B does.

## Lesson
A success response is not evidence; a balance is. Every recorded run asserts balances before and after.
