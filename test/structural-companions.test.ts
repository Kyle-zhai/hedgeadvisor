import { describe, expect, test } from "vitest";
import { deriveStructuralCompanions, parseCumulativeThreshold } from "@/lib/relate/structuralCompanions";
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

// ── Gate 3: domain-general single-winner siblings (§13 L3/L4) ────────────────────────────────────────────

describe("single-winner siblings (domain-general L3/L4, venue-proven)", () => {
  const election: NormalizedMarket[] = [
    mkMarket({ id: "cand-a", eventKey: "presidential-winner", title: "Candidate A", marketTitle: "Presidential Election Winner", probYes: 0.55, eventFamily: "election_winner", category: "politics" }),
    mkMarket({ id: "cand-b", eventKey: "presidential-winner", title: "Candidate B", marketTitle: "Presidential Election Winner", probYes: 0.42, eventFamily: "election_winner", category: "politics" }),
    mkMarket({ id: "cand-c", eventKey: "presidential-winner", title: "Candidate C", marketTitle: "Presidential Election Winner", probYes: 0.03, eventFamily: "election_winner", category: "politics" }),
    mkMarket({ id: "other", eventKey: "other-event", title: "Unrelated market", marketTitle: "Other", probYes: 0.5 }),
  ];
  const legs = deriveStructuralCompanions(
    { title: "Candidate A", probYes: 0.55, id: "cand-a", eventKey: "presidential-winner", mutuallyExclusiveEvent: true },
    election,
  );

  test("every sibling is an exact ANALYTIC mutex rival: pWin=0, pFail=pR/(1−pA)", () => {
    const b = legs.find((l) => l.id === "struct:cand-b:YES")!;
    expect(b).toBeDefined();
    expect(b.tier).toBe("ANALYTIC");
    expect(b.pWin).toBe(0);
    expect(b.pFail).toBeCloseTo(0.42 / (1 - 0.55), 4);
    expect(b.dimension).toBe("same_event_rival");
    const c = legs.find((l) => l.id === "struct:cand-c:YES")!;
    expect(c.pWin).toBe(0);
    expect(c.pFail).toBeCloseTo(0.03 / (1 - 0.55), 4);
  });

  test("the anchor itself and non-siblings are excluded", () => {
    expect(legs.find((l) => l.id.includes("cand-a"))).toBeUndefined();
    expect(legs.find((l) => l.id.includes("other"))).toBeUndefined();
  });

  test("no venue-proven mutual exclusivity ⇒ no rival legs (never a guessed partition)", () => {
    const nonMutex = election.map((m) => ({ ...m, mutuallyExclusiveEvent: false }));
    const none = deriveStructuralCompanions(
      { title: "Candidate A", probYes: 0.55, id: "cand-a", eventKey: "presidential-winner", mutuallyExclusiveEvent: false },
      nonMutex,
    );
    expect(none.filter((l) => l.dimension === "same_event_rival")).toHaveLength(0);
  });
});

// ── Gate 3: cumulative threshold ladders (§13 L2) ────────────────────────────────────────────────────────

describe("cumulative threshold ladders (L2, strict cumulative-only)", () => {
  const mkThresh = (id: string, title: string, probYes: number) =>
    mkMarket({ id, eventKey: "btc-2026", mutuallyExclusiveEvent: false, title, marketTitle: "Bitcoin prices 2026", probYes, eventFamily: "asset_price_threshold", category: "crypto" });
  const ladder: NormalizedMarket[] = [
    mkThresh("b100", "Bitcoin above $100k", 0.5),
    mkThresh("b150", "Bitcoin above $150k", 0.2),
    mkThresh("bin", "Bitcoin 100k to 150k", 0.3), // range BIN — mutex, never a subset rung
  ];

  test("higher-bar anchor: the lower bar is an exact superset (YES amplifier + NO hedge)", () => {
    const legs = deriveStructuralCompanions(
      { title: "Bitcoin above $150k", probYes: 0.2, id: "b150", eventKey: "btc-2026", mutuallyExclusiveEvent: false },
      ladder,
    );
    const yes = legs.find((l) => l.id === "struct:b100:YES")!;
    expect(yes).toBeDefined();
    expect(yes.tier).toBe("ANALYTIC");
    expect(yes.pWin).toBe(1); // clearing 150k clears 100k for certain
    expect(yes.pFail).toBeCloseTo((0.5 - 0.2) / (1 - 0.2), 4);
    const no = legs.find((l) => l.id === "struct:b100:NO")!;
    expect(no.pWin).toBe(0); // if the anchor hit, the lower bar hit, so NO lost
    expect(no.pFail).toBeCloseTo((1 - 0.5) / (1 - 0.2), 4); // pays when even the lower bar failed
    expect(no.dimension).toBe("threshold_ladder");
  });

  test("lower-bar anchor: the higher bar is an exact subset amplifier (pFail=0)", () => {
    const legs = deriveStructuralCompanions(
      { title: "Bitcoin above $100k", probYes: 0.5, id: "b100", eventKey: "btc-2026", mutuallyExclusiveEvent: false },
      ladder,
    );
    const hi = legs.find((l) => l.id === "struct:b150:YES")!;
    expect(hi).toBeDefined();
    expect(hi.pWin).toBeCloseTo(0.2 / 0.5, 4); // P(B|A)=pB/pA
    expect(hi.pFail).toBe(0); // a higher bar can never clear when the anchor failed
  });

  test("range bins are never ladder rungs (the kalshiBackfill lesson)", () => {
    const legs = deriveStructuralCompanions(
      { title: "Bitcoin above $150k", probYes: 0.2, id: "b150", eventKey: "btc-2026", mutuallyExclusiveEvent: false },
      ladder,
    );
    expect(legs.find((l) => l.id.includes("bin"))).toBeUndefined();
  });

  test("containment violated in prices ⇒ rung skipped honestly", () => {
    const broken = [mkThresh("b100", "Bitcoin above $100k", 0.1)]; // lower bar priced BELOW the anchor
    const legs = deriveStructuralCompanions(
      { title: "Bitcoin above $150k", probYes: 0.2, id: "b150", eventKey: "btc-2026", mutuallyExclusiveEvent: false },
      broken,
    );
    expect(legs.find((l) => l.id.includes("b100"))).toBeUndefined();
  });

  test("parseCumulativeThreshold: cumulative parses, bins do not", () => {
    expect(parseCumulativeThreshold("Bitcoin above $150k")).toBe(150000);
    expect(parseCumulativeThreshold("at least 3.5%")).toBeCloseTo(3.5);
    expect(parseCumulativeThreshold("150,000 or more")).toBe(150000);
    expect(parseCumulativeThreshold("Bitcoin 100k to 150k")).toBeNull();
    expect(parseCumulativeThreshold("between 3% and 4%")).toBeNull();
    expect(parseCumulativeThreshold("Candidate A")).toBeNull();
  });
});
