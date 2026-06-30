import { describe, it, expect } from "vitest";
import { legPaid, comboPayoffUsd, toBacktestRecord } from "@/lib/relate/comboSnapshot";

describe("comboSnapshot pure core (Block C)", () => {
  it("legPaid: YES pays when settled YES, NO pays when settled NO", () => {
    expect(legPaid("YES", true)).toBe(true);
    expect(legPaid("YES", false)).toBe(false);
    expect(legPaid("NO", false)).toBe(true);
    expect(legPaid("NO", true)).toBe(false);
  });

  it("comboPayoffUsd: only paid legs pay out costUsd/legPrice", () => {
    // $4 at 0.40 ⇒ 10 shares ⇒ $10 if paid; $3 at 0.50 ⇒ unpaid ⇒ $0
    expect(comboPayoffUsd([
      { paid: true, costUsd: 4, legPrice: 0.4 },
      { paid: false, costUsd: 3, legPrice: 0.5 },
    ])).toBeCloseTo(10, 6);
    expect(comboPayoffUsd([{ paid: false, costUsd: 5, legPrice: 0.25 }])).toBe(0);
    expect(comboPayoffUsd([])).toBe(0);
  });

  it("toBacktestRecord: returns a record only when fully settled", () => {
    const snap = {
      comboId: "c1", observedAt: "2026-02-01T00:00:00Z", anchorResolvedAt: "2026-03-01T00:00:00Z",
      anchorPays: false, predictedCoverageLower: 0.7, premiumUsd: 7, comboPayoffUsd: 10, clusterKey: "k",
    };
    const legs = [
      { rank: 0, scenarioBucket: "rival_wins", paid: true },
      { rank: 1, scenarioBucket: "performance_collapse", paid: false },
    ];
    const rec = toBacktestRecord(snap, legs);
    expect(rec).not.toBeNull();
    expect(rec!.anchorPays).toBe(false);
    expect(rec!.premiumSpent).toBe(7);
    expect(rec!.comboPayoffUsd).toBe(10);
    expect(rec!.legs).toEqual([
      { rank: 0, scenario: "rival_wins", paid: true },
      { rank: 1, scenario: "performance_collapse", paid: false },
    ]);
  });

  it("toBacktestRecord: null when anchor or any leg is unsettled", () => {
    const base = {
      comboId: "c1", observedAt: "2026-02-01T00:00:00Z", anchorResolvedAt: "2026-03-01T00:00:00Z",
      anchorPays: false, predictedCoverageLower: 0.7, premiumUsd: 7, comboPayoffUsd: 10, clusterKey: "k",
    };
    expect(toBacktestRecord({ ...base, anchorPays: null }, [{ rank: 0, scenarioBucket: "rival_wins", paid: true }])).toBeNull();
    expect(toBacktestRecord(base, [{ rank: 0, scenarioBucket: "rival_wins", paid: null }])).toBeNull();
  });
});
