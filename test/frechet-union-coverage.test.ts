import { describe, expect, test } from "vitest";
import { frechetUnionCoverage } from "@/lib/relate/discover";

// Fix #6: the multi-leg combo "at least one leg pays | fail" coverage must be the assumption-free
// Fréchet–Hoeffding LOWER bound on the union (P(∪) ≥ max_g p_g), NEVER the independence union
// 1−Π(1−p_g) which silently imports an implicit ρ=0 and double-counts overlapping fail-coverage.
describe("frechetUnionCoverage (Fréchet-low, never copula ρ)", () => {
  test("empty set ⇒ 0", () => {
    expect(frechetUnionCoverage([])).toBe(0);
  });

  test("single group ⇒ its own probability (the bound is exact)", () => {
    expect(frechetUnionCoverage([0.42])).toBeCloseTo(0.42, 12);
  });

  test("reports the Fréchet lower bound = max, NOT the independence union", () => {
    const ps = [0.3, 0.4, 0.5];
    const frechetLow = frechetUnionCoverage(ps);
    const independence = 1 - ps.reduce((p, x) => p * (1 - x), 1); // the old, ρ=0 formula
    expect(frechetLow).toBeCloseTo(0.5, 12); // = max_g p_g
    expect(independence).toBeCloseTo(0.79, 12);
    // The honest bound is strictly LOWER: correlated legs are not double-counted into an inflated %.
    expect(frechetLow).toBeLessThan(independence);
  });

  test("never exceeds the independence union for any inputs (only ever lowers it)", () => {
    const cases = [[0.1, 0.9], [0.5, 0.5, 0.5], [0.01, 0.02, 0.97], [0.33]];
    for (const ps of cases) {
      const frechetLow = frechetUnionCoverage(ps);
      const independence = 1 - ps.reduce((p, x) => p * (1 - x), 1);
      expect(frechetLow).toBeLessThanOrEqual(independence + 1e-12);
    }
  });

  test("stays within [0,1] and clamps degenerate inputs", () => {
    expect(frechetUnionCoverage([1, 1, 1])).toBe(1);
    expect(frechetUnionCoverage([0, 0])).toBe(0);
  });
});
