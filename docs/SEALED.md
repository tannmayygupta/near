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

## Recorded evidence (public NEAR testnet, mandate #13, real Ref swaps)

`scripts/testnet/e2e-sealed.ts` passed **37/37** (`data/demo-run/sealed-run.json`); the verifier CLI passes **21/21** on `data/demo-run/sealed-proof-bundle.json`.

- Commitment (public from the first block): `02c68c1a0012da95b11fdd3f1face5a3d322ddeb98f8aeb3e433eee8616f458a`; the price floor (2.24 USDT.e per NEAR) was derived from the live Ref pool #57 and stays hidden until settlement.
- [create_mandate proposal (terms_json = null)](https://explorer.testnet.near.org/transactions/GGwhzq4HFeL8yYyvwCUgsagEanrHKoGieATHdArbvH9f) -> [vote 2/3 executes](https://explorer.testnet.near.org/transactions/2jCa37c4SDTTCb5CoUTfWwKq5LTMZhARCfKN5cowsKPU) -> [real DAO funding transfer (vote 2/3)](https://explorer.testnet.near.org/transactions/BRxCLYRttj5i8DDsGWS3vrhMFkBTutjRyLqSaSM7y4Yq).
- Real swaps on Ref Finance testnet ([first swap](https://explorer.testnet.near.org/transactions/JjGn1Wmxq3QaefAYp4bjme4xSjVn57DPcTQqReP43WF), [chunk 0 recorded](https://explorer.testnet.near.org/transactions/Gr63b3PTCHtWHj1xgULcSkWQowfCVSHZgx9mJuK7RCwS)), real USDT.e payouts, fee and returns ([payout](https://explorer.testnet.near.org/transactions/8bbLFQfSewTb75pCszjYmqMrJQqLfADULceJ1KQ5SUD9)).
- [Settlement + on-chain reveal](https://explorer.testnet.near.org/transactions/2PviWNGSjGg9tF96eFNvUmdtbk3Q2BFHefkYUx86WuVz).
- Access control, live against the worker API: unsigned, non-council, wrong-action and impersonated requests -> 401; council-signed -> 200; sealed terms stored encrypted at rest.
- Tamper checks on the real bundle: changed floor, changed salt, swapped recipient, terms public early, secret leaked into the public view -> each makes the verifier **fail**.
- Design note: the treasurer, council members and agent are public by design (mandate fields, proposal proposer/votes), so recipients in the sealed run are accounts that appear nowhere in the public pre-reveal view (a first attempt that reused the treasurer as a recipient correctly failed the leak check).

## Honest limits (read these)

- **The worker is not in a TEE.** Whoever operates it can read the sealed terms (it decrypts them to execute). Sealing protects the terms from the *public chain* and from front-runners, not from the operator. Running the executor inside OutLayer's enclave is a roadmap item, not built.
- **Trades are public on testnet.** Ref Finance swaps and the USDT.e payouts are ordinary public transactions. Recipients become visible when the payouts execute at settlement, i.e. at the same time as the reveal. *Hidden trades* (confidential swaps) are mainnet-only and **unproven**.
- **Commit-reveal gives binding, not secrecy forever.** Once revealed, the terms are public. The point is secrecy *while the sale runs* plus proof that nothing changed afterwards.
- The commitment is only as hiding as the salt: the script uses a 16-byte random salt.
- A council member who holds the terms can leak them; delivery is limited to DAO council members, not to a single named signer.
