/**
 * lib/estimate/joint.ts — HONEST cross-market joint probability for a parlay (all legs hit).
 *
 * The honesty problem: the true chance that two DIFFERENT markets both resolve YES depends on
 * their correlation, which we cannot measure from prices alone. So we never fabricate a single
 * correlation coefficient. Instead we report:
 *   - independence:  Π q_i           (the naive parlay assumption)
 *   - frechet range: the EXACT min/max P(all hit) consistent with the marginals, over ALL
 *                    possible correlations (Fréchet–Hoeffding bounds) — no assumption needed.
 *   - illustrative:  a one-factor Gaussian-copula Monte-Carlo point at a STATED, labelled ρ,
 *                    purely to show which way correlation pushes it (never presented as truth).
 *
 * Each leg's marginal carries its OWN uncertainty band, taken from the disagreement between the
 * three de-vig methods (proportional / power / Shin) via lib/estimate/ensemble. So the final
 * range reflects BOTH marginal uncertainty AND correlation uncertainty. Everything is labelled
 * "estimated, not analytic" upstream in the UI.
 */
import { devig, devigPower, devigShin } from "@/lib/correlation";
import { mulberry32 } from "@/lib/sim/generator";
import { ensemble } from "./ensemble";

export interface MarginalBand {
  lo: number;
  mid: number;
  hi: number;
  std: number;
  methods: { proportional: number; power: number; shin: number };
}

/** Marginal probability of outcome `index`, with a band from de-vig METHOD disagreement. */
export function marginalBand(yesPrices: number[], index: number): MarginalBand {
  const prop = devig(yesPrices)[index] ?? 0;
  const pow = devigPower(yesPrices).q[index] ?? prop;
  const shin = devigShin(yesPrices).q[index] ?? prop;
  const e = ensemble([prop, pow, shin]);
  return { lo: e.lo, mid: e.mean, hi: e.hi, std: e.std, methods: { proportional: prop, power: pow, shin } };
}

export interface JointEstimate {
  independence: number; // Π mid — assumes independence
  // Fréchet–Hoeffding ENVELOPE: the bound widened to the worst-case ends of each marginal's
  // uncertainty band (so it absorbs de-vig method disagreement too). It is wider than, and
  // contains, the strict Fréchet bound at the mid marginals — i.e. conservative, never tighter.
  frechetLow: number;
  frechetHigh: number;
  illustrativeRho: number; // the ρ used for the illustrative correlated point
  correlated: number; // one-factor copula MC at illustrativeRho (illustrative only)
  legs: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * P(all legs hit) for a cross-market parlay. Returns the independence point, the EXACT
 * Fréchet–Hoeffding range (using each leg's marginal band for the widest honest envelope),
 * and an illustrative correlated point at a stated ρ.
 */
export function jointAllHit(bands: { lo: number; mid: number; hi: number }[], opts?: { rho?: number; N?: number; seed?: number }): JointEstimate {
  const n = bands.length;
  const mids = bands.map((b) => clamp01(b.mid));
  const independence = mids.reduce((a, b) => a * b, 1);
  // widest honest envelope: upper bound uses the upper marginals, lower bound the lower marginals
  const frechetHigh = Math.min(...bands.map((b) => clamp01(b.hi)));
  const frechetLow = Math.max(0, bands.map((b) => clamp01(b.lo)).reduce((a, b) => a + b, 0) - (n - 1));
  const rho = Math.min(0.95, Math.max(0, opts?.rho ?? 0.25));
  const correlated = copulaAllHit(mids, rho, opts?.N ?? 20000, opts?.seed ?? 42);
  return {
    independence: Number(independence.toFixed(4)),
    frechetLow: Number(frechetLow.toFixed(4)),
    frechetHigh: Number(frechetHigh.toFixed(4)),
    illustrativeRho: rho,
    correlated: Number(correlated.toFixed(4)),
    legs: n,
  };
}

/** One-factor Gaussian copula: P(all binary events hit) at equicorrelation ρ≥0, via Monte Carlo. */
export function copulaAllHit(p: number[], rho: number, N = 20000, seed = 42): number {
  const rng = mulberry32(seed);
  const a = Math.sqrt(clamp01(rho));
  const b = Math.sqrt(Math.max(0, 1 - a * a));
  const thresh = p.map((pi) => invNorm(clamp01(pi))); // event i hits when latent Z_i ≤ Φ⁻¹(p_i)
  let hits = 0;
  for (let s = 0; s < N; s++) {
    const f = gauss(rng);
    let all = true;
    for (let i = 0; i < p.length; i++) {
      const z = a * f + b * gauss(rng);
      if (z > thresh[i]) {
        all = false;
        break;
      }
    }
    if (all) hits++;
  }
  return hits / N;
}

/** Standard normal sample via Box–Muller off a uniform PRNG. */
function gauss(rng: () => number): number {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Inverse standard-normal CDF (Acklam's rational approximation; |error| < 1.15e-9). */
export function invNorm(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  const ph = 1 - pl;
  let q: number;
  let r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= ph) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}
