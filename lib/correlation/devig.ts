/**
 * lib/correlation/devig.ts — strip the overround from a mutually-exclusive book.
 *
 * The YES prices sum to 1 + overround. Risk metrics, CVaR and Kelly all need REAL
 * probabilities q that sum to 1. Without this nothing downstream is computable.
 *
 * Three methods (literature: Štrumbelj 2014, Shin 1992/1993, Clarke et al.):
 *   - proportional  q_i = p_i / Σp.            (simplest; under-corrects favorites)
 *   - power         q_i = p_i^k, Σ p_i^k = 1.  (favourite–longshot correction)
 *   - shin          insider-trader model; recovers a "z" (informed fraction).
 * `devigDetailed` picks the best valid method (Shin → power → proportional) and reports
 * which one + its recovered parameter, so the UI can SHOW the correction it applied
 * (a trust feature for an honesty-first tool). All ports are pure TS, no dependency.
 */

function clean(prices: number[]): number[] {
  return prices.map((p) => (Number.isFinite(p) && p > 0 ? p : 0));
}
function uniform(n: number): number[] {
  const u = 1 / Math.max(1, n);
  return Array.from({ length: n }, () => u);
}
function normalize(q: number[]): number[] {
  const s = q.reduce((a, b) => a + b, 0) || 1;
  return q.map((x) => x / s);
}

/** Proportional de-vig: q_i = p_i / Σ p_j. */
export function devig(yesPrices: number[]): number[] {
  const c = clean(yesPrices);
  const sum = c.reduce((a, b) => a + b, 0);
  if (sum <= 0) return uniform(c.length);
  return c.map((p) => p / sum);
}

/** The overround actually present in the book (e.g. 0.04 = 4% vig). */
export function overround(yesPrices: number[]): number {
  return yesPrices.reduce((a, b) => a + b, 0) - 1;
}

/**
 * Power method: find k with Σ p_i^k = 1, then q_i = p_i^k (renormalized for safety).
 * Σ p_i^k is monotone-decreasing in k (all p_i < 1), so a bisection is robust and also
 * handles a negative overround (Σp < 1 → k < 1). Returns { q, k }.
 */
export function devigPower(yesPrices: number[]): { q: number[]; k: number } {
  const p = clean(yesPrices);
  const sum = p.reduce((a, b) => a + b, 0);
  if (sum <= 0) return { q: uniform(p.length), k: 1 };
  if (Math.abs(sum - 1) < 1e-9) return { q: [...p], k: 1 };
  const g = (k: number) => p.reduce((a, x) => a + Math.pow(x, k), 0) - 1;
  let lo = 0.05;
  let hi = 30;
  // g(lo) should be > 0 (small k → each p_i^k near 1 → sum large), g(hi) < 0.
  if (!(g(lo) > 0) || !(g(hi) < 0)) return { q: devig(yesPrices), k: 1 };
  for (let it = 0; it < 100; it++) {
    const k = (lo + hi) / 2;
    if (g(k) > 0) lo = k;
    else hi = k;
  }
  const k = (lo + hi) / 2;
  return { q: normalize(p.map((x) => Math.pow(x, k))), k };
}

/**
 * Shin's method: the bookmaker faces a fraction z of insider traders. Recovers true
 * probabilities and z. We bisect z on [0, 0.5] (the valid region; the implied Σq is
 * decreasing there and crosses 1 at a small z) and fall back to proportional if there's
 * no sign change (e.g. a negative-overround book). Returns { q, z }.
 *   q_i(z) = ( sqrt(z² + 4(1−z)·p_i²/B) − z ) / ( 2(1−z) ),  B = Σ p_i.
 */
export function devigShin(yesPrices: number[]): { q: number[]; z: number } {
  const p = clean(yesPrices);
  const B = p.reduce((a, b) => a + b, 0);
  if (B <= 0) return { q: uniform(p.length), z: 0 };
  const qOf = (z: number) => p.map((pi) => (Math.sqrt(z * z + (4 * (1 - z) * pi * pi) / B) - z) / (2 * (1 - z)));
  const f = (z: number) => qOf(z).reduce((a, b) => a + b, 0) - 1;
  const lo0 = 0;
  const hi0 = 0.5;
  if (!(f(lo0) > 1e-12) || !(f(hi0) < -1e-12)) return { q: devig(yesPrices), z: 0 };
  let lo = lo0;
  let hi = hi0;
  for (let it = 0; it < 100; it++) {
    const z = (lo + hi) / 2;
    if (f(z) > 0) lo = z;
    else hi = z;
  }
  const z = (lo + hi) / 2;
  return { q: normalize(qOf(z)), z };
}

export interface DevigResult {
  q: number[];
  method: "shin" | "power" | "proportional";
  /** Recovered parameter: insider fraction z (shin) or exponent k (power). */
  param: number;
  overround: number;
}

/**
 * Pick the most accurate VALID de-vig: Shin first (best in the literature for the
 * favourite–longshot bias on skewed/multi-outcome books — exactly the exact-score and
 * tournament markets this tool targets), then power, then proportional. Reports the
 * method + recovered parameter so the UI can surface the correction applied.
 */
export function devigDetailed(yesPrices: number[]): DevigResult {
  const ov = overround(yesPrices);
  const n = clean(yesPrices).filter((p) => p > 0).length;
  if (n >= 2 && ov > 1e-4) {
    const shin = devigShin(yesPrices);
    if (shin.z > 1e-6) return { q: shin.q, method: "shin", param: shin.z, overround: ov };
    const pow = devigPower(yesPrices);
    if (Math.abs(pow.k - 1) > 1e-4) return { q: pow.q, method: "power", param: pow.k, overround: ov };
  }
  return { q: devig(yesPrices), method: "proportional", param: 1, overround: ov };
}
