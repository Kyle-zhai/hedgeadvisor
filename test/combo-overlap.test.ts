import { describe, it, expect } from "vitest";
import { overlapPenalty, conservativeCoverage, marginalCoverageGain, type OverlapLeg } from "@/lib/relate/comboOverlap";

const leg = (o: Partial<OverlapLeg> & { marketId: string; scenario: OverlapLeg["scenario"] }): OverlapLeg => ({
  marketTitle: o.marketId, pGivenFails: 0.4, scope: "cross-event", ...o,
});

describe("overlapPenalty", () => {
  it("same market = full overlap", () => {
    expect(overlapPenalty(leg({ marketId: "m1", scenario: "rival_wins" }), leg({ marketId: "m1", scenario: "rival_wins" }))).toBe(1.0);
  });
  it("same market title, different id = near-duplicate", () => {
    expect(overlapPenalty(leg({ marketId: "m1", marketTitle: "WC winner", scenario: "rival_wins" }), leg({ marketId: "m2", marketTitle: "WC winner", scenario: "rival_wins" }))).toBe(0.9);
  });
  it("same scenario (real path) = high overlap; different scenarios = low", () => {
    const same = overlapPenalty(leg({ marketId: "a", scenario: "injury_absence" }), leg({ marketId: "b", scenario: "injury_absence" }));
    const diff = overlapPenalty(leg({ marketId: "a", scenario: "injury_absence" }), leg({ marketId: "b", scenario: "rival_wins" }));
    expect(same).toBeGreaterThan(diff);
    expect(same).toBe(0.7);
    expect(diff).toBe(0.2);
  });
  it("two same-event collateral facets co-move more than cross-event different scenarios", () => {
    const sameEvent = overlapPenalty(leg({ marketId: "a", scenario: "performance_collapse", scope: "same-event" }), leg({ marketId: "b", scenario: "behavioral_reaction", scope: "same-event" }));
    expect(sameEvent).toBe(0.35);
  });
});

describe("conservativeCoverage + marginalCoverageGain", () => {
  it("diverse scenarios cover more than the same scenario repeated", () => {
    const diverse = conservativeCoverage([leg({ marketId: "a", scenario: "rival_wins" }), leg({ marketId: "b", scenario: "injury_absence" })]);
    const dup = conservativeCoverage([leg({ marketId: "a", scenario: "rival_wins" }), leg({ marketId: "b", scenario: "rival_wins" })]);
    expect(diverse).toBeGreaterThan(dup);
  });
  it("a redundant same-market leg adds ~0 marginal coverage", () => {
    const selected = [leg({ marketId: "a", marketTitle: "X", scenario: "rival_wins" })];
    const dupGain = marginalCoverageGain(leg({ marketId: "a", marketTitle: "X", scenario: "rival_wins" }), selected);
    const freshGain = marginalCoverageGain(leg({ marketId: "b", marketTitle: "Y", scenario: "injury_absence" }), selected);
    expect(dupGain).toBeCloseTo(0, 5);
    expect(freshGain).toBeGreaterThan(0.1);
  });
  it("coverage never exceeds 1 and is monotone in legs", () => {
    const legs = [leg({ marketId: "a", scenario: "rival_wins" }), leg({ marketId: "b", scenario: "injury_absence" }), leg({ marketId: "c", scenario: "macro_regime" })];
    expect(conservativeCoverage(legs)).toBeLessThanOrEqual(1);
    expect(conservativeCoverage(legs)).toBeGreaterThanOrEqual(conservativeCoverage(legs.slice(0, 2)));
  });
});
