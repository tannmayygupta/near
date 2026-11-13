# 0007. Price-floored chunks, and no price-gain claim on testnet

Status: accepted (2026-11-12)

Every swap is a randomized chunk with `min_amount_out` derived from the mandate's price floor, so no single fill can go below what the DAO approved. Chunk size and timing are randomised inside the terms. The report compares the realised proceeds with what **one** swap of the same total would have returned from the same pool state.

On Ref Finance's testnet pool the comparison is about -1 bp, the 0.3% fee: a constant-product pool is path independent, so chunking cannot beat one swap there. We say so in the report, the README and the verifier output. The value of chunking is hiding the schedule on a market where trades are not public; that is mainnet-only and **not proven**.

Rejected: **claiming a price gain** (false on this pool; a judge would find it). **A single swap** (simpler, but there would be no schedule to hide and no per-chunk floor evidence).

Operational note: Ref testnet pools are open to anyone; when the pool price drifts below the floor the worker correctly refuses to trade (`docs/incidents/2026-11-13-pool-drift-below-floor.md`).
