/**
 * lib/relate/comboBacktest.ts — Phase 4 of the joint-combo roadmap
 * (docs/settlement-moat-and-joint-combo-calibration.md, Part II).
 *
 * Walk-forward scoring of FROZEN combo snapshots against later settlement. The walk-forward discipline is
 * enforced UPSTREAM: a record is admissible only if the combo was frozen (observedAt) before the anchor
 * resolved (anchorResolvedAt) — the harness asserts this and drops violators, so no post-resolution combo
 * can leak in. The pure scorer below then compares what the engine PREDICTED (coverageLower) against what
 * REALLY happened, and reports fail-loss reduction, win drag, and each leg-rank's marginal contribution.
 *
 * STATUS: machinery only. No combo snapshots have been logged yet, so on the real data path this returns an
 * empty report with a note. It is unit-tested with synthetic records so the metrics are correct once Phase 2
 * logging starts producing real frozen combos. HONESTY: this NEVER promotes a tier — it MEASURES; Phase 5
 * consumes its evidence to (eventually) gate JOINT-CALIBRATED.
 */

import type { ScenarioBucket } from "./scenarioBucket";

export interface BacktestComboLeg {
  rank: number;            // selection order within the combo (0 = first/strongest)
  scenario: ScenarioBucket;
  paid: boolean;           // did this leg settle in-the-money?
}

export interface BacktestComboRecord {
  observedAt: string;      // when the combo was frozen (must be BEFORE anchorResolvedAt)
  anchorResolvedAt: string;
  anchorPays: boolean;     // did the user's PRIMARY bet win?
  predictedCoverageLower: number; // engine's pre-settlement P(≥1 leg pays | anchor fails)
  premiumSpent: number;
  comboPayoffUsd: number;  // realized $ the combo paid out
  legs: BacktestComboLeg[];
}

export interface ComboBacktestReport {
  combos: number;                 // admissible records scored
  dropped: number;                // records dropped for walk-forward violation (observedAt ≥ resolvedAt)
  anchorFailCombos: number;
  realizedCoverageWhenFail: number | null;   // realized P(any leg paid | anchor failed)
  predictedCoverageWhenFail: number | null;  // mean predicted coverage on those same records
  coverageCalibrationGap: number | null;     // predicted − realized (positive ⇒ engine was over-optimistic)
  avgFailLossReductionUsd: number | null;    // mean (payoff − premium) when the anchor failed
  avgWinDragUsd: number | null;              // mean (premium − payoff) when the anchor won (the drag you ate)
  marginalContributionByRank: Record<number, number>; // P(rank r paid AND no lower rank paid | fail)
  note?: string;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

export function backtestCombos(records: BacktestComboRecord[]): ComboBacktestReport {
  const admissible = records.filter((r) => r.observedAt < r.anchorResolvedAt);
  const dropped = records.length - admissible.length;
  if (!admissible.length) {
    return {
      combos: 0, dropped, anchorFailCombos: 0,
      realizedCoverageWhenFail: null, predictedCoverageWhenFail: null, coverageCalibrationGap: null,
      avgFailLossReductionUsd: null, avgWinDragUsd: null, marginalContributionByRank: {},
      note: records.length ? "all records dropped: combo frozen at/after anchor resolution (walk-forward violation)" : "no frozen combo snapshots yet — Phase 2 logging must accrue real combos first",
    };
  }
  const fails = admissible.filter((r) => !r.anchorPays);
  const wins = admissible.filter((r) => r.anchorPays);

  const realizedCoverageWhenFail = mean(fails.map((r) => (r.legs.some((l) => l.paid) ? 1 : 0)));
  const predictedCoverageWhenFail = mean(fails.map((r) => r.predictedCoverageLower));
  const coverageCalibrationGap =
    predictedCoverageWhenFail !== null && realizedCoverageWhenFail !== null ? predictedCoverageWhenFail - realizedCoverageWhenFail : null;

  // Marginal contribution of each rank: among fail records, the leg at rank r PAID and every lower-ranked
  // (earlier-selected) leg did NOT — i.e. rank r is the one that actually caught a fail the others missed.
  const ranks = [...new Set(admissible.flatMap((r) => r.legs.map((l) => l.rank)))].sort((a, b) => a - b);
  const marginalContributionByRank: Record<number, number> = {};
  for (const rank of ranks) {
    const credited = fails.filter((r) => {
      const leg = r.legs.find((l) => l.rank === rank);
      if (!leg?.paid) return false;
      return !r.legs.some((l) => l.rank < rank && l.paid);
    }).length;
    marginalContributionByRank[rank] = fails.length ? credited / fails.length : 0;
  }

  return {
    combos: admissible.length, dropped, anchorFailCombos: fails.length,
    realizedCoverageWhenFail, predictedCoverageWhenFail, coverageCalibrationGap,
    avgFailLossReductionUsd: mean(fails.map((r) => r.comboPayoffUsd - r.premiumSpent)),
    avgWinDragUsd: mean(wins.map((r) => r.premiumSpent - r.comboPayoffUsd)),
    marginalContributionByRank,
  };
}
