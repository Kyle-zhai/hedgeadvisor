import { describe, expect, test } from "vitest";
import { buildCombo, detectStructuralJoint, type PricedComboLeg, type StructLeg } from "@/lib/combo";

const sleg = (o: Partial<StructLeg> & { eventSlug: string; index: number; title: string; q: number }): StructLeg => ({
  side: "yes",
  negRiskMarketId: "nr",
  ...o,
});

function leg(title: string, q: number, price: number, side: "yes" | "no" = "yes"): PricedComboLeg {
  return { title, marketTitle: title, side, q, price, deepLink: "https://polymarket.com/event/x" };
}

describe("Combo Truth Check math", () => {
  // two legs: fair 0.50/0.40, you pay 0.55/0.45 (vig on each)
  const legs = [leg("A", 0.5, 0.55), leg("B", 0.4, 0.45)];

  test("combo prob is the product of de-vigged leg probs; fair = combo prob", () => {
    const c = buildCombo(legs, { stakeUsd: 20 });
    expect(c.comboProb).toBeCloseTo(0.5 * 0.4, 4); // 0.20
    expect(c.fairPriceCents).toBeCloseTo(20, 1); // fair = comboProb in cents
  });

  test("build cost is the product of executable prices and exceeds fair (compounded vig)", () => {
    const c = buildCombo(legs, { stakeUsd: 20 });
    expect(c.buildPriceCents).toBeCloseTo(0.55 * 0.45 * 100, 1); // 24.75¢
    expect(c.buildPriceCents).toBeGreaterThan(c.fairPriceCents);
    expect(c.compoundedVigCents).toBeCloseTo(24.75 - 20, 1);
  });

  test("EV is honestly negative and max loss is the stake", () => {
    const c = buildCombo(legs, { stakeUsd: 20 });
    expect(c.expectedValueUsd).toBeLessThan(0); // fair/build − 1 < 0
    expect(c.maxLossUsd).toBeCloseTo(-20, 6);
    expect(c.payoutMultiple).toBeCloseTo(1 / (0.55 * 0.45), 2);
    expect(c.maxGainUsd).toBeGreaterThan(0);
  });

  test("independence assumption is flagged for multi-leg combos", () => {
    const c = buildCombo(legs, { stakeUsd: 20 });
    expect(c.warnings.some((w) => /independent/i.test(w))).toBe(true);
  });

  test("longshot combo (tiny joint prob) is HIGH_RISK", () => {
    const longshot = [leg("A", 0.2, 0.25), leg("B", 0.15, 0.2), leg("C", 0.1, 0.14)];
    const c = buildCombo(longshot, { stakeUsd: 20 });
    expect(c.comboProb).toBeLessThan(0.1);
    expect(c.verdict).toBe("HIGH_RISK");
  });

  test("quote check: a quote cheaper than legging-in is a REAL discount (still EV-negative)", () => {
    // build = 24.75¢; quote 23¢ < build, but > fair 20¢
    const c = buildCombo(legs, { stakeUsd: 20, quotedComboPrice: 0.23 });
    expect(c.quote?.realDiscount).toBe(true);
    expect(c.quote?.beatsFair).toBe(false);
    expect(c.quote?.note).toMatch(/real discount/i);
  });

  test("quote check: a quote pricier than legging-in is NO discount", () => {
    const c = buildCombo(legs, { stakeUsd: 20, quotedComboPrice: 0.27 });
    expect(c.quote?.realDiscount).toBe(false);
    expect(c.quote?.note).toMatch(/no discount/i);
  });

  test("mutually exclusive legs (same market) → impossible combo: 0% chance, you always lose the stake", () => {
    const c = buildCombo(legs, { stakeUsd: 20, mutuallyExclusive: true });
    expect(c.comboProb).toBe(0);
    expect(c.fairPriceCents).toBe(0);
    expect(c.expectedValueUsd).toBeCloseTo(-20, 6); // EV = −stake (never pays)
    expect(c.verdict).toBe("HIGH_RISK");
    expect(c.warnings.some((w) => /mutually exclusive/i.test(w))).toBe(true);
  });

  // Honesty guard (review P1): a combo can never show a positive EV or a phantom gain.
  test("EV is clamped ≤ 0 even if a leg's fair exceeds its price (mispriced NO book)", () => {
    const c = buildCombo([leg("A", 0.6, 0.5)], { stakeUsd: 20 }); // fair 0.6 > pay 0.5 → raw EV +20%
    expect(c.expectedValueUsd).toBeLessThanOrEqual(0);
  });
  test("mutually exclusive combo shows NO phantom gain (payout 0×, maxGain $0)", () => {
    const c = buildCombo(legs, { stakeUsd: 20, mutuallyExclusive: true });
    expect(c.payoutMultiple).toBe(0);
    expect(c.maxGainUsd).toBe(0);
    expect(c.maxLossUsd).toBeCloseTo(-20, 6);
  });
});

describe("structural exact-joint detector", () => {
  test("same outcome YES + NO → impossible (p=0)", () => {
    const r = detectStructuralJoint([
      sleg({ eventSlug: "e", index: 2, title: "Spain", q: 0.5, side: "yes" }),
      sleg({ eventSlug: "e", index: 2, title: "Spain", q: 0.5, side: "no" }),
    ]);
    expect(r?.kind).toBe("same-outcome");
    expect(r?.p).toBe(0);
  });

  test("two YES in the same single-winner event → mutually exclusive (p=0)", () => {
    const r = detectStructuralJoint([
      sleg({ eventSlug: "world-cup-winner", index: 0, title: "England", q: 0.1 }),
      sleg({ eventSlug: "world-cup-winner", index: 1, title: "France", q: 0.18 }),
    ]);
    expect(r?.kind).toBe("exclusive");
    expect(r?.p).toBe(0);
  });

  test("two YES sharing a negRiskMarketId across slugs → exclusive (p=0)", () => {
    const r = detectStructuralJoint([
      sleg({ eventSlug: "ev-a", index: 0, title: "X", q: 0.3, negRiskMarketId: "shared" }),
      sleg({ eventSlug: "ev-b", index: 0, title: "Y", q: 0.4, negRiskMarketId: "shared" }),
    ]);
    expect(r?.kind).toBe("exclusive");
    expect(r?.p).toBe(0);
  });

  test("winning ⊆ reaching the final (same team) → exact joint = P(win)", () => {
    const r = detectStructuralJoint([
      sleg({ eventSlug: "world-cup-winner", index: 0, title: "England", q: 0.1, negRiskMarketId: "nrW" }),
      sleg({ eventSlug: "world-cup-nation-to-reach-final", index: 0, title: "England", q: 0.18, negRiskMarketId: "nrF" }),
    ]);
    expect(r?.kind).toBe("subset");
    expect(r?.p).toBeCloseTo(0.1, 6); // min(0.1, 0.18)
  });

  test("a team winning ⊆ its confederation winning → exact subset joint", () => {
    const r = detectStructuralJoint([
      sleg({ eventSlug: "world-cup-winner", index: 0, title: "England", q: 0.1, negRiskMarketId: "nrW" }),
      sleg({ eventSlug: "which-continent-will-win-the-world-cup", index: 0, title: "Europe (UEFA)", q: 0.72, negRiskMarketId: "nrC" }),
    ]);
    expect(r?.kind).toBe("subset");
    expect(r?.p).toBeCloseTo(0.1, 6);
  });

  test("unrelated cross-market legs → no structural relation (null)", () => {
    const r = detectStructuralJoint([
      sleg({ eventSlug: "world-cup-winner", index: 0, title: "England", q: 0.1, negRiskMarketId: "nrW" }),
      sleg({ eventSlug: "presidential-election-winner-2028", index: 0, title: "Trump", q: 0.4, negRiskMarketId: "nrP" }),
    ]);
    expect(r).toBeNull();
  });

  test("buildCombo with a p=0 structural joint → impossible (0% chance, $0 gain)", () => {
    const c = buildCombo([leg("A", 0.5, 0.55), leg("B", 0.4, 0.45)], {
      stakeUsd: 20,
      structuralJoint: { p: 0, kind: "exclusive", why: "same single-winner market" },
    });
    expect(c.comboProb).toBe(0);
    expect(c.maxGainUsd).toBe(0);
    expect(c.structuralJoint?.p).toBe(0);
    expect(c.warnings.some((w) => /single-winner/i.test(w))).toBe(true);
  });

  test("buildCombo with a subset structural joint → collapses to the narrow leg (exact), drops estimate", () => {
    const fakeEstimate = { independence: 0.018, frechetLow: 0, frechetHigh: 0.1, illustrativeRho: 0.25, correlated: 0.03, legs: 2 };
    // narrow leg q=0.10 (price 0.11) ⊆ broad leg q=0.18 (price 0.19); exact joint = P(narrow)=0.10
    const c = buildCombo([leg("A", 0.1, 0.11), leg("B", 0.18, 0.19)], {
      stakeUsd: 20,
      jointEstimate: fakeEstimate,
      structuralJoint: { p: 0.1, kind: "subset", why: "winning ⊆ reaching the final" },
    });
    expect(c.structuralJoint?.kind).toBe("subset");
    expect(c.jointEstimate).toBeUndefined(); // structural exact supersedes the estimate
    // headline chance = the EXACT joint, not the independent product (0.10×0.18=0.018)
    expect(c.comboProb).toBeCloseTo(0.1, 4);
    // collapses onto the narrow leg: build = its price (0.11), payout = 1/0.11, EV honestly < 0
    expect(c.buildPriceCents).toBeCloseTo(11, 4);
    expect(c.payoutMultiple).toBeCloseTo(1 / 0.11, 2);
    expect(c.expectedValueUsd).toBeLessThan(0);
    expect(c.maxGainUsd).toBeGreaterThan(0);
  });
});
