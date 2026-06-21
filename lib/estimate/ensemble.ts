/**
 * lib/estimate/ensemble.ts — uncertainty from an ENSEMBLE of estimates.
 *
 * Adapted (as a method, not code) from the MiroFish/Polymarket community recipe: instead of
 * trusting a single point estimate, take several INDEPENDENT estimates of the same quantity,
 * report mean ± std, and shrink the headline toward 50% in proportion to the disagreement.
 *
 * Honesty: this does NOT make a prediction more accurate — it quantifies how UNSURE we are,
 * and refuses to look confident when the estimates disagree (shrink toward 0.5). It never
 * implies an edge.
 */

export interface EnsembleStat {
  mean: number;
  std: number; // sample standard deviation across the estimates
  n: number;
  /** Headline probability shrunk toward 0.5 by an amount that grows with the disagreement. */
  shrunk: number;
  lo: number; // min estimate (band floor)
  hi: number; // max estimate (band ceiling)
}

/**
 * @param samples  independent probability estimates of the SAME event, each in [0,1]
 * @param shrinkLambda  how aggressively to shrink toward 0.5 per unit of std (default 2.5)
 */
export function ensemble(samples: number[], shrinkLambda = 2.5): EnsembleStat {
  const xs = samples.filter((x) => Number.isFinite(x)).map((x) => Math.min(1, Math.max(0, x)));
  const n = xs.length;
  if (n === 0) return { mean: 0.5, std: 0, n: 0, shrunk: 0.5, lo: 0.5, hi: 0.5 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const std = Math.sqrt(Math.max(0, variance));
  // shrink toward 0.5 proportional to disagreement (the "haircut"): more std → closer to 50%
  const shrink = Math.min(1, shrinkLambda * std);
  const shrunk = 0.5 + (mean - 0.5) * (1 - shrink);
  return { mean, std, n, shrunk, lo: Math.min(...xs), hi: Math.max(...xs) };
}
