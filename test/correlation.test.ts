import { describe, expect, test } from "vitest";
import {
  devig,
  overround,
  devigPower,
  devigShin,
  devigDetailed,
  exclusiveCorr,
  subsetCorr,
} from "@/lib/correlation";

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe("de-vig", () => {
  test("proportional normalizes to a probability distribution summing to 1", () => {
    const q = devig([0.16, 0.15, 0.1, 0.7]);
    expect(sum(q)).toBeCloseTo(1, 9);
  });
  test("reports the overround", () => {
    expect(overround([0.6, 0.5])).toBeCloseTo(0.1, 9);
  });

  // a vigged 3-way book (Σ = 1.04, 4% overround)
  const prices = [0.55, 0.3, 0.19];

  test("power method: q sums to 1, every q ≤ its price (de-vig removes vig)", () => {
    const { q, k } = devigPower(prices);
    expect(sum(q)).toBeCloseTo(1, 6);
    q.forEach((qi, i) => expect(qi).toBeLessThanOrEqual(prices[i] + 1e-9));
    expect(k).toBeGreaterThan(1); // overround>0 ⇒ exponent>1
  });

  test("Shin method: q sums to 1, recovers an insider fraction z in (0, 0.5)", () => {
    const { q, z } = devigShin(prices);
    expect(sum(q)).toBeCloseTo(1, 6);
    q.forEach((qi) => {
      expect(qi).toBeGreaterThan(0);
      expect(qi).toBeLessThan(1);
    });
    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThan(0.5);
  });

  test("Shin applies a favourite–longshot correction vs proportional (favourite gets MORE)", () => {
    const prop = devig(prices);
    const { q: shin } = devigShin(prices);
    // Shin lifts the favourite and trims the longshot relative to naive normalization.
    expect(shin[0]).toBeGreaterThan(prop[0]); // favourite
    expect(shin[2]).toBeLessThan(prop[2]); // longshot
  });

  test("devigDetailed picks Shin on a normal vigged book and reports the param", () => {
    const d = devigDetailed(prices);
    expect(d.method).toBe("shin");
    expect(d.param).toBeGreaterThan(0);
    expect(sum(d.q)).toBeCloseTo(1, 6);
    expect(d.overround).toBeCloseTo(0.04, 6);
  });

  test("devigDetailed falls back to proportional on a no-vig / degenerate book", () => {
    const d = devigDetailed([0.5, 0.5]); // Σ = 1, no overround
    expect(d.method).toBe("proportional");
    expect(sum(d.q)).toBeCloseTo(1, 9);
  });
});

describe("structural correlations (derived, not fitted)", () => {
  test("mutually exclusive favorites: Spain vs France ≈ -0.191", () => {
    expect(exclusiveCorr(0.1525, 0.1685)).toBeCloseTo(-0.191, 2);
  });
  test("superset basket: Spain vs European bloc ≈ +0.332", () => {
    expect(subsetCorr(0.1525, 0.62)).toBeCloseTo(0.332, 2);
  });
});
