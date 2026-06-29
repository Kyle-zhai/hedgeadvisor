import { describe, it, expect } from "vitest";
import { buildCorrectionFromGold, applyCorrection, type ScoredExample } from "@/lib/association/relationCorrection";

const ex = (mech: string, predFail: number, goldFail: number): ScoredExample => ({ mechanismType: mech, predFail, goldFail, predWin: 0.1, goldWin: 0.1 });

describe("relation correction (MODELED-only)", () => {
  it("learns a per-mechanism fail-branch bias above the min-sample floor", () => {
    const c = buildCorrectionFromGold([ex("CAUSAL",0.1,0.3), ex("CAUSAL",0.15,0.3), ex("CAUSAL",0.2,0.4), ex("CAUSAL",0.1,0.25)], 4);
    expect(c.get("CAUSAL")?.biasFail).toBeGreaterThan(0); // gold fail-branch > model => positive (gold - pred) bias nudges fail upward
  });
  it("records the residual sample std (sdFail/sdWin) per mechanism", () => {
    const c = buildCorrectionFromGold([ex("CAUSAL",0.1,0.3), ex("CAUSAL",0.15,0.3), ex("CAUSAL",0.2,0.4), ex("CAUSAL",0.1,0.25)], 4);
    const got = c.get("CAUSAL")!;
    // residuals (gold-pred) fail-branch = [0.2, 0.15, 0.2, 0.15]; sample sd (n-1) of that set.
    const res = [0.2, 0.15, 0.2, 0.15];
    const mean = res.reduce((s, x) => s + x, 0) / res.length;
    const sd = Math.sqrt(res.reduce((s, x) => s + (x - mean) ** 2, 0) / (res.length - 1));
    expect(got.sdFail).toBeCloseTo(sd, 6);
    expect(got.sdWin).toBeCloseTo(0, 6); // win residuals all identical (0.0) => sd 0
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
  it("reliability-shrinks the applied bias by n/(n+8) so thin buckets move less", () => {
    const rows = [ex("CAUSAL",0.1,0.3), ex("CAUSAL",0.15,0.3), ex("CAUSAL",0.2,0.4), ex("CAUSAL",0.1,0.25)];
    const c = buildCorrectionFromGold(rows, 4);
    const bias = c.get("CAUSAL")!.biasFail; // mean(gold-pred) on the fail branch
    const n = rows.length;
    const reliability = n / (n + 8);
    const adj = applyCorrection({ pGivenAnchorWins: 0.1, pGivenAnchorFails: 0.1 }, "CAUSAL", c, 0.5);
    // applied delta = shrink(0.5) * reliability * bias — strictly less than the un-shrunk 0.5*bias.
    expect(adj.pGivenAnchorFails).toBeCloseTo(0.1 + 0.5 * reliability * bias, 6);
    expect(adj.pGivenAnchorFails).toBeLessThan(0.1 + 0.5 * bias);
  });
});
