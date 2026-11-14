# AI disclosure

Most of the code and documentation in this repository was written with AI assistance (Claude Code, run by the team lead who reviewed, directed and approved the work). We say so because the hackathon rules ask judges to run the code, and because the way we verified it is part of the product.

## What the AI wrote, and how it was checked
| Area | AI role | How it was verified |
|---|---|---|
| `contracts/mandate/` (Rust) | wrote the contract and its 36 tests (31 unit + 5 property tests; 37 with the migration feature) | `cargo test --release` in CI (`rust:1.99.1`); the deployed testnet contract's code hash equals the committed wasm (`npm run verify:contract`) |
| `src/`, `worker/` (TypeScript) | wrote the engine, executor, guards, OutLayer/Sputnik/NEAR AI clients, adapters | 396 unit tests (`npm test`); four live end-to-end runs on public testnet that make real transactions (`npm run e2e:real`, `e2e:custody`, `e2e:sealed`, `e2e:restart`) |
| `src/verify/` | wrote the independent verifier | runs offline on recorded proof bundles and must fail on tampered ones (`npm run verify`, tamper cases included) |
| `app/` (Next.js dashboard) | wrote the pages | `next build` in CI; pages read the recorded runs and live testnet RPC; not every page was exercised in a real browser (see `docs/CLAIMS.md`) |
| `docs/` | drafted all documents | every claim in `docs/CLAIMS.md` names its evidence file and a status; `npm run check:evidence` checks that every cited transaction exists |

## What humans decided
Which idea to build, which tracks to claim, the rule that nothing is claimed without evidence, the decision to move **no mainnet funds**, and every submission action (nothing is sent to a form, X or Loops without an explicit yes).

## Where the AI got things wrong, and what caught it
* A zero price floor was accepted by the schema (found while writing the offline demo; now rejected, with a regression test).
* OutLayer's `/transfer` ignores a `token` field and sends dust: the first custody run reported payouts "paid" with unchanged balances; the end-to-end balance checks caught it (`docs/OUTLAYER-FEEDBACK.md`).
* A first reading of OutLayer's policy enforcement was wrong; probing with real transactions corrected it (`data/testnet-outlayer-findings.json`).

Rule we follow: a claim without a command or a transaction that proves it gets deleted.
