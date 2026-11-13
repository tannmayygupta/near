# 0011. Sealed mandates by commit-reveal

Status: accepted (2026-11-12)

A DAO may want to sell without telling the market the terms first, yet members need proof the agent followed the vote. A sealed mandate puts only `terms_hash = sha256(salt | terms)` and the budget on-chain (`terms_json = null`). Terms are AES-256-GCM encrypted off-chain and released only to council members who sign a NEP-413 request. `complete(revealed_terms)` publishes salt and terms after settlement; the independent verifier proves the revealed terms match the commitment, the budget and window, that every fill obeyed the revealed floor and every payout went to a revealed recipient, and rejects five tampering cases (36/36 end-to-end run, 21/21 verifier).

Rejected: **calling it "private" or "encrypted"** (the worker is not in a TEE, so its operator can read the terms; we say "sealed until settlement"). **Encrypting on-chain** (the DAO cannot vote on what it cannot read; it votes on the commitment).

Limit: testnet payouts reveal recipients when they execute.
