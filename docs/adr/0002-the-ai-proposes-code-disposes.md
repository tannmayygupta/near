# 0002. The AI proposes, code disposes

Status: accepted (2026-11-11)

A plain-English intent is drafted into mandate terms by a **confidential-TEE model on NEAR AI Cloud**. Every answer is signed; our verifier recovers the signer, checks it against an attestation report fetched with a fresh nonce, and re-hashes the exact request and response bytes. Before anything else happens, code re-validates every bound (`parseIntent`, the zod schema, the worker's `verify()`), rejects addresses that are not in the user's text, unknown tokens, prompt-injection shapes, and, since 2026-11-14, a zero price floor. A human confirms the review table. The model holds no keys, picks no amounts at execution time and never signs.

Rejected: **an AI executor** that decides trades live (unverifiable, injectable). **A non-TEE model** (the intent is commercially sensitive and there would be nothing to verify). **Trusting the model's JSON** without re-checking (the zero-floor hole, `docs/incidents/2026-11-14-zero-price-floor.md`, is exactly why).

Limit we state: we verify the signer is attested, not the Intel quote itself.
