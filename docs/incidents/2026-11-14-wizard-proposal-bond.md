# 2026-11-14: the wizard attached a proposal bond the DAO would have refused

Status: closed (fixed in the working tree on 2026-11-14; no human ever used the wizard's wallet path, so nothing failed live)

## Summary
While writing `tests/wallet-parity.test.ts` (does the wizard ask the wallet to sign the same transaction the tested scripts send?) we compared the wizard's `add_proposal` with `scripts/testnet/lib.ts`. The scripts read the DAO's `proposal_bond` from `get_policy` and attach it with 30 TGas. The wizard attached a hard-coded **0.1 NEAR** with 150 TGas, and put 100 TGas on the inner `create_mandate` action where the scripts use 60 TGas. A read-only `get_policy` call on `quietdao-83872.sputnikv2.testnet` returned `proposal_bond = 1000000000000000000000000` (1 NEAR). Sputnik refuses an `add_proposal` whose deposit is below the bond, so signing a proposal from the wizard would have failed. The recorded runs never exposed it because every proposal in them came from the scripts.

## Identifiers
| What | Value |
|---|---|
| Wrong | `app/app/wizard/page.tsx`: `deposit: '100000000000000000000000'`, `gas: '150000000000000'`, inner action gas `100000000000000` |
| Right (what the scripts do) | `scripts/testnet/lib.ts` `proposeWithHash`: `TGAS(30)` and `BigInt(policy.proposal_bond ?? '0')`; `sp.functionCallKind` default gas `TGAS(60)` |
| Fix | `app/lib/dao-tx.ts` (pure builders used by the wizard and the votes page); the wizard reads the live policy at signing time and sends nothing if it cannot |
| Regression test | `tests/wallet-parity.test.ts` (22 tests: the UI payloads equal the scripts' payloads through the real `sp.addProposal`, `sp.vote`, `proposeWithHash`, `voteTx`; the scripts' source lines are pinned) |

## Why
Ours: the wizard's comment said "default 0.1 NEAR on testnet DAOs; read the DAO policy if different", i.e. the bond was assumed, not read, and the claim "wallet-signed proposal creation" was already listed as not claimed because no human had tried it. Nothing compared the two paths until now.

## What changed
Both pages build their transactions with the shared pure functions. The parity test fails if either side drifts.

## Risks that remain
The payloads are now equal, but the wallet layer itself (the wallet selector, MyNearWallet, a human approving) has still never run. `Finalize` has a tested payload but no button.

## Lesson
A path nobody has used is a path nobody has tested: compare it with the one that has run, byte for byte.
