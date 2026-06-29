import { describe, it, expect } from "vitest";
import { buildCorrectionFromGold, applyCorrection, type ScoredExample } from "@/lib/association/relationCorrection";

const ex = (mech: string, predFail: number, goldFail: number): ScoredExample => ({ mechanismType: mech, predFail, goldFail, predWin: 0.1, goldWin: 0.1 });

describe("relation correction (MODELED-only)", () => {
  it("learns a per-mechanism fail-branch bias above the min-sample floor", () => {
    const c = buildCorrectionFromGold([ex("CAUSAL",0.1,0.3), ex("CAUSAL",0.15,0.3), ex("CAUSAL",0.2,0.4), ex("CAUSAL",0.1,0.25)], 4);
    expect(c.get("CAUSAL")?.biasFail).toBeGreaterThan(0); // gold fail-branch > model => positive (gold - pred) bias nudges fail upward
  });
  it("no correction below the min-sample floor", () => {
    const c = buildCorrectionFromGold([ex("ECONOMIC",0.1,0.3)], 4);
    expect(c.has("ECONOMIC")).toBe(false);
  });
  it("applyCorrection nudges toward gold and stays in [0,1], no-op for unknown bucket", () => {
    const c = buildCorrectionFromGold([ex("CAUSAL",0.1,0.3), ex("CAUSAL",0.15,0.3), ex("CAUSAL",0.2,0.4), ex("CAUSAL",0.1,0.25)], 4);
    const adj = applyCorrection({ pGivenAnchorWins: 0.1, pGivenAnchorFails: 0.1 }, "CAUSAL", c);
    expect(adj.pGivenAnchorFails).toBeGreaterThan(0.1);
    expect(adj.pGivenAnchorFails).toBeLessThanOrEqual(1);
    expect(applyCorrection({ pGivenAnchorWins: 0.1, pGivenAnchorFails: 0.1 }, "OTHER", c)).toEqual({ pGivenAnchorWins: 0.1, pGivenAnchorFails: 0.1 });
  });
});
