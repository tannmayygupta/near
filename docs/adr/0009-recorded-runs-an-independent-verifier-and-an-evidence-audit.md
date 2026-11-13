# 0009. Recorded runs, an independent verifier, and an evidence audit

Status: accepted (2026-11-12)

Claims are backed by **recorded runs**: end-to-end scripts that make real testnet transactions and write JSON with an explorer link on every row (`data/demo-run/`). A **separate verifier** (`src/verify/`) re-checks a proof bundle offline (nonce echo, signature recovery, attested signer, report hash, price floor, tamper cases that must fail). `npm run check:evidence` looks up every transaction cited anywhere in the README, docs and runs (184/184 exist), and `npm run verify:contract` proves the deployed contract is the committed wasm.

Rejected: **pasted console output as proof** (not machine-checkable). **Screenshots.** **A verifier that asserts constants** (it must be able to fail; the sealed verifier rejects five tampering cases). **Quoting simulated numbers as real** (`npm run demo` and the unit tests are labelled simulations).

Consequence: any doc that quotes a count must be updated in the same commit (see `AGENTS.md`).
