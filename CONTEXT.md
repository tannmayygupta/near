# Quiet Treasury: shared language

Read this before changing code, docs or UI copy. Each term has one meaning everywhere (code, dashboard, docs, forms). `_Avoid_` lists the words that blur it.

**Mandate**
The one thing a DAO votes on: token, budget, price floor, time window, chunk sizes, payouts, fee, return address. It exists as bounded `MandateTerms` (`src/engine/schema.ts`) and as an on-chain record on the mandate contract. A mandate never grants more than it says.
_Avoid_: order, instruction, strategy, job.

**Terms**
The validated content of a mandate (zod schema, hard bounds). Their hash is what the DAO's proposal commits to (`terms_hash`).
_Avoid_: config, parameters.

**Intent**
The plain-English sentence a treasurer types ("Sell up to 0.4 NEAR for USDT.e ..."). An intent only ever becomes a draft; it is never authority.
_Avoid_: prompt, request.

**Parser**
The step that turns an intent into draft terms. It runs inside a NEAR AI Cloud TEE model, then code re-validates every bound. The model holds no keys.
_Avoid_: agent, AI executor.

**Vote**
A Sputnik DAO proposal approved by the council. Two kinds matter: `create_mandate` (creates the on-chain record) and a funding `Transfer` (moves the budget to the vault). Nothing executes before them.
_Avoid_: approval request, sign-off.

**Tier**
How many council approvals a mandate needs (small, mid, large).

**Vault**
The account that holds the DAO-funded budget while a mandate runs. In the custody run it is an OutLayer agent wallet; in the first run it is a key-held account.
_Avoid_: treasury (the DAO treasury is the DAO's own account), wallet (too vague).

**Custody wallet**
The OutLayer agent wallet used as the vault: its signing key lives in OutLayer's TEE; the worker holds only an owner credential.

**Agent**
The deterministic worker that carries a mandate out (`worker/executor.ts`). It is not the AI. The word "agent" always means the worker; the model is the **Parser** or the **Summarizer**.
_Avoid_: bot, AI trader.

**Agent key**
The key the worker uses to drive the mandate contract. It is a NEAR function-call key limited to five methods (Layer 0).

**Chunk**
One price-floored swap inside a mandate, randomised in size and timing. Chunk `index` is recorded on-chain exactly once.
_Avoid_: trade, order slice.

**Price floor**
The minimum buy-token per sell-token a chunk may accept, enforced as `min_amount_out` on every swap. Always greater than zero.

**Layer 0 / A / B**
The three independent safety layers: **0** = the NEAR protocol scopes the agent key; **A** = the OutLayer wallet policy written per mandate; **B** = the executor guards plus the mandate contract. A red-team result always names its layer.

**Policy**
The OutLayer wallet policy the worker writes before a mandate trades (contracts it may call, the DAO as the only native recipient, native cap = budget). It does not check token recipients or amounts.

**Settlement report**
The numbers of a finished mandate (fills, averages, fees, payouts, leftovers, benchmark). Its hash is anchored on-chain by `complete`.

**Proof bundle**
A report plus the AI attestation and signed completions, checked offline by the independent **Verifier** (`npm run verify`).

**Verifier**
`src/verify/`: a separate program that re-checks a proof bundle and must fail on tampered ones. It never trusts the worker.

**Sealed mandate**
A mandate whose terms are not on-chain while it runs: only `sha256(salt | terms)` and the budget are public. Terms are revealed on-chain at settlement and verified against the commitment.
_Avoid_: private mandate, encrypted mandate (the operator can still read the terms).

**Trust score**
On-chain count of a treasurer's mandates settled with zero violations, mirrored to near.social.

**Recorded run**
A JSON file in `data/demo-run/` produced by an end-to-end script against public testnet. Every row has an explorer link. "Recorded" never means simulated.

**Simulation**
Anything driven by in-memory stand-ins (`npm run demo`, unit tests). Always labelled as such; its numbers are never quoted as real.

**Testnet**
The only network anything ran on. No mainnet funds were moved. "Real" in our docs means real testnet transactions.
_Avoid_: devnet, sandbox (except the local Docker sandbox, which is named as such).
