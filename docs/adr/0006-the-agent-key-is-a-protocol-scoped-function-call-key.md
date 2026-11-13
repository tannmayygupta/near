# 0006. The agent key is a protocol-scoped function-call key

Status: accepted (2026-11-14)

The key the worker uses to drive the mandate contract is a NEAR **function-call access key**: receiver = the mandate contract, methods = `mark_funded`, `record_chunk`, `begin_settlement`, `complete`, `expire`, no deposit, 2 NEAR gas allowance (`scripts/testnet/scoped-key.ts`). The NEAR protocol refuses everything else before contract code runs: `create_mandate`, `set_agent`, any other contract, any transfer, any deposit. Six live probes with NEAR's own error text are in `data/testnet-scoped-key.json`; the custody run and the crash-restart run use this key.

The wallet-policy owner is a **separate** credential (`CUSTODY_OWNER_KEY`) because storing a policy needs a deposit, which a function-call key cannot attach.

Rejected: **a full-access agent key** (it could rotate the agent role or move NEAR). **Hiding the key behind the contract's `set_agent`** (the key itself is the boundary). **One credential for everything** (convenient; defeats the point).

Open: the owner credential is still a single account (production: the DAO). Social-post publishing needs its own key.
