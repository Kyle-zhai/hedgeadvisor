import { describe, it, expect } from "vitest";
import { loadCorrectionMap, applyCorrection } from "@/lib/association/relationCorrection";

// Guards the Task-8 wiring invariant: the committed correction snapshot is EMPTY, so the correction
// applied in discover.ts is a pure no-op in production until the live gold eval populates it.
describe("relation correction wiring — default no-op", () => {
  it("loads an empty map from the committed snapshot", () => {
    expect(loadCorrectionMap().size).toBe(0);
  });
  it("applyCorrection with the loaded (empty) map returns the elicitation unchanged", () => {
    const map = loadCorrectionMap();
    const elicited = { pGivenAnchorWins: 0.3, pGivenAnchorFails: 0.7 };
    expect(applyCorrection(elicited, "CAUSAL", map)).toEqual(elicited);
  });
});
