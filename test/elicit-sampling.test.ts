import { describe, it, expect } from "vitest";
import { shouldElicit, dayOfYearUTC } from "@/lib/relate/elicitSampling";

describe("shouldElicit", () => {
  it("default 0 ⇒ never elicit (cheap cron unchanged)", () => {
    for (let i = 0; i < 20; i++) expect(shouldElicit(0, i, 100)).toBe(false);
  });
  it("1.0 ⇒ always elicit", () => {
    for (let i = 0; i < 20; i++) expect(shouldElicit(1, i, 100)).toBe(true);
  });
  it("0.25 ⇒ ~1-in-4 anchors on a given day, deterministic", () => {
    const day = 50;
    const hits = Array.from({ length: 8 }, (_, i) => shouldElicit(0.25, i, day)).filter(Boolean).length;
    expect(hits).toBe(2); // 8 anchors / step 4 = 2
    // deterministic: same inputs ⇒ same output
    expect(shouldElicit(0.25, 3, day)).toBe(shouldElicit(0.25, 3, day));
  });
  it("rotates with day-of-year so every anchor gets sampled over time", () => {
    const idx = 1;
    const sampledDays = Array.from({ length: 8 }, (_, d) => shouldElicit(0.25, idx, d)).filter(Boolean).length;
    expect(sampledDays).toBeGreaterThan(0); // anchor 1 is elicited on some days within a step window
  });
  it("dayOfYearUTC is 1-366", () => {
    const doy = dayOfYearUTC(Date.UTC(2026, 5, 30));
    expect(doy).toBeGreaterThanOrEqual(1);
    expect(doy).toBeLessThanOrEqual(366);
  });
});
