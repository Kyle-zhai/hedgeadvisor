import { describe, expect, test } from "vitest";
import { walkForwardAssociationBacktest, type AssociationBacktestRow } from "@/lib/association";

function row(i: number, overrides: Partial<AssociationBacktestRow> = {}): AssociationBacktestRow {
  const resolved = new Date(Date.UTC(2020, 0, 1 + i));
  const anchorPays = i % 2 === 0;
  return {
    relationKey: "a->b:mechanism->cross_domain:m=causal.cross_domain.anchor_before_candidate.event_class->no@v4",
    sampleKey: `sample-${i}`,
    clusterKey: `cluster-${i}`,
    anchorPays,
    candidatePays: !anchorPays,
    resolvedAt: resolved.toISOString(),
    observedAt: new Date(resolved.getTime() - 48 * 60 * 60 * 1000).toISOString(),
    candidatePrice: 0.3,
    ...overrides,
  };
}

describe("association walk-forward backtest", () => {
  test("learns only from earlier independent clusters and reports hedge economics", () => {
    const result = walkForwardAssociationBacktest(Array.from({ length: 60 }, (_, i) => row(i)), {
      minSamplesPerBranch: 20,
      credibleLevel: 0.95,
    });
    expect(result.leakageViolations).toBe(0);
    expect(result.evaluated).toBe(59);
    expect(result.actionable).toBeGreaterThan(0);
    expect(result.brier).not.toBeNull();
    expect(result.brier!).toBeLessThan(0.04);
    expect(result.averageFailLossReduction).toBeCloseTo(0.7, 8);
    expect(result.averageWinHedgeDrag).toBeCloseTo(0.3, 8);
    expect(result.forecasts.every((forecast) => forecast.trainClusters === forecast.trainRows)).toBe(true);
  });

  test("a future settlement cannot alter an earlier forecast", () => {
    const base = Array.from({ length: 50 }, (_, i) => row(i));
    const before = walkForwardAssociationBacktest(base, { minSamplesPerBranch: 4 });
    const after = walkForwardAssociationBacktest([
      ...base,
      row(100, { sampleKey: "future", clusterKey: "future", candidatePays: false }),
    ], { minSamplesPerBranch: 4 });
    const prior = before.forecasts.find((forecast) => forecast.sampleKey === "sample-49");
    const unchanged = after.forecasts.find((forecast) => forecast.sampleKey === "sample-49");
    expect(unchanged).toEqual(prior);
  });

  test("rejects snapshots recorded after resolution", () => {
    const invalid = row(2, { observedAt: row(2).resolvedAt });
    const result = walkForwardAssociationBacktest([row(0), row(1), invalid], { minSamplesPerBranch: 2 });
    expect(result.rows).toBe(2);
    expect(result.forecasts.some((forecast) => forecast.sampleKey === invalid.sampleKey)).toBe(false);
  });
});
