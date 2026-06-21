# Product

## Register

product

## Users
Crypto-literate prediction-market bettors (Polymarket users) who already hold or want a position and want to know, honestly, whether and how to hedge it — and what it really costs. They arrive mid-task: "I'm long Spain to win; is a hedge worth it?" or "I want to bet England 1:0; build me a plan." They value being told the truth over being sold an edge.

## Product Purpose
HedgeAdvisor turns a real Polymarket position or bet into an honest, costed plan. It prices every leg at the real executable book cost (not the displayed midpoint), de-vigs to a true probability, and states the expected value honestly (negative — the vig). Two surfaces: `/` ranks correlated hedges for a position you hold (GO / PARTIAL / NO-GO); `/plan` turns a bet you want (result, exact score, over/under, BTTS) into a multi-leg plan with a budget, a number-of-bets cap, and an express↔protect posture. Success = the user trusts the number, including when the answer is "don't bother."

## Brand Personality
Honest, precise, calm. Three words: trustworthy, exact, unhyped. It reads like a good analyst, not a sportsbook: it shows the cost it is built to be honest about, and "this isn't worth it" is a first-class answer. Voice is specific, never aphoristic, never promotional.

## Anti-references
- Sportsbook / casino UI: odds boosts, parlay-bonus theater, green "you could win!" celebration, streaks, confetti.
- "+EV / beat-the-book / value bet" tout sites (the marketing, not the math) — HedgeAdvisor's whole stance is EV-negative.
- Cluttered crypto dashboards with neon-on-black, glassmorphism, and dense gradients.
- Anything that nudges bet volume or implies a found edge.

## Design Principles
- **Show the cost, don't hide it.** Surface fair value vs the price paid; the gap is the vig+spread. Honesty is the product.
- **"Don't bother" is a real answer.** NO-GO and the guaranteed-loss guard are designed outputs, not failure states.
- **Real markets only.** Every suggestion and leg is a market that exists live on Polymarket; never fabricate a matchup.
- **Earned familiarity.** It should feel like Linear/Notion/Stripe — the tool disappears into the task. No invented affordances for standard actions.
- **Quiet confidence.** Restraint over decoration; one accent, generous whitespace, strong type hierarchy.

## Accessibility & Inclusion
WCAG 2.1 AA: body text ≥4.5:1, large/secondary ≥3:1, visible focus rings on every interactive element, full keyboard operation for the typeahead combobox (arrow/enter/escape, aria-activedescendant). Respect `prefers-reduced-motion` (crossfade/instant fallbacks). Verdicts and P&L never rely on color alone — always paired with a label/sign.
