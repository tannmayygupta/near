# Security

Quiet Treasury runs on **public NEAR testnet only**. Nothing here is audited, and every token involved is a test token with no value. This page says what each safety layer stops, what it does not stop, and what someone who gets hold of a credential (or runs the worker badly) can and cannot do. It states limits; it does not promise safety. Evidence for each line is in [docs/CLAIMS.md](docs/CLAIMS.md), [docs/CUSTODY.md](docs/CUSTODY.md) and [docs/adr/](docs/adr/) (0004, 0005, 0006, 0010). Vocabulary: [CONTEXT.md](CONTEXT.md).

## The three layers

Every refusal in the red team (`worker/redteam.ts`, dashboard `/redteam`) names the layer that stopped it. In both recorded runs 6 of 6 attacks were blocked.

| Layer | What enforces it | It stops | It does NOT stop |
|---|---|---|---|
| **0** NEAR protocol | The agent key is a function-call access key: receiver = the mandate contract, 5 methods (`mark_funded`, `record_chunk`, `begin_settlement`, `complete`, `expire`), no deposit, 2 NEAR gas allowance (ADR 0006) | With that key: `create_mandate`, `set_agent`, calls to any other contract, any native transfer, any attached deposit. NEAR refuses these before contract code runs (6 live probes, `data/testnet-scoped-key.json`) | Anything the 5 methods can do (see "Stolen agent key"). It says nothing about the other credentials the worker holds |
| **A** OutLayer wallet policy | OutLayer's TEE, from a policy the worker writes per mandate (ADR 0004). Whitelist: the two token contracts, the Ref DEX, the DAO; native NEAR only to the DAO and capped at the budget | A call to a contract outside the whitelist; native NEAR to anyone but the DAO; native NEAR above the budget (403 `policy_denied`, probed live) | **Token payout recipients and token amounts.** An `ft_transfer` sent through `/call` is only checked by its outer contract, and a per-token amount cap was not enforced (`data/testnet-outlayer-findings.json`). The rate limit is written but was not probed. Only native transfers were exercised; the confidential/Intents endpoints are mainnet-only and untested |
| **B** executor guards + mandate contract | `worker/guards.ts`, the price floor and price-band guard, and the contract (DAO-only create/cancel, budget, window, idempotent chunk records) | A mandate or executor that tries the wrong token, more than the remaining budget, a swap after the window, a payout to an address not in the terms, a non-DAO `create_mandate`, a price below the floor | **A stolen credential.** A thief does not run our executor. The contract holds no funds, so it cannot stop a token movement itself |

## If something is compromised

**Stolen agent key.** It can call the 5 methods inside the contract's rules, which means it can falsify the registry's bookkeeping: record chunks that never traded (in order, inside the window, up to the remaining budget), mark a mandate funded, begin settlement, `complete` with any report hash and `violations = 0` (that adds 1 to the treasurer's trust score), and `expire` a mandate after its window. It can burn its 2 NEAR gas allowance. It **cannot** create or cancel mandates, change roles, call another contract, move NEAR or tokens, or attach a deposit. The contract holds no funds, so no money moves. Response: the DAO rotates it with `set_agent` and cancels affected mandates. Extra bookkeeping would show as a mismatch between the contract's totals and the run's swaps in `/recompute` and `npm run verify` (a tamper case that is unit-tested, not exercised live); that is a check someone has to run, not an alarm.

**Stolen owner credential** (`CUSTODY_OWNER_KEY`). It is a full-access key (storing a wallet policy needs a deposit, which a function-call key cannot attach) and the worker uses it as the agent's NEAR account (`AGENT_ACCOUNT_ID`), so Layer 0's limits do not apply to it: by NEAR's own rules it can also spend that account's NEAR, add and delete its keys and call any contract. It can ask the OutLayer vault wallet to act and it writes the wallet's policy. On testnet only Layer A stands between it and the vault, and Layer A does not check token recipients or amounts, so assume it can send the vault's tokens anywhere. Because the owner is the account that writes the policy, assume it can also rewrite the policy (not tested). If `CUSTODY_OWNER_KEY` is unset the worker falls back to `AGENT_SECRET_KEY` for this role, which then must be a full-access key (the worker warns; `REQUIRE_SCOPED_KEY=1` refuses a full-access agent key). Exposure is bounded by what the DAO has funded: the vault holds only the mandate budget, moved there by a voted `Transfer` proposal.

**Malicious or compromised operator** (whoever runs the worker). The worker is not in a TEE. The operator holds the agent key, the owner credential, the NEAR AI key and the key that encrypts stored terms, and reads the terms of every mandate it runs, including sealed ones. So the operator can do everything in the two paragraphs above, can read sealed terms, and can simply stop (the vault budget stays where it is). The DAO has no on-chain way to take the vault back from a hostile owner credential: the wallet cannot be bound to the DAO (ADR 0004), and the DAO as policy owner is on the roadmap, not built. The operator cannot hide anything on chain: every swap, payout and return is a public transaction. The operator also cannot create a mandate, forge council votes, or push the registry past a mandate's budget or window.

**Stolen council keys.** The council is the root of authority. Two of three council keys approve any proposal the DAO can execute, including transfers out of the DAO treasury. This project does not reduce that (it is a standard Sputnik DAO v2), and the demo council accounts are controlled by the authors (`data/testnet-public.json`).

**The AI.** It drafts terms and summaries; it never signs, never decides an amount and never holds a key. Code re-validates every bound (`src/engine/schema.ts`) and the DAO votes on the terms hash. A prompt-injected draft can at worst become a bad proposal that people vote on; read the terms before you vote.

**The dashboard.** It holds no secret and can only ask your wallet to sign; your wallet shows what it signs. The payloads of the wizard (`add_proposal`) and the votes page (`act_proposal`) are unit-tested to be identical to what the tested scripts send (`tests/wallet-parity.test.ts`), but no human has signed through that wallet path yet. Treat it as untested with real wallets.

## Known limits

* The operator is not in a TEE (sealed terms are hidden on chain, not from the operator).
* OutLayer's policy does not check token recipients or amounts; OutLayer holds governance keys for its TEE and its coordinator builds the Intents artifacts.
* The mandate contract is a registry, not an escrow: it does not hold funds. Its account holds a full-access key on testnet, it has unit and property tests but no near-workspaces sandbox tests, and its wasm comes from a pinned Docker build, not `cargo near build reproducible-wasm` ([docs/CONTRACT.md](docs/CONTRACT.md)).
* One credential owns the wallet policy (production: the DAO), and one wallet serves one mandate at a time because the policy is rewritten per mandate.
* NEAR AI answers are checked for the attested signer and a matching nonce; the Intel TDX quote itself is not verified locally.
* Testnet only. No mainnet funds were moved; confidential swaps, Intents payouts and OutLayer custody on mainnet are unproven (ADR 0010). The Ref testnet pool is thin and open to anyone, so its prices say nothing about mainnet.
* Real failures we found in our own work are written up in [docs/incidents/](docs/incidents/).

## Report a problem

Open an issue at https://github.com/tannmayygupta/near/issues. Never put a secret in it (a key, seed, API token or `.env` line): if you found one in the repository, name the file and line without repeating the value and we will rotate it. If working exploit details would help an attacker, describe the class of the problem and leave the steps out. This is a hackathon project with no private disclosure channel and no bug bounty.
