/**
 * lib/plan/allocate.ts — budget allocation across a match's mutually-exclusive
 * outcomes, parameterized by the slider.
 *
 * Instead of a magic λ/κ constant (which drifts with leg prices — flagged in review),
 * we blend the TWO exact endpoint allocations:
 *   - expressionAlloc: all budget on the view outcome(s) — max upside if right.
 *   - minVarAlloc: buy each outcome ∝ its price, so terminal wealth is ~equal in every
 *     outcome (the min-variance / "protect" allocation; you get back ~B/(1+overround)).
 * blend(w) = (1−w)·expression + w·minVar. Both endpoints are exact by construction and
 * the slider feel is price-invariant. w comes from the slider s (v1 exposes s∈[0.4,1]).
 */

/** Dollars per outcome that equalize terminal payout across outcomes (min variance). */
export function minVarAlloc(prices: number[], budgetUsd: number): number[] {
  const sum = prices.reduce((a, b) => a + b, 0) || 1;
  return prices.map((p) => (budgetUsd * p) / sum);
}

/** All budget on the view outcome(s) — maximum expression of the view. */
export function expressionAlloc(prices: number[], viewIndices: number[], budgetUsd: number): number[] {
  const out = prices.map(() => 0);
  const live = viewIndices.filter((i) => i >= 0 && i < prices.length);
  if (live.length === 0) return minVarAlloc(prices, budgetUsd); // no view => neutral
  const per = budgetUsd / live.length;
  for (const i of live) out[i] = per;
  return out;
}

/** Blend the two endpoints by w∈[0,1]: w=0 full expression, w=1 full hedge/protect. */
export function blendAlloc(
  prices: number[],
  viewIndices: number[],
  budgetUsd: number,
  w: number,
): number[] {
  const ww = Math.min(1, Math.max(0, w));
  const e = expressionAlloc(prices, viewIndices, budgetUsd);
  const m = minVarAlloc(prices, budgetUsd);
  return prices.map((_, i) => (1 - ww) * e[i] + ww * m[i]);
}

/** Slider s (0..1) → blend weight w. v1 exposes s∈[0.4,1.0]; s maps straight to w. */
export function sliderToWeight(s: number): number {
  return Math.min(1, Math.max(0, s));
}

export function posture(s: number): "Express" | "Balanced" | "Protect" {
  if (s < 0.4) return "Express";
  if (s < 0.8) return "Balanced";
  return "Protect";
}
