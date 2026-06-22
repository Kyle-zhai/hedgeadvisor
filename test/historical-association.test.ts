import { describe, expect, test } from "vitest";
import { chronologicalClusterSplit, validateHistoricalAssociationSamples, type HistoricalAssociationSample } from "@/lib/association";

const row = (i: number, clusterKey = `cluster-${i}`): HistoricalAssociationSample => ({
  sampleKey: `sample-${i}`,
  clusterKey,
  anchorMarketId: `a-${i}`,
  candidateMarketId: `c-${i}`,
  anchorPaysYes: i % 2 === 0,
  candidateYes: i % 3 === 0,
  observedAt: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
  resolvedAt: new Date(Date.UTC(2025, 0, 3 + i)).toISOString(),
  anchorProbYes: 0.4,
  candidatePrice: 0.3,
});

describe("historical association evidence gate", () => {
  test("rejects post-resolution and insufficient-lead rows instead of inventing snapshots", () => {
    const late = row(1);
    late.observedAt = new Date(Date.parse(late.resolvedAt) - 60 * 60 * 1000).toISOString();
    const result = validateHistoricalAssociationSamples([row(0), late], 24);
    expect(result.accepted.map((x) => x.sampleKey)).toEqual(["sample-0"]);
    expect(result.rejected[0].reason).toContain("lead");
  });

  test("chronological split never divides an event cluster", () => {
    const rows = [row(0, "a"), row(1, "a"), row(2, "b"), row(3, "c"), row(4, "d")];
    const split = chronologicalClusterSplit(rows, 0.25);
    const trainClusters = new Set(split.train.map((x) => x.clusterKey));
    expect(split.holdout.every((x) => !trainClusters.has(x.clusterKey))).toBe(true);
    expect(Math.max(...split.train.map((x) => Date.parse(x.resolvedAt)))).toBeLessThanOrEqual(Math.min(...split.holdout.map((x) => Date.parse(x.resolvedAt))));
  });
});

