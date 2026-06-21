/**
 * lib/estimate/calibration.ts — does a probability forecast match reality?
 *
 * Pure scoring functions for backtesting de-vigged probabilities against RESOLVED outcomes.
 * "Calibrated" means: of the things we called 40%, about 40% happened. These metrics let us
 * MEASURE that on real Polymarket resolutions instead of asserting accuracy — the honest gate
 * before any estimated number is trusted. Used by the (manual) backtest harness, not the
 * request path.
 */

export interface Sample {
  p: number; // predicted probability of the event, in [0,1]
  outcome: 0 | 1; // realized: 1 = happened, 0 = didn't
}

export interface ReliabilityBucket {
  lo: number;
  hi: number;
  n: number;
  meanPred: number; // average predicted probability in the bucket
  meanOutcome: number; // realized frequency in the bucket (the calibration target)
}

export interface CalibrationReport {
  n: number;
  brier: number; // mean (p − o)²  (0 = perfect, lower better)
  logLoss: number; // −mean[o·ln p + (1−o)·ln(1−p)]  (clamped; lower better)
  meanPred: number; // calibration-in-the-large: average forecast
  baseRate: number; // average realized frequency
  bias: number; // meanPred − baseRate (≈0 = unbiased overall; >0 = over-forecasting)
  ece: number; // expected calibration error: Σ (n_b/N)·|meanPred_b − meanOutcome_b|
  brierSkill: number; // 1 − brier / (baseRate·(1−baseRate))  (>0 = beats the base-rate guess)
  buckets: ReliabilityBucket[];
}

const clampP = (p: number) => Math.min(1 - 1e-9, Math.max(1e-9, p));

/** Score a set of (prediction, realized outcome) pairs. */
export function calibration(samples: Sample[], nBuckets = 10): CalibrationReport {
  const xs = samples.filter((s) => Number.isFinite(s.p) && (s.outcome === 0 || s.outcome === 1));
  const n = xs.length;
  if (n === 0) {
    return { n: 0, brier: 0, logLoss: 0, meanPred: 0, baseRate: 0, bias: 0, ece: 0, brierSkill: 0, buckets: [] };
  }
  let brierSum = 0;
  let logLossSum = 0;
  let predSum = 0;
  let outSum = 0;
  for (const s of xs) {
    const p = Math.min(1, Math.max(0, s.p));
    brierSum += (p - s.outcome) ** 2;
    const pc = clampP(p);
    logLossSum += -(s.outcome * Math.log(pc) + (1 - s.outcome) * Math.log(1 - pc));
    predSum += p;
    outSum += s.outcome;
  }
  const brier = brierSum / n;
  const logLoss = logLossSum / n;
  const meanPred = predSum / n;
  const baseRate = outSum / n;
  const variance = baseRate * (1 - baseRate);
  const brierSkill = variance > 1e-9 ? 1 - brier / variance : 0;

  // reliability buckets (equal-width) + expected calibration error
  const buckets: ReliabilityBucket[] = [];
  let ece = 0;
  for (let b = 0; b < nBuckets; b++) {
    const lo = b / nBuckets;
    const hi = (b + 1) / nBuckets;
    const inB = xs.filter((s) => {
      const p = Math.min(1, Math.max(0, s.p));
      return b === nBuckets - 1 ? p >= lo && p <= hi : p >= lo && p < hi;
    });
    if (inB.length === 0) continue;
    const mp = inB.reduce((a, s) => a + Math.min(1, Math.max(0, s.p)), 0) / inB.length;
    const mo = inB.reduce((a, s) => a + s.outcome, 0) / inB.length;
    buckets.push({ lo, hi, n: inB.length, meanPred: mp, meanOutcome: mo });
    ece += (inB.length / n) * Math.abs(mp - mo);
  }

  return {
    n,
    brier: Number(brier.toFixed(4)),
    logLoss: Number(logLoss.toFixed(4)),
    meanPred: Number(meanPred.toFixed(4)),
    baseRate: Number(baseRate.toFixed(4)),
    bias: Number((meanPred - baseRate).toFixed(4)),
    ece: Number(ece.toFixed(4)),
    brierSkill: Number(brierSkill.toFixed(4)),
    buckets,
  };
}
