# Product

## Register

product

## North star (encode everywhere)

HedgeAdvisor does **not** predict whether your bet wins. It answers: **if your bet does not win, is there a positive-sum companion bet that pays instead — and what does it really cost?** A hedge here is **positive-sum, never a short of your own bet**: each leg is a standalone positive bet on a DIFFERENT event that tends to pay when your bet fails, so ideally both win and at worst one wins. We never recommend buying your own NO, a rival of your own outcome, or any leg that pays purely because you lose.

这个产品不预测你会不会赢。它找的是正和的"伴随注":在别的事件上、当你这注没中时反而可能获益的注 —— 最好两个都中,最差只中一个。绝不做空你自己的注。

## Users

Prediction-market bettors on **Polymarket and Kalshi** who already hold or are about to place a bet and want an honest, cost-aware read on whether and how to hedge it across both venues. They arrive mid-task: "I'm long France to win the World Cup, is there anything that pays if they don't?" They value the truth over a sold edge, including the frequent honest answer: "there is no clean positive-sum hedge here, hold the bet as is."

## Product Purpose

HedgeAdvisor turns a real bet into an honest, costed view, priced at the real executable book cost (not the displayed midpoint), de-vigged to a true probability, with EV stated honestly (negative, the vig). It launches **during** the World Cup, so it cannot wait for settlement-calibration data to accrue; the live engine leans on a clearly-labeled, low-confidence inferred logic layer, kept strictly subordinate to the trustworthy layer.

Four surfaces, each one job, no overlap:

- **Hedge** (`/hedge`) — the single hedge surface. Given a bet you hold or plan, it builds a live cross-venue market universe and finds positive-sum companion bets, in two layers: an **Optimal** layer (settlement-calibrated or logically certain; trustworthy) and an **Exploratory** layer (model-inferred cross-event mechanisms; low confidence). Positively-correlated markets that would fail together with your bet are kept OUT of the companion layers (they amplify, not hedge).
- **Combo** (`/combo`) — a parlay truth-checker: real legging-in cost, fair value, compounded vig, and structural-impossibility detection for a multi-leg bet you specify. Not a hedge recommender.
- **Cross-venue** (`/link`) — finds the same outcome on Polymarket vs Kalshi and shows the cheaper execution venue, net of fees. An execution comparison, not a hedge.
- **Markets** (`/markets`) — a read-only live market ledger.

Success = the user trusts the number, including when the answer is "hold the bet, there is no good hedge."

## Brand Personality

Honest, precise, calm. Three words: trustworthy, exact, unhyped. It reads like a good analyst, not a sportsbook: it shows the cost it is built to be honest about, and "there is nothing worth doing" is a first-class answer. Voice is specific, never aphoristic, never promotional.

## Anti-references

- Sportsbook / casino UI: odds boosts, parlay-bonus theater, green "you could win!" celebration, streaks, confetti.
- "+EV / beat-the-book / value bet" tout sites (the marketing, not the math) — HedgeAdvisor's whole stance is EV-negative.
- **Shorting-your-own-bet insurance framing**: buy-your-own-NO, rival baskets, "fully protected" complements. A hedge that pays only because you lose is a zero-sum mirror, not a companion bet; the product does not recommend these.
- Cluttered crypto dashboards with neon-on-black, glassmorphism, and dense gradients.
- Anything that nudges bet volume or implies a found edge.

## Design Principles

- **Show the cost, don't hide it.** Surface fair value vs the price paid; the gap is the vig+spread. Honesty is the product.
- **Positive-sum only.** Every recommended leg is a standalone positive bet on a different event; never a short of the user's own outcome. A companion must be negatively correlated (pay when you fail) to qualify.
- **Two layers, read differently.** The trustworthy layer (calibrated/structural) leads; the inferred layer is loudly low-confidence and subordinate. Never present inferred as calibrated.
- **"Nothing to do" is a real answer.** An empty Optimal layer is a designed output, not a failure state, and is common (for a single-nation champion bet there is often no clean positive-sum hedge).
- **Real markets only.** Every suggestion is a market that exists live on Polymarket or Kalshi; never fabricate a matchup.
- **Quiet confidence.** Restraint over decoration; one accent, generous whitespace, strong type hierarchy. Earned familiarity (Linear/Notion/Stripe).

## Accessibility & Inclusion

WCAG 2.1 AA: body text ≥4.5:1, large/secondary ≥3:1, visible focus rings on every interactive element, full keyboard operation for the typeahead combobox (arrow/enter/escape, aria-activedescendant). Respect `prefers-reduced-motion` (crossfade/instant fallbacks). Verdicts and P&L never rely on color alone — always paired with a label/sign.
