import { describe, expect, test } from "vitest";
import { kalshiTakerFeeUsd, takerFeeUsd, feeFracOfNotional } from "@/lib/netcost";

describe("sports taker fee (the load-bearing cost input)", () => {
  test("matches Polymarket's worked example: 100 shares @ $0.50 => $0.375", () => {
    expect(takerFeeUsd(100, 0.5)).toBeCloseTo(0.375, 3);
  });

  test("fee fraction PEAKS at 0.75% at p=0.5 (sports) — NOT 1.8%", () => {
    expect(feeFracOfNotional(0.5)).toBeCloseTo(0.0075, 5);
    // every other price is strictly cheaper
    expect(feeFracOfNotional(0.85)).toBeLessThan(feeFracOfNotional(0.5));
    expect(feeFracOfNotional(0.15)).toBeLessThan(feeFracOfNotional(0.5));
  });

  test("the legs we actually recommend (p~0.85) cost ~0.39%, not ~1.8%", () => {
    expect(feeFracOfNotional(0.85)).toBeCloseTo(0.03 * 0.85 * 0.15, 6);
    expect(feeFracOfNotional(0.85) * 100).toBeLessThan(0.5);
  });

  test("sells are fee-exempt", () => {
    expect(takerFeeUsd(1000, 0.5, "sell")).toBe(0);
  });

  test("fee fraction is symmetric around 0.5", () => {
    expect(feeFracOfNotional(0.15)).toBeCloseTo(feeFracOfNotional(0.85), 9);
  });

  test("per-domain fee tiers: sports 0.75%, politics 1.0%, crypto 1.75% (peak at p=0.5)", () => {
    expect(feeFracOfNotional(0.5, { rate: 0.03, exponent: 1, takerOnly: true })).toBeCloseTo(0.0075, 6); // sports
    expect(feeFracOfNotional(0.5, { rate: 0.04, exponent: 1, takerOnly: true })).toBeCloseTo(0.01, 6); // politics
    expect(feeFracOfNotional(0.5, { rate: 0.07, exponent: 1, takerOnly: true })).toBeCloseTo(0.0175, 6); // crypto
  });

  test("Kalshi uses contracts × P × (1-P), without an extra notional-price factor", () => {
    expect(kalshiTakerFeeUsd(100, 0.5)).toBe(1.75);
    expect(kalshiTakerFeeUsd(100, 0.2)).toBe(1.12);
    expect(kalshiTakerFeeUsd(100, 0.8)).toBe(1.12);
  });
});
