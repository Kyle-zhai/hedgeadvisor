import type {
  BinaryObservation,
  ConditionalCalibration,
  ConditionalCounts,
  ProbabilityInterval,
} from "./types";

const EPS = 1e-14;

/** Convert paired settled observations into the four sufficient statistics. */
export function countConditionalObservations(observations: BinaryObservation[]): ConditionalCounts {
  const out: ConditionalCounts = {
    anchorPayCandidatePay: 0,
    anchorPayCandidateNoPay: 0,
    anchorNoPayCandidatePay: 0,
    anchorNoPayCandidateNoPay: 0,
  };
  for (const o of observations) {
    const w = Number.isFinite(o.weight) && (o.weight ?? 0) > 0 ? o.weight! : 1;
    if (o.anchorPays && o.candidatePays) out.anchorPayCandidatePay += w;
    else if (o.anchorPays) out.anchorPayCandidateNoPay += w;
    else if (o.candidatePays) out.anchorNoPayCandidatePay += w;
    else out.anchorNoPayCandidateNoPay += w;
  }
  return out;
}

// Lanczos log-gamma, accurate to near machine precision for the positive inputs used here.
function logGamma(z: number): number {
  const p = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  let x = p[0];
  const zz = z - 1;
  for (let i = 1; i < p.length; i++) x += p[i] / (zz + i);
  const t = zz + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIter = 240;
  const fpMin = 1e-300;
  let qab = a + b;
  let qap = a + 1;
  let qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < fpMin) d = fpMin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 3e-14) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b). */
export function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (!(a > 0 && b > 0)) throw new Error("beta parameters must be positive");
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  return x < (a + 1) / (a + b + 2)
    ? (bt * betaContinuedFraction(a, b, x)) / a
    : 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Deterministic inverse beta CDF using safeguarded bisection. */
export function betaQuantile(prob: number, a: number, b: number): number {
  if (prob <= 0) return 0;
  if (prob >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (regularizedBeta(mid, a, b) < prob) lo = mid;
    else hi = mid;
    if (hi - lo < EPS) break;
  }
  return (lo + hi) / 2;
}

function posterior(successes: number, failures: number, credibleLevel: number): ProbabilityInterval {
  const alpha = Math.max(0, successes) + 0.5; // Jeffreys prior
  const beta = Math.max(0, failures) + 0.5;
  const tail = (1 - credibleLevel) / 2;
  return {
    mean: alpha / (alpha + beta),
    lower: betaQuantile(tail, alpha, beta),
    upper: betaQuantile(1 - tail, alpha, beta),
    alpha,
    beta,
    samples: Math.max(0, successes) + Math.max(0, failures),
  };
}

/**
 * Calibrate candidate payoff conditional on the anchor paying/failing. The returned lower
 * specificity is deliberately cross-bound: lower P(pay|fail) - upper P(pay|win).
 */
export function calibrateConditionalPayoff(
  counts: ConditionalCounts,
  credibleLevel = 0.95,
  minSamplesPerBranch = 20,
): ConditionalCalibration {
  const level = Math.min(0.999, Math.max(0.5, credibleLevel));
  const win = posterior(counts.anchorPayCandidatePay, counts.anchorPayCandidateNoPay, level);
  const fail = posterior(counts.anchorNoPayCandidatePay, counts.anchorNoPayCandidateNoPay, level);
  return {
    method: "beta-binomial-jeffreys",
    credibleLevel: level,
    payGivenAnchorPays: win,
    payGivenAnchorFails: fail,
    hedgeSpecificityLower: fail.lower - win.upper,
    posteriorSpecificity: fail.mean - win.mean,
    sufficientEvidence: win.samples >= minSamplesPerBranch && fail.samples >= minSamplesPerBranch,
  };
}
