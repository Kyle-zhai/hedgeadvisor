import { describe, expect, test } from "vitest";
import { solveMaximin, protectFrontier, amplifyLeverage, amplifyCurve, type MaximinLeg } from "@/lib/hedge";
import { lossIfPrimaryFails, costOfProtection } from "@/lib/netcost";
import type { PnLPoint } from "@/lib/types";

// Primary: $20 on Spain at 25¢ → 80 shares, pays $80 if Spain wins. G = $60.
const base = {
  states: ["Spain", "France", "Brazil"],
  primaryWinIdx: [0],
  stakeUsd: 20,
  primaryPrice: 0.25,
};
const bno = (price = 0.75): MaximinLeg => ({ id: "bno", label: "Spain NOT win", price, paysIn: new Set([1, 2]), provenance: "ANALYTIC" });

describe("maximin win-floor solver", () => {
  test("cover-all leg (B-NO): spends the full budget, lifts the floor, keeps k·G if B wins", () => {
    const r = solveMaximin({ ...base, legs: [bno(0.75)], keepFraction: 0.5 });
    expect(r.profitUsd).toBeCloseTo(60, 6);
    expect(r.budgetUsd).toBeCloseTo(30, 6); // (1−0.5)·60
    expect(r.spendUsd).toBeCloseTo(30, 1); // full budget on B-NO
    // shares 30/0.75=40; fail PnL = 40 − (20+30) = −10
    expect(r.lossIfPrimaryFailsUsd).toBeCloseTo(10, 1);
    // win-floor binds exactly at k·G = 30
    expect(r.keepIfWinUsd).toBeCloseTo(30, 1);
    expect(r.costOfProtectionUsd).toBeCloseTo(30, 1);
    expect(r.verdict).toBe("REDUCES");
  });

  test("k=0 (break-even posture) spends all winnings and minimizes loss-if-wrong", () => {
    const r = solveMaximin({ ...base, legs: [bno(0.75)], keepFraction: 0 });
    expect(r.budgetUsd).toBeCloseTo(60, 6);
    expect(r.keepIfWinUsd).toBeCloseTo(0, 1); // break-even if right
    // shares 60/0.75=80; fail PnL = 80 − (20+60) = 0 → loss ≈ 0 (no vig in this synthetic price)
    expect(r.lossIfPrimaryFailsUsd).toBeLessThan(1);
  });

  test("k=1 (no hedge) spends nothing; keeps all winnings, loses the stake if wrong", () => {
    const r = solveMaximin({ ...base, legs: [bno(0.75)], keepFraction: 1 });
    expect(r.budgetUsd).toBeCloseTo(0, 6);
    expect(r.spendUsd).toBeCloseTo(0, 6);
    expect(r.keepIfWinUsd).toBeCloseTo(60, 1);
    expect(r.lossIfPrimaryFailsUsd).toBeCloseTo(20, 1); // lose the stake
    expect(r.verdict).toBe("NO_CHANGE");
  });

  test("per-outcome legs: water-fill equalizes the covered fail states (min-variance)", () => {
    const legs: MaximinLeg[] = [
      { id: "fr", label: "France win", price: 0.4, paysIn: new Set([1]), provenance: "ANALYTIC" },
      { id: "br", label: "Brazil win", price: 0.35, paysIn: new Set([2]), provenance: "ANALYTIC" },
    ];
    const r = solveMaximin({ ...base, legs, keepFraction: 0.5 });
    const fr = r.perState[1].pnl;
    const br = r.perState[2].pnl;
    expect(Math.abs(fr - br)).toBeLessThan(0.6); // equalized
    expect(r.lossIfPrimaryFailsUsd).toBeCloseTo(10, 0); // ≈ −10 like the cover-all case
    expect(r.spendUsd).toBeCloseTo(30, 0);
  });

  test("an uncovered fail state ⇒ spend $0 (never waste money making the worst worse)", () => {
    const legs: MaximinLeg[] = [{ id: "fr", label: "France win", price: 0.4, paysIn: new Set([1]) }];
    const r = solveMaximin({ ...base, legs, keepFraction: 0.5 });
    expect(r.spendUsd).toBe(0);
    expect(r.uncovered).toContain("Brazil");
    expect(r.lossIfPrimaryFailsUsd).toBeCloseTo(20, 6); // still just the stake
    expect(r.verdict).toBe("NO_CHANGE");
    expect(r.keepIfWinUsd).toBeCloseTo(60, 6); // nothing spent ⇒ full winnings kept
  });

  test("budget = (1−k)·G scales with the odds: favorites have tiny protection capacity", () => {
    const longshot = solveMaximin({ ...base, legs: [bno(0.75)], keepFraction: 0.5 });
    const favorite = solveMaximin({ states: base.states, primaryWinIdx: [0], stakeUsd: 20, primaryPrice: 0.8, legs: [{ id: "bno", label: "NOT win", price: 0.22, paysIn: new Set([1, 2]) }], keepFraction: 0.5 });
    expect(longshot.budgetUsd).toBeCloseTo(30, 1); // G=60 → 30
    expect(favorite.budgetUsd).toBeCloseTo(2.5, 1); // G=5 → 2.5
  });

  test("protectFrontier walks from no-hedge (k=1) to break-even (k=0), monotone", () => {
    const f = protectFrontier({ ...base, legs: [bno(0.75)] }, 6);
    expect(f[0].keepIfWinUsd).toBeCloseTo(60, 0); // first point ≈ no hedge
    expect(f[f.length - 1].keepIfWinUsd).toBeLessThan(5); // last point ≈ break-even
    // loss-if-fails shrinks monotonically as we move toward protect
    for (let i = 1; i < f.length; i++) expect(f[i].lossIfPrimaryFailsUsd).toBeLessThanOrEqual(f[i - 1].lossIfPrimaryFailsUsd + 0.5);
  });
});

describe("amplify (slider right half = leverage on B)", () => {
  // $20 on Spain at 25¢ → G = $60.
  test("a=0 is the no-leverage bet; a=1 doubles both the win and the loss", () => {
    const z = amplifyLeverage(20, 0.25, 0);
    expect(z.keepIfWinUsd).toBeCloseTo(60, 6);
    expect(z.lossIfFailUsd).toBeCloseTo(20, 6);
    const d = amplifyLeverage(20, 0.25, 1);
    expect(d.keepIfWinUsd).toBeCloseTo(120, 6); // (1+1)·G
    expect(d.lossIfFailUsd).toBeCloseTo(40, 6); // (1+1)·stake
  });
  test("amplifyCurve is monotone increasing in both win and loss", () => {
    const c = amplifyCurve(20, 0.25, 11);
    for (let i = 1; i < c.length; i++) {
      expect(c[i].keepIfWinUsd).toBeGreaterThan(c[i - 1].keepIfWinUsd);
      expect(c[i].lossIfFailUsd).toBeGreaterThan(c[i - 1].lossIfFailUsd);
    }
  });
});

describe("benefit metrics on a PnL distribution", () => {
  const dist: PnLPoint[] = [
    { outcome: "Spain", pnl: 30, prob: 0.25 },
    { outcome: "France", pnl: -11, prob: 0.4 },
    { outcome: "Brazil", pnl: -8, prob: 0.35 },
  ];
  test("lossIfPrimaryFails is the worst loss over the non-win states", () => {
    expect(lossIfPrimaryFails(dist, new Set([0]))).toBeCloseTo(11, 6); // worst of France/Brazil
  });
  test("costOfProtection is the win-state upside forgone", () => {
    const before: PnLPoint[] = [{ outcome: "Spain", pnl: 60, prob: 0.25 }, { outcome: "France", pnl: -20, prob: 0.4 }, { outcome: "Brazil", pnl: -20, prob: 0.35 }];
    expect(costOfProtection(before, dist, new Set([0]))).toBeCloseTo(30, 6); // 60 → 30
  });
});
