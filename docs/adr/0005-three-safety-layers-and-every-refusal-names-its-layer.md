# 0005. Three safety layers, and every refusal names its layer

Status: accepted (2026-11-13)

Layer **0** is the NEAR protocol (the agent key is a function-call key, ADR 0006). Layer **A** is the OutLayer wallet policy (ADR 0004). Layer **B** is our mandate contract plus the executor guards (`worker/guards.ts`). A red-team result always records which layer stopped the attempt (`worker/redteam.ts`, `/redteam`, `/custody`).

We probed what Layer A really enforces instead of assuming (`data/testnet-outlayer-findings.json`): it refuses calls to contracts outside the policy and native NEAR to anyone but the DAO or above the budget; it does **not** check token payout recipients or token amounts (an `ft_transfer` through `/call` is checked only by its outer contract), and `/transfer` ignores a `token` field. So those two are Layer B's job, and the docs say so.

Rejected: **one layer** (any single bug is fatal). **Presenting a protocol refusal as contract logic** (a competitor's attack table mostly shows access-key rules; ours labels each as 0, A or B). **Listing payees in the wallet whitelist** (a false sense of protection).

Consequence: against a stolen worker credential, Layer A alone would not stop a token drain on testnet. That is stated in the README security section.
