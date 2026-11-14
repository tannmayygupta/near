# 0009. Recorded runs, an independent verifier, and an evidence audit

Status: accepted (2026-11-12)

Claims are backed by **recorded runs**: end-to-end scripts that make real testnet transactions and write JSON with an explorer link on every row (`data/demo-run/`). A **separate verifier** (`src/verify/`) re-checks a proof bundle offline (nonce echo, signature recovery, attested signer, report hash, price floor, tamper cases that must fail). `npm run check:evidence` looks up every transaction cited anywhere in the README, docs and runs (201/201 exist), and `npm run verify:contract` proves the deployed contract is the committed wasm. The `/recompute` dashboard page repeats the on-chain half of the verification in the reader's own browser (contract view + transaction lookups over public RPC, same code as `tests/recompute.test.ts`), so a reader does not have to trust our JSON, our verifier binary or our server.

Amended 2026-11-14: a recorded run whose own checks all pass is not proof that the run was sane. Two runs traded through a pool priced about 1e16x the market while 36/36 and 12/12 checks passed, because the price band was skipped when its reference quote failed (`docs/incidents/2026-11-14-price-band-skipped.md`). Every e2e script now asserts that each swap happened at a market-like price, and all four runs were re-recorded on contract v2. Lesson: a check list is only as good as the question each check asks; look at the numbers in a rendered page, not only at the green ticks.

Rejected: **pasted console output as proof** (not machine-checkable). **Screenshots.** **A verifier that asserts constants** (it must be able to fail; the sealed verifier rejects five tampering cases). **Quoting simulated numbers as real** (`npm run demo` and the unit tests are labelled simulations).

Consequence: any doc that quotes a count must be updated in the same commit (see `AGENTS.md`).
