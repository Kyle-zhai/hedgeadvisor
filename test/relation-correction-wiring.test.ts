import { describe, it, expect } from "vitest";
import { loadCorrectionMap, applyCorrection } from "@/lib/association/relationCorrection";

// The committed snapshot is empty while the engine is using Qwen/DashScope. A correction generated from
// another model's eval must not silently nudge Qwen conditionals.
describe("relation correction wiring", () => {
  it("loads an empty map from the committed snapshot", () => {
    const map = loadCorrectionMap();
    expect(map.size).toBe(0);
  });
  it("applyCorrection with the loaded empty map returns the elicitation unchanged", () => {
    const map = loadCorrectionMap();
    const elicited = { pGivenAnchorWins: 0.3, pGivenAnchorFails: 0.7 };
    expect(applyCorrection(elicited, "CAUSAL", map)).toEqual(elicited);
  });
  it("is a no-op for an UNKNOWN mechanism (so only learned buckets are ever adjusted)", () => {
    const map = loadCorrectionMap();
    const elicited = { pGivenAnchorWins: 0.3, pGivenAnchorFails: 0.7 };
    expect(applyCorrection(elicited, "NOT_A_REAL_MECH", map)).toEqual(elicited);
  });
});
