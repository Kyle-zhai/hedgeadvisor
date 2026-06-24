import { describe, expect, test } from "vitest";
import { deriveStructuralCompanions } from "@/lib/relate/structuralCompanions";
import { buildSuperposition } from "@/lib/relate/superpose";
import type { NormalizedMarket } from "@/lib/relate/types";

function mkMarket(p: Partial<NormalizedMarket> & { id: string; title: string; marketTitle: string; probYes: number }): NormalizedMarket {
  return {
    venue: "polymarket", eventKey: p.id, mutuallyExclusiveEvent: true, description: "", resolutionCriteria: "",
    category: "world-cup", eventFamily: "continent_winner", predicate: "wins", liquidityOk: true, endDateMs: null,
    url: "https://x", entityTokens: [], yesTokenId: "y", noTokenId: "n", feeRate: 0.03, feeExponent: 1, feeTakerOnly: true,
    ...p,
  };
}

const universe: NormalizedMarket[] = [
  mkMarket({ id: "eu", title: "Europe (UEFA)", marketTitle: "Which continent will win the World Cup?", probYes: 0.695 }),
  mkMarket({ id: "sa", title: "South America (CONMEBOL)", marketTitle: "Which continent will win the World Cup?", probYes: 0.225 }),
  // an unrelated market that must be ignored
  mkMarket({ id: "btc", title: "Bitcoin > $150k", marketTitle: "Crypto prices in 2026", probYes: 0.4, eventFamily: "asset_price_threshold" }),
];

describe("structural companions (ANALYTIC, deterministic)", () => {
  const legs = deriveStructuralCompanions({ title: "Spain", probYes: 0.1383 }, universe);
  const by = (id: string, side: string) => legs.find((l) => l.id === `struct:${id}:${side}`)!;

  test("Spain ⊆ Europe is an AMPLIFIER with exact conditionals; tier ANALYTIC", () => {
    const eu = by("eu", "YES");
    expect(eu.tier).toBe("ANALYTIC");
    expect(eu.pWin).toBe(1); // Spain wins ⇒ Europe wins, for certain
    expect(eu.pFail).toBeCloseTo((0.695 - 0.1383) / (1 - 0.1383), 3); // ≈ 0.646
    expect(eu.q).toBeCloseTo(0.695, 4);
    expect(eu.dimension).toBe("continent");
  });

  test("Spain ⟂ South America is a HEDGE: pays only when Spain fails", () => {
    const sa = by("sa", "YES");
    expect(sa.pWin).toBe(0);
    expect(sa.pFail).toBeCloseTo(0.225 / (1 - 0.1383), 3); // ≈ 0.261
    expect(sa.pFail).toBeGreaterThan(sa.pWin); // it's a hedge
  });

  test("NOT Europe is a HEDGE (a non-European champion ⇒ Spain failed)", () => {
    const noEu = by("eu", "NO");
    expect(noEu.title).toBe("NOT Europe (UEFA)");
    expect(noEu.pWin).toBe(0);
    expect(noEu.pFail).toBeCloseTo((1 - 0.695) / (1 - 0.1383), 3); // ≈ 0.354
    expect(noEu.q).toBeCloseTo(1 - 0.695, 4);
  });

  test("unknown anchor (no membership) ⇒ no structural companions", () => {
    expect(deriveStructuralCompanions({ title: "Atlantis", probYes: 0.1 }, universe)).toHaveLength(0);
  });

  test("the superposition selects the ANALYTIC amplifier for aggressive and a hedge for conservative", () => {
    const anchor = { winProb: 0.1383, stakeUsd: 20, entryPrice: 0.1385 };
    const aggr = buildSuperposition(anchor, legs, 1);
    expect(aggr.legs.length).toBeGreaterThanOrEqual(1);
    expect(aggr.tier).toBe("ANALYTIC"); // structurally certain
    expect(aggr.legs[0].title).toContain("Europe");
    expect(aggr.winPnlUsd).toBeGreaterThan(aggr.nakedWinPnlUsd); // higher payoff if Spain wins
    const cons = buildSuperposition(anchor, legs, 0);
    expect(cons.legs.length).toBeGreaterThanOrEqual(1);
    expect(cons.failPnlUsd).toBeGreaterThan(cons.nakedFailPnlUsd); // smaller loss if Spain fails
    expect(cons.evUsd).toBeLessThanOrEqual(cons.nakedEvUsd + 1e-6); // honesty holds
  });
});
