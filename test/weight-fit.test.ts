import { describe, expect, test } from "vitest";
import { fitRankingWeights, DEFAULT_RANK_WEIGHTS, type WeightFitPoint } from "@/lib/relate/weightFit";
import { optimizeRobustHedge } from "@/lib/association";
import type { OptimizerCandidate } from "@/lib/association";

// ── §19 item 2: rank weights are configurable, defaults pinned, fit refuses thin data ──

describe("optimizer rank weights — defaults pinned + configurable", () => {
  const base = { stakeUsd: 20, primaryPrice: 0.25, keepFraction: 0.5, conservatism: 0.5 };
  // Two MODELED legs where the ordering hinges on the specificity weight: A has better raw reduction,
  // B has much higher specificity. With the pinned defaults A wins; a large wSpec flips to B.
  const A: OptimizerCandidate = {
    id: "a", label: "A", venue: "polymarket", side: "yes", price: 0.4, marginal: 0.38, maxSpendUsd: 2,
    provenance: "MODELED", modeledPayoff: { payGivenFail: 0.62, payGivenWin: 0.5 },
  };
  const B: OptimizerCandidate = {
    id: "b", label: "B", venue: "polymarket", side: "yes", price: 0.4, marginal: 0.38, maxSpendUsd: 2,
    provenance: "MODELED", modeledPayoff: { payGivenFail: 0.6, payGivenWin: 0.05 },
  };

  test("pinned defaults (0.2/0.15): regression — the historical ordering holds", () => {
    const r = optimizeRobustHedge({ ...base, candidates: [A, B] });
    // both admitted at most 1 soft leg; the soft-leg CAP means only the top-scored is sized
    expect(r.allocations).toHaveLength(1);
    expect(r.allocations[0].candidateId).toBe("b"); // specificity already wins at the default 0.2
  });

  test("rankWeights override reorders within the admitted set (never admits anything new)", () => {
    const r = optimizeRobustHedge({ ...base, candidates: [A, B], rankWeights: { specificity: 0, uncertainty: 0.15 } });
    expect(r.allocations).toHaveLength(1);
    expect(r.allocations[0].candidateId).toBe("a"); // with wSpec=0, raw reduction wins
    // the cap/gates are untouched: still exactly one soft leg
    const strict = optimizeRobustHedge({ ...base, conservatism: 0.92, candidates: [A, B], rankWeights: { specificity: 0.6, uncertainty: 0 } });
    expect(strict.allocations).toHaveLength(0); // no weight setting bypasses the MODELED posture gate
  });
});

describe("fitRankingWeights — honesty floor + fit behavior", () => {
  const mkEpisode = (key: string, winner: "spec" | "raw"): WeightFitPoint[] => [
    // candidate H: high specificity, realized pays when winner==="spec"
    { episodeKey: key, reductionPerDollar: 0.5, specificity: 0.6, uncertainty: 0.3, realizedReductionPerDollar: winner === "spec" ? 1.5 : -1 },
    // candidate R: high raw reduction, realized pays when winner==="raw"
    { episodeKey: key, reductionPerDollar: 0.8, specificity: 0.05, uncertainty: 0.3, realizedReductionPerDollar: winner === "raw" ? 1.5 : -1 },
  ];

  test("refuses to fit below the episode floor (today's moat is far below it)", () => {
    const points = Array.from({ length: 21 }, (_, i) => mkEpisode(`ep${i}`, "spec")).flat();
    const r = fitRankingWeights(points);
    expect(r.applied).toBe(false);
    expect(r.reason).toContain("noise-mining");
    expect(r.episodes).toBe(21);
    expect(r.best).toBeUndefined(); // no recommendation — pinned defaults stand
  });

  test("with enough episodes where SPECIFICITY predicts realized payoff, the fit raises wSpec", () => {
    const points = Array.from({ length: 120 }, (_, i) => mkEpisode(`ep${i}`, "spec")).flat();
    const r = fitRankingWeights(points, { minEpisodes: 100 });
    expect(r.applied).toBe(true);
    expect(r.best!.specificity).toBeGreaterThan(0.4); // needs wSpec > 0.5 to flip the pick to H here
    expect(r.best!.objective).toBeGreaterThan(r.defaultObjective!);
  });

  test("when raw reduction is the true predictor, the fit keeps wSpec low", () => {
    const points = Array.from({ length: 120 }, (_, i) => mkEpisode(`ep${i}`, "raw")).flat();
    const r = fitRankingWeights(points, { minEpisodes: 100 });
    expect(r.applied).toBe(true);
    expect(r.best!.specificity).toBeLessThanOrEqual(DEFAULT_RANK_WEIGHTS.specificity);
  });

  test("single-candidate episodes carry no ranking information and are excluded", () => {
    const solo: WeightFitPoint[] = Array.from({ length: 200 }, (_, i) => ({
      episodeKey: `solo${i}`, reductionPerDollar: 0.5, specificity: 0.3, uncertainty: 0.2, realizedReductionPerDollar: 1,
    }));
    const r = fitRankingWeights(solo);
    expect(r.applied).toBe(false);
    expect(r.episodes).toBe(0);
  });
});
