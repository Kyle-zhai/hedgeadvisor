import { describe, it, expect } from "vitest";
import { loadCorrectionMap, applyCorrection } from "@/lib/association/relationCorrection";

// The snapshot is now populated from the 100-row gold eval. These guard the MODELED-only invariants that
// keep the correction safe regardless of its contents.
describe("relation correction wiring", () => {
  it("loads the trained correction snapshot (populated)", () => {
    const map = loadCorrectionMap();
    expect(map.size).toBeGreaterThan(0);
    expect(map.has("CAUSAL")).toBe(true); // keys are uppercased mechanismTypes
  });
  it("nudges a known mechanism toward gold and stays in [0,1]", () => {
    const map = loadCorrectionMap();
    const out = applyCorrection({ pGivenAnchorWins: 0.3, pGivenAnchorFails: 0.3 }, "CAUSAL", map);
    expect(out.pGivenAnchorFails).not.toBe(0.3); // a correction exists for CAUSAL
    expect(out.pGivenAnchorFails).toBeGreaterThanOrEqual(0);
    expect(out.pGivenAnchorFails).toBeLessThanOrEqual(1);
  });
  it("is a no-op for an UNKNOWN mechanism (so only learned buckets are ever adjusted)", () => {
    const map = loadCorrectionMap();
    const elicited = { pGivenAnchorWins: 0.3, pGivenAnchorFails: 0.7 };
    expect(applyCorrection(elicited, "NOT_A_REAL_MECH", map)).toEqual(elicited);
  });
  it("applies a reliability-shrunk bias: the move equals shrink * n/(n+8) * bias", () => {
    const map = loadCorrectionMap();
    const c = map.get("CAUSAL")!;
    const reliability = c.n / (c.n + 8);
    const out = applyCorrection({ pGivenAnchorWins: 0.3, pGivenAnchorFails: 0.3 }, "CAUSAL", map, 0.5);
    expect(out.pGivenAnchorFails).toBeCloseTo(0.3 + 0.5 * reliability * c.biasFail, 6);
    expect(out.pGivenAnchorWins).toBeCloseTo(0.3 + 0.5 * reliability * c.biasWin, 6);
  });
  it("loads sdFail/sdWin when present, and tolerates their absence in older snapshots", () => {
    const map = loadCorrectionMap();
    for (const c of map.values()) {
      if (c.sdFail !== undefined) expect(c.sdFail).toBeGreaterThanOrEqual(0);
      if (c.sdWin !== undefined) expect(c.sdWin).toBeGreaterThanOrEqual(0);
    }
  });
});
