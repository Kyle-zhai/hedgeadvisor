// test/relation-eval-scoring.test.ts
import { describe, it, expect } from "vitest";
import { signOf, scoreRelation, aggregateScores, type PredictedRelation } from "@/lib/association/relationEval";
import type { GoldRelation } from "@/lib/association/relationGold";

const gold: GoldRelation = {
  id: "t", domain: "sports", relationType: "same-entity-causal",
  anchor: { title: "A", eventClass: "x" }, candidate: { title: "B", eventClass: "y" },
  label: { relation: "CAUSAL", direction: "NEGATIVE", mechanismType: "CAUSAL", scope: "ENTITY_SPECIFIC",
    pGivenAnchorWins: 0.05, pGivenAnchorFails: 0.25, strengthBand: "moderate", counterexamples: [], confidence: 0.7 },
  basis: "causal", labeledBy: "opus-4.8", rationale: "",
};

describe("relationEval scoring", () => {
  it("signOf classifies by conditional gap", () => {
    expect(signOf(0.1, 0.4)).toBe("NEGATIVE"); // pays more on fail
    expect(signOf(0.4, 0.1)).toBe("POSITIVE");
    expect(signOf(0.2, 0.21)).toBe("AMBIGUOUS"); // within epsilon
  });
  it("scores a correct-sign prediction", () => {
    const pred: PredictedRelation = { relation: "CAUSAL", direction: "NEGATIVE", mechanismType: "CAUSAL", pGivenAnchorWins: 0.08, pGivenAnchorFails: 0.22 };
    const s = scoreRelation(gold, pred);
    expect(s.signCorrect).toBe(true);
    expect(s.mechanismMatch).toBe(true);
    expect(s.condAbsErrFail).toBeCloseTo(0.03, 5);
  });
  it("aggregates accuracy", () => {
    const a = aggregateScores([
      { relationType: "x", signCorrect: true, mechanismMatch: true, relationMatch: true, condAbsErrFail: 0.1, condAbsErrWin: 0.1, judged: true },
      { relationType: "x", signCorrect: false, mechanismMatch: false, relationMatch: false, condAbsErrFail: 0.2, condAbsErrWin: 0.2, judged: true },
    ]);
    expect(a.overall.signAccuracy).toBeCloseTo(0.5, 5);
    expect(a.overall.condMAE).toBeCloseTo(0.15, 5);
  });
});
