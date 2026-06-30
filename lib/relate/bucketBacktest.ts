/**
 * lib/relate/bucketBacktest.ts — COARSE-BUCKET strict walk-forward backtest (the credibility report).
 *
 * The existing walkForwardAssociationBacktest (lib/association/backtest.ts) groups training by EXACT
 * relationKey, which is far too sparse (~3 rows/key) to ever clear ≥20/branch. But the LIVE engine calibrates
 * at the COARSE bucket grain `role|mechType|direction|side` (tuningProfile), pooling many relationKeys. This
 * backtest reproduces the engine's actual calibration grain under STRICT walk-forward discipline, so the
 * credibility numbers match what the engine really serves.
 *
 * Discipline (identical to the relationKey version, just a coarser group):
 *   - training rows must have resolved STRICTLY earlier than the test (no look-ahead),
 *   - training EXCLUDES the test's own cluster (one real-world event can't predict itself),
 *   - per-cluster down-weighting so one event ≠ many independent samples,
 *   - beta-binomial credible interval; a bucket is actionable only when sufficientEvidence && specLower > 0.
 * DIRECTION stays in the bucket key, so a hedge (negative) and amplifier (positive) never pool (F2).
 */

import { calibrateConditionalPayoff, countConditionalObservations } from "@/lib/association/calibration";
import type { AssociationBacktestRow, WalkForwardOptions } from "@/lib/association/backtest";
import { parseRelationKey } from "./tuningProfile";

export interface BucketBacktestResult {
  rows: number;
  buckets: number;
  evaluated: number;
  actionable: number;
  coverage: number;
  brier: number | null;
  logLoss: number | null;
  ece: number | null;
  averageFailLossReduction: number | null;
  averageWinHedgeDrag: number | null;
  leakageViolations: number;
  /** Per leaf bucket: how many test points were actionable (CALIBRATED-eligible) out-of-sample. */
  byBucket: Record<string, { evaluated: number; actionable: number; meanSpecLower: number }>;
}

function clusterWeightedCounts(rows: AssociationBacktestRow[]) {
  const sizes = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.clusterKey}|${row.anchorPays ? 1 : 0}`;
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  return countConditionalObservations(rows.map((row) => ({
    anchorPays: row.anchorPays,
    candidatePays: row.candidatePays,
    weight: 1 / (sizes.get(`${row.clusterKey}|${row.anchorPays ? 1 : 0}`) ?? 1),
  })));
}

const leafBucket = (relationKey: string): string | null => {
  const p = parseRelationKey(relationKey);
  return p ? `${p.role}|${p.mechType}|${p.direction}|${p.side}` : null;
};

export function walkForwardByBucket(input: AssociationBacktestRow[], options: WalkForwardOptions = {}): BucketBacktestResult {
  const minSamples = Math.max(2, Math.floor(options.minSamplesPerBranch ?? 20));
  const credibleLevel = Math.min(0.999, Math.max(0.5, options.credibleLevel ?? 0.95));
  const rows = input
    .map((row) => ({ row, bucket: leafBucket(row.relationKey) }))
    .filter((r): r is { row: AssociationBacktestRow; bucket: string } => r.bucket !== null
      && Number.isFinite(Date.parse(r.row.resolvedAt)) && Number.isFinite(Date.parse(r.row.observedAt))
      && r.row.candidatePrice > 0 && r.row.candidatePrice < 1 && Date.parse(r.row.observedAt) < Date.parse(r.row.resolvedAt))
    .sort((a, b) => Date.parse(a.row.resolvedAt) - Date.parse(b.row.resolvedAt) || a.row.sampleKey.localeCompare(b.row.sampleKey));

  type F = { bucket: string; predicted: number; candidatePays: boolean; anchorPays: boolean; candidatePrice: number; actionable: boolean; specLower: number };
  const forecasts: F[] = [];
  let leakageViolations = 0;

  for (const { row: test, bucket } of rows) {
    const testTime = Date.parse(test.resolvedAt);
    const earlierSameBucket = rows.filter((r) => r.bucket === bucket && r.row.sampleKey !== test.sampleKey && Date.parse(r.row.resolvedAt) < testTime);
    const train = earlierSameBucket.filter((r) => r.row.clusterKey !== test.clusterKey).map((r) => r.row);
    if (earlierSameBucket.some((r) => r.row.clusterKey === test.clusterKey)) leakageViolations++;
    if (train.length === 0) continue;
    const cal = calibrateConditionalPayoff(clusterWeightedCounts(train), credibleLevel, minSamples);
    forecasts.push({
      bucket,
      predicted: test.anchorPays ? cal.payGivenAnchorPays.mean : cal.payGivenAnchorFails.mean,
      candidatePays: test.candidatePays,
      anchorPays: test.anchorPays,
      candidatePrice: test.candidatePrice,
      actionable: cal.sufficientEvidence && cal.hedgeSpecificityLower > 0,
      specLower: cal.hedgeSpecificityLower,
    });
  }

  const eps = 1e-9;
  const brier = forecasts.length ? forecasts.reduce((s, f) => s + (f.predicted - Number(f.candidatePays)) ** 2, 0) / forecasts.length : null;
  const logLoss = forecasts.length ? forecasts.reduce((s, f) => { const p = Math.min(1 - eps, Math.max(eps, f.predicted)); return s - (f.candidatePays ? Math.log(p) : Math.log(1 - p)); }, 0) / forecasts.length : null;
  const bins = Array.from({ length: 10 }, () => [] as F[]);
  for (const f of forecasts) bins[Math.min(9, Math.floor(f.predicted * 10))].push(f);
  const ece = forecasts.length ? bins.reduce((s, b) => { if (!b.length) return s; const pred = b.reduce((x, f) => x + f.predicted, 0) / b.length; const act = b.reduce((x, f) => x + Number(f.candidatePays), 0) / b.length; return s + (b.length / forecasts.length) * Math.abs(pred - act); }, 0) : null;
  const act = forecasts.filter((f) => f.actionable);
  const fails = act.filter((f) => !f.anchorPays);
  const wins = act.filter((f) => f.anchorPays);

  const byBucket: BucketBacktestResult["byBucket"] = {};
  for (const f of forecasts) {
    const b = byBucket[f.bucket] ?? { evaluated: 0, actionable: 0, meanSpecLower: 0 };
    b.evaluated++; if (f.actionable) b.actionable++; b.meanSpecLower += f.specLower;
    byBucket[f.bucket] = b;
  }
  for (const b of Object.values(byBucket)) b.meanSpecLower = +(b.meanSpecLower / Math.max(1, b.evaluated)).toFixed(4);

  return {
    rows: rows.length,
    buckets: new Set(rows.map((r) => r.bucket)).size,
    evaluated: forecasts.length,
    actionable: act.length,
    coverage: forecasts.length ? act.length / forecasts.length : 0,
    brier, logLoss, ece,
    averageFailLossReduction: fails.length ? fails.reduce((s, f) => s + Number(f.candidatePays) - f.candidatePrice, 0) / fails.length : null,
    averageWinHedgeDrag: wins.length ? wins.reduce((s, f) => s + f.candidatePrice - Number(f.candidatePays), 0) / wins.length : null,
    leakageViolations,
    byBucket,
  };
}
