# Sealed mandates (commit-reveal)

A DAO sometimes must not announce *how* it will sell: the price floor, the schedule and the recipients are exactly what front-runners want.
A **sealed mandate** keeps those terms off the public chain until the mandate has settled, while still giving every member a binding, checkable commitment.

## How it works

| Phase | What is public on chain | What is private |
|---|---|---|
| 1. Propose + vote | Sputnik proposal `create_mandate` with `terms_json = null`, `terms_hash = sha256(salt \| canonical terms)`, the sell token, the **budget** (`max_sell`) and the window | floor, chunk sizes/intervals, recipients, fee, notes |
| 2. Deliver | nothing | council member signs a NEP-413 message and POSTs terms + salt to the worker (`/api/sealed-terms`); the worker checks signature, key ownership and **council membership from the DAO policy**, then stores the terms AES-256-GCM encrypted (`SEALED_TERMS_KEY`) |
| 3. Fund + execute | DAO `Transfer` funding the vault, the swaps and payouts themselves (public transactions) | the terms that govern them |
| 4. Settle + reveal | `complete(report_hash, violations, revealed_terms = {salt, terms})` publishes the terms **after** settlement | - |

The worker refuses to touch a sealed mandate until the terms are delivered **and** `commit(terms, salt)` equals the on-chain `terms_hash` **and** budget/token/window match the chain fields.

## What the verifier proves (`src/verify/sealed.ts`, run by `npx tsx src/verify/cli.ts data/demo-run/sealed-proof-bundle.json`)

1. While the mandate ran, the public chain view had no `terms_json` and no `revealed_terms`.
2. None of the secret values (recipient addresses, field names, the floor literal) appear anywhere in the public pre-reveal view (mandate + DAO proposal, including the decoded base64 call arguments).
3. After settlement the reveal exists on chain and `sha256(salt | revealed terms)` equals the commitment that was public from the start. A changed floor, salt or recipient **fails**.
4. The salt is long enough (>= 16 chars) that low-entropy terms cannot be brute-forced from the hash.
5. The revealed terms match the public budget (token, max amount, window).
6. Every fill respected the **revealed** floor, total sold stayed within the revealed budget, and every payout/return went to a revealed recipient (payout list, fee recipient or the DAO).

Unit tests with good and tampered inputs: `tests/sealed-verify.test.ts` (11 tests). The live run: `scripts/testnet/e2e-sealed.ts` -> `data/demo-run/sealed-run.json` and `sealed-proof-bundle.json`.

## Recorded evidence (public NEAR testnet, mandate #12, real Ref swaps)

`scripts/testnet/e2e-sealed.ts` passed **36/36** (`data/demo-run/sealed-run.json`); the verifier CLI passes **21/21** on `data/demo-run/sealed-proof-bundle.json`.

- Commitment (public from the first block): `dfef3748196922e406c2164f03d66702aeada2a1cbad162efb629274b0d7bce4`; the price floor was derived from the live Ref pool #57 (spot 2.395 -> floor 1.19).
- [create_mandate proposal (terms_json = null)](https://explorer.testnet.near.org/transactions/BFKKpZZ2zo2FfagzLKuEqMU1f7k6PvAM5WXNeNEpiWod) -> [vote 2/3 executes](https://explorer.testnet.near.org/transactions/97ra76kHFniP9k6M3kWx1pRPkhy9eJeKxKLgtkpm1A51) -> [real DAO funding transfer (vote 2/3)](https://explorer.testnet.near.org/transactions/J7rr8mEWH5JX4sfP5JBZ3rJDspjHueg1FBdGBAgimKa3).
- Real swaps on Ref Finance testnet ([first swap](https://explorer.testnet.near.org/transactions/5TsHsLYMrHJ4hxdua7T4Ko6EUv5q8S7eTzs1ho4iNVq1), [chunk 0 recorded](https://explorer.testnet.near.org/transactions/HgQkgWr2bkPGM142KwKXif8tEbVh1JXzkDWCYbDXF3T1)), real USDT.e payouts, fee and returns ([payout](https://explorer.testnet.near.org/transactions/FXjKXFbz3czkevR9nwLzpw9pJCUhR9up781xzM7vK1EZ)).
- [Settlement + on-chain reveal](https://explorer.testnet.near.org/transactions/FdSsFwgcCCch3TVaiyegfUichg4RViLkZLEEcTAqbiQ8).
- Access control, live against the worker API: unsigned, non-council, wrong-action and impersonated requests -> 401; council-signed -> 200; sealed terms stored encrypted at rest.
- Tamper checks on the real bundle: changed floor, changed salt, swapped recipient, terms public early, secret leaked into the public view -> each makes the verifier **fail**.
- Design note: the treasurer, council members and agent are public by design (mandate fields, proposal proposer/votes), so recipients in the sealed run are accounts that appear nowhere in the public pre-reveal view (a first attempt that reused the treasurer as a recipient correctly failed the leak check).

## Honest limits (read these)

- **The worker is not in a TEE.** Whoever operates it can read the sealed terms (it decrypts them to execute). Sealing protects the terms from the *public chain* and from front-runners, not from the operator. Running the executor inside OutLayer's enclave is a roadmap item, not built.
- **Trades are public on testnet.** Ref Finance swaps and the USDT.e payouts are ordinary public transactions. Recipients become visible when the payouts execute at settlement, i.e. at the same time as the reveal. *Hidden trades* (confidential swaps) are mainnet-only and **unproven**.
- **Commit-reveal gives binding, not secrecy forever.** Once revealed, the terms are public. The point is secrecy *while the sale runs* plus proof that nothing changed afterwards.
- The commitment is only as hiding as the salt: the script uses a 16-byte random salt.
- A council member who holds the terms can leak them; delivery is limited to DAO council members, not to a single named signer.
