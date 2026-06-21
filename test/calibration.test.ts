import { describe, expect, test } from "vitest";
import { calibration, type Sample } from "@/lib/estimate/calibration";

describe("calibration metrics", () => {
  test("perfect forecasts → Brier 0, ECE 0, no bias", () => {
    const s: Sample[] = [
      { p: 1, outcome: 1 },
      { p: 0, outcome: 0 },
      { p: 1, outcome: 1 },
      { p: 0, outcome: 0 },
    ];
    const r = calibration(s);
    expect(r.brier).toBeCloseTo(0, 6);
    expect(r.ece).toBeCloseTo(0, 6);
    expect(r.bias).toBeCloseTo(0, 6);
  });

  test("coin-flip predictions on a 50/50 base rate → Brier 0.25, unbiased", () => {
    const s: Sample[] = [
      { p: 0.5, outcome: 1 },
      { p: 0.5, outcome: 0 },
      { p: 0.5, outcome: 1 },
      { p: 0.5, outcome: 0 },
    ];
    const r = calibration(s);
    expect(r.brier).toBeCloseTo(0.25, 6);
    expect(r.meanPred).toBeCloseTo(0.5, 6);
    expect(r.baseRate).toBeCloseTo(0.5, 6);
    expect(r.bias).toBeCloseTo(0, 6);
  });

  test("over-forecasting (0.9 said, never happens) → big bias + ECE, Brier 0.81", () => {
    const s: Sample[] = Array.from({ length: 10 }, () => ({ p: 0.9, outcome: 0 as const }));
    const r = calibration(s);
    expect(r.brier).toBeCloseTo(0.81, 6);
    expect(r.bias).toBeCloseTo(0.9, 6);
    expect(r.ece).toBeCloseTo(0.9, 6);
  });

  test("well-calibrated buckets (20% bucket hits ~20%, 80% bucket hits ~80%) → ECE ~0", () => {
    const lowReal = 2; // of 10 at p=0.2
    const hiReal = 8; // of 10 at p=0.8
    const s: Sample[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ p: 0.2, outcome: (i < lowReal ? 1 : 0) as 0 | 1 })),
      ...Array.from({ length: 10 }, (_, i) => ({ p: 0.8, outcome: (i < hiReal ? 1 : 0) as 0 | 1 })),
    ];
    const r = calibration(s);
    expect(r.ece).toBeCloseTo(0, 6);
    expect(r.bias).toBeCloseTo(0, 6);
    // each populated bucket's realized frequency matches its mean prediction
    for (const b of r.buckets) expect(b.meanOutcome).toBeCloseTo(b.meanPred, 6);
  });

  test("Brier skill > 0 when the forecast beats the base-rate guess", () => {
    // forecasts that separate winners from losers better than a constant
    const s: Sample[] = [
      { p: 0.8, outcome: 1 },
      { p: 0.75, outcome: 1 },
      { p: 0.2, outcome: 0 },
      { p: 0.25, outcome: 0 },
    ];
    const r = calibration(s);
    expect(r.brierSkill).toBeGreaterThan(0);
  });

  test("empty input is safe", () => {
    expect(calibration([]).n).toBe(0);
  });
});
