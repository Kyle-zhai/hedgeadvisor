import { describe, test, expect } from "vitest";
import { calibrateLeg } from "@/lib/relate/discover";
import type { BucketStat } from "@/lib/relate/tuningProfile";

const bucket = (b: Partial<BucketStat>): BucketStat => ({
  pGivenFails: 0.5, pGivenWins: 0.5, specificity: 0, samplesFail: 40, samplesWin: 40, ...b,
});

describe("calibrateLeg — the single moat-driven calibration path (hedge + amplifier)", () => {
  test("no bucket ⇒ modeled values pass through untouched at MODELED tier", () => {
    const r = calibrateLeg(null, 0.3, 0.7, 0.4, 0.5);
    expect(r).toEqual({ pWside: 0.3, pFside: 0.7, tier: "MODELED", samples: 0 });
  });

  test("HEDGE bucket (pays more on fail) pulls the fail-branch UP and promotes to CALIBRATED", () => {
    // modeled is timid (0.5 on fail); a well-evidenced hedge bucket realized 0.9 on fail / 0.1 on win.
    const r = calibrateLeg(bucket({ pGivenFails: 0.9, pGivenWins: 0.1, specificity: 0.8, samplesFail: 40, samplesWin: 40 }), 0.5, 0.5, 0.6, 0.5);
    expect(r.tier).toBe("CALIBRATED");
    expect(r.pFside).toBeGreaterThan(0.5); // shrunk toward the bucket's high fail-rate
    expect(r.pWside).toBeLessThan(0.5); // shrunk toward the bucket's low win-rate
    expect(r.pFside).toBeGreaterThan(r.pWside); // genuinely hedge-specific
  });

  test("AMPLIFIER bucket (pays more on win) pulls the WIN-branch UP — the aggressive-direction signal", () => {
    const r = calibrateLeg(bucket({ pGivenFails: 0.1, pGivenWins: 0.9, specificity: -0.8, samplesFail: 40, samplesWin: 40 }), 0.5, 0.5, 0.95, 0.5);
    expect(r.tier).toBe("CALIBRATED");
    expect(r.pWside).toBeGreaterThan(r.pFside); // amplifier: pays more when the anchor WINS
  });

  test("FRÉCHET clamp: a longshot side cannot inherit a near-certain payoff from a coarse bucket", () => {
    // bucket claims pays 0.99 on fail, but the side's own marginal (qSide) is tiny ⇒ P(pay|fail) ≤ qSide/(1-ap).
    const ap = 0.2, qSide = 0.02;
    const r = calibrateLeg(bucket({ pGivenFails: 0.99, pGivenWins: 0.0, specificity: 0.99 }), 0.01, 0.99, qSide, ap);
    expect(r.pFside).toBeLessThanOrEqual(qSide / (1 - ap) + 1e-9); // ≈0.025, NOT 0.99
    expect(r.pFside).toBeLessThan(0.1);
  });

  test("thin evidence (a branch < 20 samples) shrinks values but stays MODELED", () => {
    const r = calibrateLeg(bucket({ pGivenFails: 0.9, pGivenWins: 0.1, samplesFail: 5, samplesWin: 4 }), 0.5, 0.5, 0.6, 0.5);
    expect(r.tier).toBe("MODELED");
    expect(r.samples).toBe(9);
  });

  // Regression (review 626354c): a THIN, ASYMMETRIC bucket must NOT out-weigh a confident LLM hedge by
  // pulling the win-branch harder than the fail-branch. Weighting both branches by the WEAKER branch's
  // evidence keeps the fail>win ordering the LLM asserted, so the leg stays admissible.
  test("thin asymmetric bucket (5 fail / 18 win) does NOT flip a confident MODELED hedge", () => {
    const r = calibrateLeg(bucket({ pGivenFails: 0.30, pGivenWins: 0.70, specificity: -0.40, samplesFail: 5, samplesWin: 18 }), 0.30, 0.55, 0.40, 0.5);
    expect(r.tier).toBe("MODELED"); // not enough evidence to be calibrated
    expect(r.pFside).toBeGreaterThan(r.pWside); // the hedge ordering survives — leg NOT spuriously vetoed
  });

  test("but a CALIBRATED amplifier bucket (≥20 BOTH) DOES correctly disqualify a mis-signed hedge", () => {
    const r = calibrateLeg(bucket({ pGivenFails: 0.10, pGivenWins: 0.90, specificity: -0.80, samplesFail: 40, samplesWin: 40 }), 0.30, 0.55, 0.40, 0.5);
    expect(r.tier).toBe("CALIBRATED");
    expect(r.pFside).toBeLessThan(r.pWside); // strong amplifier evidence rightly overrides the LLM's hedge claim
  });
});
