# REFOCUS — the north star: positive-sum companion bets, not shorting, not prediction

> **Thesis (encode this everywhere).**
> HedgeAdvisor does **not** predict whether your bet wins, and it does **not** insure it by shorting it.
> It answers: **if your bet does NOT win, is there a positive-sum bet on a DIFFERENT event that pays
> instead — so ideally both win, and at worst one wins?**
> 不预测、不做空。找的是"别的事件上、你没中时反而可能获益"的正和伴随注:最好两个都中,最差只中一个。

Status as of **2026-06-21**: this supersedes the original (2026-06-17) refocus plan, which was built on a
maximin/CVaR loss-minimization engine that hedged by **shorting the user's own bet** (buy-your-own-NO
complement, rival baskets, containment-inverted "reach-final NO" ladders). The owner rejected that model
("彻底不做空自己") — a hedge that pays only because you lose is a zero-sum mirror, not a companion bet.
The product is now positive-sum only, dual-venue, and ships **during** the World Cup.

---

## 1. The model

The user holds (or is about to place) a primary bet **B** that pays in its win-states `W` and loses
elsewhere. A **hedge leg H** is admissible only if **all** of the following hold:

1. **Different event.** `H` resolves on a different event than `B` (never the same single-winner market;
   no rivals of B's own outcome; no same-entity subset/progression of B).
2. **Positive-sum / decorrelated.** `H` is a standalone positive bet that tends to **pay when B fails**
   (negative correlation). Ideally both B and H win; at worst one wins. A leg that is positively
   correlated with B (it pays *more* when B wins) **amplifies** exposure and is rejected as a hedge.
3. **Honestly costed.** `H` is priced at the real executable book cost (slippage + fee + depth cap),
   de-vigged; EV stays negative (the vig). Every added leg *raises* the strict worst-case loss because
   it can pay $0 in some state — shown explicitly, never "fully hedged for free."

What we removed (the entire short-your-own-bet family): buy-your-own-NO complement, exclusive rivals in
B's single-winner set, cross-venue equivalent-NO, and containment-inverted subset ("B fails to reach the
final" ⊆ "B fails"). None of these is positive-sum.

## 2. The trust ladder (two layers, never blurred)

- **ANALYTIC** — logically certain structural relations. Deterministic code only.
- **CALIBRATED** — settlement-proven: independent beta-binomial posteriors for `P(H pays | B fails)` vs
  `P(H pays | B wins)` on a stable mechanism cohort key, with credible-interval gating.
- **HYPOTHESIS / inferred** — an LLM (Qwen) mechanism graph or φ heuristic with no settlement history.
  Admitted only as a clearly-labeled **low-confidence exploratory** leg, never as a guarantee, and never
  promoted into the trustworthy layer.

The honesty backbone is non-negotiable: EV always negative, no phantom gain, exact-vs-estimated labeled,
"probabilities are market-implied (de-vigged), not forecasts," and the inferred layer stays subordinate.

## 3. Launch constraint — calibration cannot mature in one tournament

Settlement calibration needs ~20+ independent samples per (cohort, branch); one World Cup is ≈ one
cluster. So at launch the **Optimal** layer will frequently be empty and the live value comes from the
**Exploratory** inferred layer (Qwen mechanism graphs + φ), shown low-confidence. This is by design and
must read as honest, not broken: an empty Optimal layer is a first-class answer ("hold the bet as is").

## 4. Calibrator accuracy (eval 2026-06-21, 6 WC-champion anchors, 45 inferred relations)

- **Relatedness precision 71%** (32/45): finds the right neighborhood; ~29% junk (wrong-nation players,
  anonymized placeholders, same-entity duplicates, near-zero-correlation noise).
- **Correlation-sign accuracy 36%** (16/45): worse than a coin flip; systematically mis-signs obviously
  positive same-nation markets as ~0/negative.
- **Positive-sum-hedge validity 2%** (1/45): for a single-nation WC-champion anchor there is essentially
  **no valid positive-sum cross-event hedge** — the fail-correlated markets are same-event rivals
  (rejected as shorts), and the different-event markets found are same-nation props (positively
  correlated, fail together). The engine is **honest** about this (NO_ACTION on 5/6, correct).
- The one real risk was presentational: positively-correlated player props shown in a hedge-shaped UI.
  **Fixed**: the `/hedge` companion layers now exclude `correlation ≥ 0` markets (they amplify, not
  hedge) and note how many were hidden.

Open improvements (engine accuracy): deterministic player→nation roster join to kill wrong-entity recall;
drop anonymized-placeholder rows; require strictly-negative correlation for any "hedge"-labeled leg;
widen the candidate universe beyond the World Cup so genuinely decorrelated cross-domain hedges can appear.

## 5. Surfaces (consolidated 2026-06-21 — no overlap)

| Surface | Job | Engine | Shorts? |
|---|---|---|---|
| **Hedge** `/hedge` | the one positive-sum hedge surface: bet → companion bets, Optimal + Exploratory | `discoverRelations` (lib/relate + lib/association) | never |
| **Combo** `/combo` | parlay truth-check: real cost, fair value, compounded vig, structural impossibility | `runCombo` | never |
| **Cross-venue** `/link` | same outcome on Polymarket vs Kalshi → cheaper execution venue | `relateCrossVenue` | never |
| **Markets** `/markets` | read-only live market ledger | `gammaGet` | never |

Removed in the consolidation: `/protect` and `/discover` (duplicate engines) merged into **/hedge**
(`/protect`, `/discover` now 307-redirect there); `/plan` deprecated (single-fixture builder whose
"protect" end shorted); legacy `/hedge` shorting page deleted; `lib/hedge` maximin engine + `/api/protect`
+ `/api/hedge` + `/api/plan` + the orphan `/api/association` deleted.

**Known dead code (follow-up):** `lib/pipeline`'s `runHedge`/`runPlan` + `lib/plan` + the
`complementEdge`/`rivalEdge` shorting helpers are now unreachable (their routes are gone) but still
present; removing them is a separate, verified cleanup (they live in the same 867-line file as the kept
`runCombo`).

## 6. Preserved primitives (still correct, do not weaken)

- Real-book executable pricing (slippage/fee/depth cap, near-touch) — the true cost of a leg.
- De-vig q as the executable-price honesty floor (compliance, not prediction).
- Strict worst-case loss as a probability-free primitive; every leg can pay $0.
- "Don't bother / nothing to do" as a designed verdict.
- The φ relation math (exact for structural, Fréchet-clamped estimate otherwise); price co-movement is
  never used as φ.
- L2 non-custodial execution stays fail-closed and legally gated (never auto-enabled).
