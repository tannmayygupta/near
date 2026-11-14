# 0012. A product-grade visual identity for the dashboard, with no change to behaviour

Status: accepted (2026-11-14)

The dashboard read like an engineering console: a grey-and-green palette, the system font, identical bordered cards, and a home page titled "Treasury overview". Reviewers reached the evidence only after reading a console. The redesign gives it a front door and a consistent design system, and it changes presentation only.

What changed: one stylesheet of design tokens (`app/app/globals.css`, light and dark, every existing class name kept so all 16 pages restyle together), a floating glass navigation, a landing section on `/` (hero, how it works, the three security layers with their stated limits, a "check it yourself" band), and the old overview kept below it. Fonts are self-hosted at build time by `next/font` (Bricolage Grotesque, Instrument Sans, JetBrains Mono). **Every figure in the hero and proof strip is read from the recorded runs by the same loaders the other pages use; none is typed in.**

What did not change: the wallet provider and wallet button, data loaders, contract and transaction builders, routes, labels of the evidence pages, the source tags, the "testnet only / not proven" statements. `tests/wallet-parity.test.ts` and the rest of the suite are unchanged and green; the static export builds the same 16 routes.

Rejected: **copying another project's look** (we studied what makes a winner's product feel finished: a heavy display face, a soft canvas, one accent, pill controls, a hero built from real numbers, and took the techniques, not the fonts, colours or copy). **Purple-gradient "AI" styling** (the design-system search itself lists it as something to avoid for finance products; the accent is NEAR green on deep-navy ink with warm paper, mint, sun and sky as supporting tones). **A component library** (a new dependency and a rewrite of 16 pages for a visual change). **Decorative claims** (no animated counters, no invented numbers, no stock testimonials).

Limit: the hero visual is an HTML/CSS card built from one recorded run, not a live widget, and says so ("Recorded run, not a mock-up"). Motion respects `prefers-reduced-motion`.