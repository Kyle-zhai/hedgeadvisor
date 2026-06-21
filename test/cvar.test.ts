/**
 * Joint-scenario CVaR multi-leg optimizer. Unlike the maximin (worst-case, probability-free),
 * this minimizes the de-vigged-probability-weighted worst-α tail, subject to the same win-floor
 * budget. Cover-all leg ⇒ deep CVaR reduction; no leg / no budget ⇒ no change.
 */
import { describe, expect, test } from "vitest";
import { solveCvar, type MaximinLeg } from "@/lib/hedge";

// $20 on Spain at 25¢ → 80 shares, payout $80, G = $60. 3 states; Spain likely-ish.
const base = {
  states: ["Spain", "France", "Brazil"],
  stateProbs: [0.25, 0.45, 0.3],
  primaryWinIdx: [0],
  stakeUsd: 20,
  primaryPrice: 0.25,
};
const coverAll: MaximinLeg = { id: "bno", label: "Spain NO", price: 0.75, paysIn: new Set([1, 2]), provenance: "ANALYTIC" };

describe("solveCvar", () => {
  test("cover-all leg reduces CVaR and respects the win-floor budget", () => {
    const r = solveCvar({ ...base, legs: [coverAll], keepFraction: 0.5, alpha: 0.2 });
    expect(r.budgetUsd).toBeCloseTo(30, 1); // (1−0.5)·G
    expect(r.spendUsd).toBeGreaterThan(0);
    expect(r.spendUsd).toBeLessThanOrEqual(30 + 1e-6);
    expect(r.cvarAfterUsd).toBeLessThan(r.cvarBeforeUsd); // tail risk reduced
    expect(r.cvarReductionPct).toBeGreaterThan(0);
  });

  test("no budget (k=1, keep all winnings) ⇒ no spend, CVaR unchanged", () => {
    const r = solveCvar({ ...base, legs: [coverAll], keepFraction: 1, alpha: 0.2 });
    expect(r.spendUsd).toBe(0);
    expect(r.cvarAfterUsd).toBeCloseTo(r.cvarBeforeUsd, 6);
  });

  test("no covering leg ⇒ never spends to worsen the tail", () => {
    const useless: MaximinLeg = { id: "x", label: "pays in win only", price: 0.5, paysIn: new Set([0]), provenance: "ANALYTIC" };
    const r = solveCvar({ ...base, legs: [useless], keepFraction: 0.5, alpha: 0.2 });
    expect(r.spendUsd).toBe(0);
  });

  test("CVaR magnitudes are non-negative and the before-tail equals the un-hedged stake loss tail", () => {
    const r = solveCvar({ ...base, legs: [coverAll], keepFraction: 0.5, alpha: 0.1 });
    // worst 10% tail of the un-hedged position is a $20 loss (Spain fails) → CVaR ≈ 20
    expect(r.cvarBeforeUsd).toBeCloseTo(20, 1);
    expect(r.cvarAfterUsd).toBeGreaterThanOrEqual(0);
  });
});
