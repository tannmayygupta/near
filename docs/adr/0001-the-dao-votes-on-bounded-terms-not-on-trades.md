# 0001. The DAO votes on bounded terms, not on trades

Status: accepted (2026-11-11)

A DAO that sells its own token needs three things at once: members decide, nobody can do more than they decided, and the vote does not telegraph the trade. We make the unit of decision a **mandate**: token, budget, price floor, time window, chunk sizes, payouts, fee and return address, validated by one zod schema (`src/engine/schema.ts`) and committed on-chain by `terms_hash`. One Sputnik proposal creates the mandate, a second moves the budget into the vault. After that no human acts until the anchored report; one DAO cancel proposal stops it and returns everything.

Rejected: **the council signs every trade** (slow, error-prone, the vote telegraphs each trade). **Handing an operator the keys** (nothing stops selling more, cheaper, or paying themselves). **A "black-box fund" whose strategy nobody can check** (we dropped this idea on day one: honesty cannot be verified).

Consequence: the mandate is the only authority. Anything the agent does outside the terms is a bug the guards, the contract or the wallet policy must refuse (ADR 0005).
