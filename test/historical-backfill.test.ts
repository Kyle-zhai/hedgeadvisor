import { describe, expect, test } from "vitest";
import { historicalPairCutoffMs, historicalPointAtOrBefore } from "@/lib/relate/historicalBackfill";

describe("historical provider backfill", () => {
  test("selects the last genuine point before cutoff and never falls forward", () => {
    const history = [{ t: 100, p: 0.2 }, { t: 200, p: 0.3 }, { t: 300, p: 0.4 }];
    expect(historicalPointAtOrBefore(history, 250_000)).toEqual({ t: 200, p: 0.3 });
    expect(historicalPointAtOrBefore(history, 50_000)).toBeNull();
  });

  test("rejects terminal and invalid prices", () => {
    const history = [{ t: 100, p: 0 }, { t: 200, p: 1 }, { t: 300, p: 0.55 }];
    expect(historicalPointAtOrBefore(history, 250_000)).toBeNull();
  });

  test("places a joint cutoff before the first leg resolves", () => {
    const hour = 3_600_000;
    expect(historicalPairCutoffMs(1_000 * hour, 1_500 * hour, 24)).toBe(976 * hour);
    expect(historicalPairCutoffMs(1_500 * hour, 1_000 * hour, 24)).toBe(976 * hour);
  });
});
