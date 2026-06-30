import { describe, it, expect } from "vitest";
import { deriveKalshiJobs } from "@/lib/relate/kalshiBackfill";
import type { KalshiMarket, KalshiEventMeta } from "@/lib/kalshi";

const ev = (mutuallyExclusive: boolean, title = "Test Event"): KalshiEventMeta => ({
  eventTicker: "EVT-26", seriesTicker: "EVT", title, subTitle: "", mutuallyExclusive, feeMultiplier: 1, category: "Politics",
});
const mkt = (ticker: string, label: string, result: "yes" | "no" | ""): KalshiMarket => ({
  ticker, eventTicker: "EVT-26", seriesTicker: "EVT", label, yesBid: null, yesAsk: null, yesMid: 0.5,
  last: 0.5, rules: "", status: "settled", result, settledAtMs: 1, deepLink: "",
});

describe("deriveKalshiJobs", () => {
  it("mutex event with EXACTLY 2 settled contenders → one cross_entity rival (NEGATIVE)", () => {
    const jobs = deriveKalshiJobs(ev(true), [mkt("A", "Alice", "yes"), mkt("B", "Bob", "no")]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].relation.role).toBe("cross_entity");
    expect(jobs[0].relation.relationDirection).toBe("NEGATIVE");
    expect(jobs[0].relation.mechanismSignature).toContain("cross_entity");
    expect(jobs[0].anchor.venue).toBe("kalshi");
  });
  it("mutex event with >2 markets (multi-outcome field OR range bins) → skipped", () => {
    const jobs = deriveKalshiJobs(ev(true), [mkt("A", "Alice", "no"), mkt("B", "Bob", "no"), mkt("C", "Carol", "yes")]);
    expect(jobs).toHaveLength(0);
  });
  it("mutex RANGE event (bins, >2) is skipped — never mislabelled a subset", () => {
    const jobs = deriveKalshiJobs(ev(true), [mkt("L", "1% to 2%", "no"), mkt("M", "2% to 3%", "yes"), mkt("H", "3% to 4%", "no")]);
    expect(jobs).toHaveLength(0);
  });
  it("non-mutex CUMULATIVE thresholds (≥3) → ladder subset jobs (same_entity, POSITIVE), higher⊆lower", () => {
    const jobs = deriveKalshiJobs(ev(false), [mkt("T2", "Above 2%", "yes"), mkt("T3", "Above 3%", "yes"), mkt("T4", "Above 4%", "no")]);
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs[0].relation.role).toBe("same_entity");
    expect(jobs[0].relation.relationDirection).toBe("POSITIVE");
    // anchor = higher threshold (⊆), candidate = lower (superset)
    expect(jobs[0].anchor.label).toMatch(/Above 3%|Above 4%/);
    expect(jobs[0].candidate.label).toMatch(/Above 2%|Above 3%/);
  });
  it("non-mutex RANGE bins (not cumulative) → skipped (no false subset)", () => {
    const jobs = deriveKalshiJobs(ev(false), [mkt("L", "1% to 2%", "no"), mkt("M", "2% to 3%", "yes"), mkt("H", "3% to 4%", "no")]);
    expect(jobs).toHaveLength(0);
  });
  it("unsettled markets are excluded", () => {
    const jobs = deriveKalshiJobs(ev(true), [mkt("A", "Alice", "yes"), mkt("B", "Bob", "")]);
    expect(jobs).toHaveLength(0); // only 1 settled → <2
  });
});
