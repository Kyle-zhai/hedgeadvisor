import { describe, expect, test } from "vitest";
import { optimizeRobustHedge, calibrateConditionalPayoff } from "@/lib/association";
import type { OptimizerCandidate } from "@/lib/association";

/**
 * §19 ③ — the REFERENCE_CLASS wall. External base-rate priors live in their OWN field (referencePrior),
 * can never render as CALIBRATED, rank between CALIBRATED and MODELED, count as SOFT legs, and are
 * withheld at the near-strict posture. The 20-per-branch settlement gate is untouched by construction:
 * referencePrior never enters ConditionalCounts.
 */

const base = { stakeUsd: 20, primaryPrice: 0.25, keepFraction: 0.5 };

const refLeg = (over: Partial<OptimizerCandidate> = {}): OptimizerCandidate => ({
  id: "ref-1", label: "external-prior leg", venue: "polymarket", side: "yes", price: 0.3, marginal: 0.28,
  provenance: "REFERENCE_CLASS",
  referencePrior: { payGivenFail: 0.6, payGivenWin: 0.1, pseudoSamples: 40, source: "test reference class" },
  ...over,
});

describe("REFERENCE_CLASS wall", () => {
  test("admitted below the near-strict posture with a bounded ranking penalty", () => {
    const r = optimizeRobustHedge({ ...base, conservatism: 0.5, candidates: [refLeg()] });
    expect(r.status).toBe("RECOMMEND");
    expect(r.allocations).toHaveLength(1);
    expect(r.allocations[0].provenance).toBe("REFERENCE_CLASS");
    // shading only ever LOWERS the effective conditional below the stated prior
    expect(r.allocations[0].effectivePayGivenFail).toBeLessThanOrEqual(0.6);
  });

  test("withheld at the near-strict posture (external evidence is not settlement-proven)", () => {
    const r = optimizeRobustHedge({ ...base, conservatism: 0.92, candidates: [refLeg()] });
    expect(r.allocations).toHaveLength(0);
    expect(r.rejected.some((x) => x.reason.includes("reference-class"))).toBe(true);
  });

  test("THE WALL: a CALIBRATED candidate carrying any external contribution is rejected outright", () => {
    // a genuinely sufficient settlement calibration…
    const cal = calibrateConditionalPayoff({
      anchorPayCandidatePay: 5, anchorPayCandidateNoPay: 25,
      anchorNoPayCandidatePay: 22, anchorNoPayCandidateNoPay: 8,
    });
    expect(cal.sufficientEvidence).toBe(true);
    // …must still NEVER size as CALIBRATED once an external prior touches the candidate.
    const tainted: OptimizerCandidate = {
      id: "tainted", label: "calibrated + external", venue: "polymarket", side: "yes", price: 0.3,
      provenance: "CALIBRATED", calibration: cal,
      referencePrior: { payGivenFail: 0.9, payGivenWin: 0.05, pseudoSamples: 999, source: "external" },
    };
    const r = optimizeRobustHedge({ ...base, conservatism: 0.5, candidates: [tainted] });
    expect(r.allocations).toHaveLength(0);
    expect(r.rejected.some((x) => x.reason.includes("can never be CALIBRATED"))).toBe(true);
  });

  test("REFERENCE_CLASS counts as a SOFT leg (shares the per-cell cap)", () => {
    // Cap the first leg's spend so budget/loss remain and the SECOND leg genuinely reaches the soft-cap gate.
    const second = refLeg({ id: "ref-2", label: "second external leg", price: 0.4, marginal: 0.38, referencePrior: { payGivenFail: 0.5, payGivenWin: 0.1, pseudoSamples: 40, source: "test" } });
    const r = optimizeRobustHedge({ ...base, conservatism: 0.5, candidates: [refLeg({ maxSpendUsd: 2 }), second] });
    expect(r.allocations.length).toBe(1); // only the single best soft leg
    expect(r.rejected.some((x) => x.reason.includes("single best soft leg"))).toBe(true);
  });

  test("thin external evidence shades harder than thick (pseudoSamples drives conservatism)", () => {
    const thin = optimizeRobustHedge({ ...base, conservatism: 0.6, candidates: [refLeg({ referencePrior: { payGivenFail: 0.6, payGivenWin: 0.1, pseudoSamples: 5, source: "t" } })] });
    const thick = optimizeRobustHedge({ ...base, conservatism: 0.6, candidates: [refLeg({ referencePrior: { payGivenFail: 0.6, payGivenWin: 0.1, pseudoSamples: 400, source: "t" } })] });
    expect(thin.allocations[0].effectivePayGivenFail).toBeLessThan(thick.allocations[0].effectivePayGivenFail);
  });
});
