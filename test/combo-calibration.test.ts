import { describe, it, expect } from "vitest";
import { backtestCombos, type BacktestComboRecord } from "@/lib/relate/comboBacktest";
import { learnedOverlapPenalty, jointCalibratedGate, type ComboFamilyEvidence } from "@/lib/relate/jointCalibration";

describe("backtestCombos (Phase 4)", () => {
  it("empty input → dormant report with note (no data path)", () => {
    const r = backtestCombos([]);
    expect(r.combos).toBe(0);
    expect(r.realizedCoverageWhenFail).toBeNull();
    expect(r.note).toMatch(/no frozen combo snapshots/i);
  });
  it("drops walk-forward violations (frozen at/after resolution)", () => {
    const bad: BacktestComboRecord = { observedAt: "2026-02-02", anchorResolvedAt: "2026-02-01", anchorPays: false, predictedCoverageLower: 0.5, premiumSpent: 10, comboPayoffUsd: 0, legs: [] };
    const r = backtestCombos([bad]);
    expect(r.dropped).toBe(1);
    expect(r.combos).toBe(0);
    expect(r.note).toMatch(/walk-forward violation/i);
  });
  it("scores realized vs predicted coverage + calibration gap on synthetic fails", () => {
    const mk = (anchorPays: boolean, paid: boolean[], predicted: number, payoff: number): BacktestComboRecord => ({
      observedAt: "2026-01-01", anchorResolvedAt: "2026-03-01", anchorPays, predictedCoverageLower: predicted, premiumSpent: 10, comboPayoffUsd: payoff,
      legs: paid.map((p, i) => ({ rank: i, scenario: i === 0 ? "rival_wins" : "injury_absence", paid: p })),
    });
    const r = backtestCombos([
      mk(false, [true, false], 0.6, 40),   // anchor failed, leg0 caught it
      mk(false, [false, false], 0.6, 0),   // anchor failed, nothing paid (over-optimistic)
      mk(true, [false, false], 0.6, 0),    // anchor won, pure premium drag
    ]);
    expect(r.anchorFailCombos).toBe(2);
    expect(r.realizedCoverageWhenFail).toBeCloseTo(0.5, 5);   // 1 of 2 fails covered
    expect(r.predictedCoverageWhenFail).toBeCloseTo(0.6, 5);
    expect(r.coverageCalibrationGap).toBeCloseTo(0.1, 5);     // predicted 0.6 − realized 0.5 (over-optimistic)
    expect(r.avgWinDragUsd).toBeCloseTo(10, 5);               // premium spent, nothing paid back
    expect(r.marginalContributionByRank[0]).toBeCloseTo(0.5, 5); // rank-0 caught 1 of 2 fails
    expect(r.marginalContributionByRank[1]).toBeCloseTo(0, 5);   // rank-1 never the unique catcher
  });
});

describe("learnedOverlapPenalty (Phase 5)", () => {
  it("below the cluster floor → returns the conservative prior unchanged", () => {
    expect(learnedOverlapPenalty({ aPaidClusters: 5, bothPaidClusters: 5 }, 0.2)).toBe(0.2);
  });
  it("above the floor → shrinks the realized co-payment toward the prior", () => {
    const p = learnedOverlapPenalty({ aPaidClusters: 90, bothPaidClusters: 81 }, 0.2, 30); // realized 0.9
    expect(p).toBeGreaterThan(0.2);  // learned high overlap pulls it up from the prior
    expect(p).toBeLessThan(0.9);     // but reliability-shrunk, not all the way
  });
});

describe("jointCalibratedGate (Phase 5)", () => {
  const good: ComboFamilyEvidence = {
    effectiveClusters: 120, realizedCoverageLower: 0.55, bestSingleLegLower: 0.4,
    secondLegMarginalContribution: 0.1, premiumDragFraction: 0.6, walkForwardEce: 0.05, maxSingleClusterShare: 0.3,
  };
  it("no/low evidence → not eligible with reasons (dormant by default)", () => {
    const r = jointCalibratedGate({ ...good, effectiveClusters: 4 });
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/effective clusters/i);
  });
  it("a combo that does not beat the best single leg is rejected", () => {
    const r = jointCalibratedGate({ ...good, realizedCoverageLower: 0.35 });
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/single leg/i);
  });
  it("a single dominating cluster is rejected", () => {
    expect(jointCalibratedGate({ ...good, maxSingleClusterShare: 0.8 }).eligible).toBe(false);
  });
  it("fully-evidenced family passes", () => {
    expect(jointCalibratedGate(good)).toEqual({ eligible: true, reasons: [] });
  });
});
