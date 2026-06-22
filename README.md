# HedgeAdvisor

Cost-aware hedge recommender for Polymarket prediction markets. You enter a position
you hold or like (e.g. "Spain wins the World Cup"); HedgeAdvisor finds a correlated
hedge, prices it at the **real executable cost** (it walks the live order book — never
the displayed midpoint), and tells you honestly whether it's worth it. "Don't bother"
is a first-class answer.

Built from [`HedgeAdvisor-MVP-TechSpec.md`](HedgeAdvisor-MVP-TechSpec.md). Execution
boundary in [`HedgeAdvisor-Execution-Compliance.md`](HedgeAdvisor-Execution-Compliance.md).

## Two flows

- **`/plan` — pick a bet, get an honest plan.** Enter a real match bet ("England beats
  Croatia"), set a budget, and slide between *express your view* and *protect it*. Every
  leg is a market that actually exists on Polymarket (non-fixtures like "Spain vs Portugal"
  are rejected with real suggestions); the payoff table, chance-of-profit, and honestly
  negative expected value are all shown. Aggressive end + exact-score/handicaps are gated
  for v1 (see `HedgeAdvisor-BetPlan-Design.md`).
- **`/` — hedge an existing position.** The original flow below.

## What works today (MVP)

- **Live data layer** — reads the public Polymarket Gamma/CLOB APIs (no auth). Parses
  the JSON-string fields and fixes the reversed order-book sort at one boundary. The
  de-vig runs off **fresh live CLOB midpoints** (not the stale Gamma snapshot), so every
  risk number is current and consistent with the book the hedge is walked against; each
  result is stamped with its price source + timestamp.
- **Net-cost engine** — one verified fee function (sports taker fee, peak **0.75%** at
  p=0.5, sells exempt), order-book walk for true VWAP + slippage, P&L distribution,
  std-dev / max-loss / CVaR.
- **Structural correlation** — correlations *derived* from price + logic (exact for the
  within-event complement), never fitted from history; each carries a plain-language why.
- **Sizing + one verdict** — half-Kelly over the 60-outcome partition, sized against your
  real bankroll (a trivial-fraction position correctly hedges ~zero — the honest "don't
  pay the vig" answer), then a single go/no-go authority (`lib/sizing/decide.ts`)
  producing the one `Decision`.
- **Honest explanation** — deterministic template by default; optional LLM polish behind
  a number-guardrail (it can never state a number that isn't in the computed facts).
- **L1 execution** — deep-link to the exact Polymarket market + a "place it like this"
  card. We never touch funds, keys, or orders. (Polymarket can't pre-fill orders via URL.)
- **Proprietary-history crons** — `/api/cron/snapshot` captures fine-grained price/depth
  series, while `/api/cron/settle` ingests resolved paired outcomes for association calibration;
  both no-op gracefully without a database.

L2 non-custodial in-app execution is scaffolded but **gated off** (see the compliance
doc) — it must clear a legal review before shipping.

## Run

```bash
npm install
cp .env.example .env   # all keys optional for the MVP
npm test               # honesty invariants
npm run dev            # http://localhost:3000
```

No database or API keys are required to run the core product — everything is on-demand
against the public Polymarket API. Optional: `DATABASE_URL` (enables the snapshot moat),
`AI_GATEWAY_API_KEY` (enables LLM explanation polish).

## Architecture

```
position → lib/polymarket (resolve + normalize book) → outcome partition (de-vig)
        → lib/correlation (structural) → lib/netcost (walk book, fee) → lib/sizing
        → ONE Decision → lib/explain → lib/execute (L1 deep-link)
cron → /api/cron/snapshot → book_snapshot (the moat)
cron → /api/cron/settle → branch-normalized association_observation
soft candidate → Qwen hypothesis → settled-pair calibration → robust association optimizer
                         ↘ PostgreSQL LLM cache + latency/fallback metrics
```

The optional hybrid soft-association framework lives in `lib/association`. `/api/association` is a
hypothesis-only public analysis surface; actionable recommendations run through `/api/discover`,
which reads trusted settlement calibration. With no Qwen key it fails open for product availability
but fail-closed for recommendations: semantic hypotheses are simply ineligible until calibrated. See
[`ASSOCIATION_ENGINE.md`](ASSOCIATION_ENGINE.md).

Repeated LLM recall/classification inputs are cached for seven days by default, including across
stateless GitHub Action runs when `DATABASE_URL` is configured. `/api/diag/stats` reports cache hits,
model fallback/latency health, pending frozen pairs, and 100/300/500/1000 independent-cluster
calibration milestones. Neither cache metadata nor metrics store prompts, API keys, or credentials.

`lib/types.ts` is the single contract; the fee function and the go/no-go verdict each
live in exactly one place. See the tech spec for the full design and the verification
notes (every API/fee/contract fact was checked against live Polymarket endpoints).

## Honesty invariants (enforced by tests)

- Fee math matches Polymarket's published example ($0.375 for 100 sh @ $0.50).
- The order-book walk uses real fills, flags capacity, and rejects degenerate books.
- The verdict is never GO when risk isn't actually removed.
- Within-book hedging is always surfaced as EV-negative (variance reduction, not profit).

> Not financial advice. Prediction-market trading carries substantial risk including
> total loss. HedgeAdvisor is an independent interface, not affiliated with Polymarket,
> and never holds your funds or keys.
