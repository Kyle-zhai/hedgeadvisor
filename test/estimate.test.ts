import { describe, expect, test } from "vitest";
import { ensemble } from "@/lib/estimate/ensemble";
import { marginalBand, jointAllHit, copulaAllHit, invNorm, type MarginalBand } from "@/lib/estimate/joint";

describe("ensemble uncertainty primitive", () => {
  test("mean/std over estimates; shrinks toward 0.5 when they disagree", () => {
    const e = ensemble([0.6, 0.7, 0.5]);
    expect(e.mean).toBeCloseTo(0.6, 6);
    expect(e.std).toBeGreaterThan(0);
    expect(e.lo).toBeCloseTo(0.5, 6);
    expect(e.hi).toBeCloseTo(0.7, 6);
    // shrunk is pulled toward 0.5 (less confident than the raw mean)
    expect(e.shrunk).toBeLessThan(e.mean);
    expect(e.shrunk).toBeGreaterThan(0.5);
  });
  test("no disagreement → no shrink; empty → 0.5", () => {
    const same = ensemble([0.62, 0.62, 0.62]);
    expect(same.std).toBeCloseTo(0, 9);
    expect(same.shrunk).toBeCloseTo(0.62, 6);
    expect(ensemble([]).mean).toBe(0.5);
  });
});

describe("marginal band from de-vig method disagreement", () => {
  test("lo ≤ mid ≤ hi and all are valid probabilities", () => {
    const b = marginalBand([0.55, 0.3, 0.19], 0); // vigged 3-way, the favourite
    expect(b.lo).toBeLessThanOrEqual(b.mid + 1e-9);
    expect(b.mid).toBeLessThanOrEqual(b.hi + 1e-9);
    expect(b.lo).toBeGreaterThan(0);
    expect(b.hi).toBeLessThan(1);
    expect(b.methods.proportional).toBeGreaterThan(0);
  });
});

describe("Gaussian copula P(all hit)", () => {
  test("ρ=0 reproduces independence (Π p) within MC tolerance", () => {
    const ind = 0.5 * 0.4;
    expect(copulaAllHit([0.5, 0.4], 0, 40000, 7)).toBeCloseTo(ind, 1);
  });
  test("positive correlation raises P(all hit) above independence", () => {
    const ind = 0.5 * 0.4;
    const hi = copulaAllHit([0.5, 0.4], 0.7, 40000, 7);
    expect(hi).toBeGreaterThan(ind + 0.02);
  });
  test("near-perfect correlation approaches min(p) (Fréchet upper)", () => {
    expect(copulaAllHit([0.5, 0.4], 0.95, 40000, 7)).toBeGreaterThan(0.30); // → toward 0.40
  });
  test("invNorm is a sane inverse-CDF", () => {
    expect(invNorm(0.5)).toBeCloseTo(0, 6);
    expect(invNorm(0.975)).toBeCloseTo(1.959964, 3);
  });
});

describe("jointAllHit — independence + exact Fréchet range + illustrative correlated", () => {
  const bands: MarginalBand[] = [
    { lo: 0.4, mid: 0.5, hi: 0.55, std: 0.05, methods: { proportional: 0.5, power: 0.4, shin: 0.55 } },
    { lo: 0.35, mid: 0.4, hi: 0.45, std: 0.04, methods: { proportional: 0.4, power: 0.35, shin: 0.45 } },
  ];
  test("independence is the product of mids; Fréchet bounds are exact", () => {
    const j = jointAllHit(bands, { seed: 7 });
    expect(j.independence).toBeCloseTo(0.2, 4);
    expect(j.frechetHigh).toBeCloseTo(0.45, 4); // min(hi)
    expect(j.frechetLow).toBeCloseTo(0, 4); // max(0, 0.4+0.35−1)
    expect(j.legs).toBe(2);
  });
  test("the illustrative correlated point sits inside [independence, frechetHigh]", () => {
    const j = jointAllHit(bands, { rho: 0.25, N: 40000, seed: 7 });
    expect(j.correlated).toBeGreaterThan(j.independence - 0.02);
    expect(j.correlated).toBeLessThanOrEqual(j.frechetHigh + 0.02);
    expect(j.illustrativeRho).toBe(0.25);
  });
});
