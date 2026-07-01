import { describe, expect, test } from "vitest";
import { buildSuperposition, type SuperposeLeg } from "@/lib/relate/superpose";
import { toOptimizerModeledLegs } from "@/lib/relate/discover";

/**
 * Gate 5a: a MODELED leg's conservative interval (failLower) must reflect its BUCKET EVIDENCE — a leg
 * whose structural bucket has settled samples gets a tighter interval than a zero-evidence one, and the
 * widening can only ever LOWER failLower (more conservative), never raise pFail or promote a tier.
 */

function mkLeg(id: string, dimension: string, bucketSamples: number | undefined): SuperposeLeg {
  return {
    id, marketTitle: `${id} market`, title: id, side: "YES",
    q: 0.3, pWin: 0.1, pFail: 0.5, dimension,
    tier: "MODELED", marketId: id, venue: "polymarket", marginal: 0.28,
    bucketSamples,
  };
}

describe("Gate 5a — MODELED failLower widens with bucket thinness", () => {
  const anchor = { winProb: 0.3, stakeUsd: 20, entryPrice: 0.3 };
  // conservative direction (0): both legs are fail-leaning (pFail > pWin) so both qualify
  const sup = buildSuperposition(anchor, [mkLeg("thin", "d1", 0), mkLeg("fat", "d2", 60)], 0);
  const cands = toOptimizerModeledLegs(sup);
  const by = (needle: string) => cands.find((c) => c.id.includes(needle))!;

  test("both legs surface as MODELED candidates with a failLower bound", () => {
    expect(cands).toHaveLength(2);
    for (const c of cands) {
      expect(c.provenance).toBe("MODELED");
      expect(typeof c.modeledPayoff?.failLower).toBe("number");
      // the bound is a LOWER bound: strictly below the stated pFail (interval is never zero)
      expect(c.modeledPayoff!.failLower!).toBeLessThan(c.modeledPayoff!.payGivenFail);
      expect(c.modeledPayoff!.failLower!).toBeGreaterThanOrEqual(0);
    }
  });

  test("zero-evidence bucket ⇒ WIDER interval (lower failLower) than a well-fed bucket", () => {
    const thin = by("thin").modeledPayoff!;
    const fat = by("fat").modeledPayoff!;
    expect(thin.failLower!).toBeLessThan(fat.failLower!);
    // and the widening never touches the point estimate itself
    expect(thin.payGivenFail).toBeCloseTo(fat.payGivenFail, 6);
  });

  test("expected magnitudes: se = sqrt(max(0.05, p(1-p)) / (m + 12))", () => {
    const p = by("thin").modeledPayoff!.payGivenFail;
    const seThin = Math.sqrt(Math.max(0.05, p * (1 - p)) / (0 + 12));
    const seFat = Math.sqrt(Math.max(0.05, p * (1 - p)) / (60 + 12));
    expect(by("thin").modeledPayoff!.failLower!).toBeCloseTo(Math.max(0, p - seThin), 3);
    expect(by("fat").modeledPayoff!.failLower!).toBeCloseTo(Math.max(0, p - seFat), 3);
  });
});
