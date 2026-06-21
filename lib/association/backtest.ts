import { calibrateConditionalPayoff, countConditionalObservations } from "./calibration";

export interface AssociationBacktestRow {
  relationKey: string;
  sampleKey: string;
  clusterKey: string;
  anchorPays: boolean;
  candidatePays: boolean;
  resolvedAt: string;
  observedAt: string;
  candidatePrice: number;
}

export interface WalkForwardOptions {
  credibleLevel?: number;
  minSamplesPerBranch?: number;
}

export interface WalkForwardForecast {
  relationKey: string;
  sampleKey: string;
  clusterKey: string;
  resolvedAt: string;
  trainRows: number;
  trainClusters: number;
  predictedCandidatePay: number;
  candidatePays: boolean;
  anchorPays: boolean;
  candidatePrice: number;
  actionable: boolean;
  hedgeSpecificityLower: number;
}

export interface WalkForwardResult {
  rows: number;
  cohorts: number;
  evaluated: number;
  actionable: number;
  coverage: number;
  brier: number | null;
  logLoss: number | null;
  ece: number | null;
  averageFailLossReduction: number | null;
  averageWinHedgeDrag: number | null;
  leakageViolations: number;
  forecasts: WalkForwardForecast[];
}

function normalizedTrainingCounts(rows: AssociationBacktestRow[]) {
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

/** Strict walk-forward evaluation: training must be resolved earlier and come from other clusters. */
export function walkForwardAssociationBacktest(
  input: AssociationBacktestRow[],
  options: WalkForwardOptions = {},
): WalkForwardResult {
  const minSamples = Math.max(2, Math.floor(options.minSamplesPerBranch ?? 20));
  const credibleLevel = Math.min(0.999, Math.max(0.5, options.credibleLevel ?? 0.95));
  const rows = input
    .filter((row) => Number.isFinite(Date.parse(row.resolvedAt)) && Number.isFinite(Date.parse(row.observedAt)))
    .filter((row) => row.candidatePrice > 0 && row.candidatePrice < 1 && Date.parse(row.observedAt) < Date.parse(row.resolvedAt))
    .sort((a, b) => Date.parse(a.resolvedAt) - Date.parse(b.resolvedAt) || a.sampleKey.localeCompare(b.sampleKey));
  const forecasts: WalkForwardForecast[] = [];
  let leakageViolations = 0;

  for (const test of rows) {
    const testTime = Date.parse(test.resolvedAt);
    const train = rows.filter((row) => row.relationKey === test.relationKey
      && row.clusterKey !== test.clusterKey
      && Date.parse(row.resolvedAt) < testTime);
    if (train.some((row) => Date.parse(row.resolvedAt) >= testTime || row.clusterKey === test.clusterKey)) leakageViolations++;
    if (train.length === 0) continue;
    const calibration = calibrateConditionalPayoff(normalizedTrainingCounts(train), credibleLevel, minSamples);
    const predicted = test.anchorPays ? calibration.payGivenAnchorPays.mean : calibration.payGivenAnchorFails.mean;
    forecasts.push({
      relationKey: test.relationKey,
      sampleKey: test.sampleKey,
      clusterKey: test.clusterKey,
      resolvedAt: test.resolvedAt,
      trainRows: train.length,
      trainClusters: new Set(train.map((row) => row.clusterKey)).size,
      predictedCandidatePay: predicted,
      candidatePays: test.candidatePays,
      anchorPays: test.anchorPays,
      candidatePrice: test.candidatePrice,
      actionable: calibration.sufficientEvidence && calibration.hedgeSpecificityLower > 0,
      hedgeSpecificityLower: calibration.hedgeSpecificityLower,
    });
  }

  const eps = 1e-9;
  const brier = forecasts.length ? forecasts.reduce((sum, f) => sum + (f.predictedCandidatePay - Number(f.candidatePays)) ** 2, 0) / forecasts.length : null;
  const logLoss = forecasts.length ? forecasts.reduce((sum, f) => {
    const p = Math.min(1 - eps, Math.max(eps, f.predictedCandidatePay));
    return sum - (f.candidatePays ? Math.log(p) : Math.log(1 - p));
  }, 0) / forecasts.length : null;
  const bins = Array.from({ length: 10 }, () => [] as WalkForwardForecast[]);
  for (const forecast of forecasts) bins[Math.min(9, Math.floor(forecast.predictedCandidatePay * 10))].push(forecast);
  const ece = forecasts.length ? bins.reduce((sum, bin) => {
    if (!bin.length) return sum;
    const pred = bin.reduce((s, f) => s + f.predictedCandidatePay, 0) / bin.length;
    const actual = bin.reduce((s, f) => s + Number(f.candidatePays), 0) / bin.length;
    return sum + (bin.length / forecasts.length) * Math.abs(pred - actual);
  }, 0) : null;
  const actionable = forecasts.filter((forecast) => forecast.actionable);
  const fails = actionable.filter((forecast) => !forecast.anchorPays);
  const wins = actionable.filter((forecast) => forecast.anchorPays);

  return {
    rows: rows.length,
    cohorts: new Set(rows.map((row) => row.relationKey)).size,
    evaluated: forecasts.length,
    actionable: actionable.length,
    coverage: forecasts.length ? actionable.length / forecasts.length : 0,
    brier,
    logLoss,
    ece,
    averageFailLossReduction: fails.length
      ? fails.reduce((sum, f) => sum + Number(f.candidatePays) - f.candidatePrice, 0) / fails.length
      : null,
    averageWinHedgeDrag: wins.length
      ? wins.reduce((sum, f) => sum + f.candidatePrice - Number(f.candidatePays), 0) / wins.length
      : null,
    leakageViolations,
    forecasts,
  };
}
