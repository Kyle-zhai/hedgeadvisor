/**
 * Stage 1 (candidate generation) + Stage 2 (classification) — the pure, network-free pieces.
 * Fixtures mimic the live WC universe across both venues.
 */
import { describe, expect, test } from "vitest";
import { metadataCompatible, lexicalSimilarity, generateCandidates, classifyPair, hypothesisToClassification, normalizeKalshiEvent, normalizePolymarketEvent } from "@/lib/relate";
import type { NormalizedMarket } from "@/lib/relate";

function mkt(over: Partial<NormalizedMarket>): NormalizedMarket {
  return {
    id: over.id ?? "polymarket:x",
    venue: over.venue ?? "polymarket",
    eventKey: over.eventKey ?? "world-cup-winner",
    mutuallyExclusiveEvent: over.mutuallyExclusiveEvent ?? true,
    title: over.title ?? "France",
    marketTitle: over.marketTitle ?? "World Cup Winner",
    description: over.description ?? `${over.title ?? "France"} — World Cup Winner`,
    resolutionCriteria: over.resolutionCriteria ?? "If France wins the World Cup, YES.",
    probYes: over.probYes ?? 0.2,
    category: over.category ?? "world-cup",
    eventFamily: over.eventFamily ?? "tournament_winner",
    predicate: over.predicate ?? "generic",
    liquidityOk: over.liquidityOk ?? true,
    endDateMs: over.endDateMs ?? null,
    url: over.url ?? "https://x",
    entityTokens: over.entityTokens ?? ["france"],
    yesTokenId: over.yesTokenId ?? `${(over.id ?? "polymarket:x").split(":")[1] ?? "tok"}-yes`,
    noTokenId: over.noTokenId ?? `${(over.id ?? "polymarket:x").split(":")[1] ?? "tok"}-no`,
    feeRate: over.feeRate ?? 0.03,
    feeExponent: over.feeExponent ?? 1,
    feeTakerOnly: over.feeTakerOnly ?? true,
  };
}

const franceWin = mkt({ id: "pm:fr-win", eventKey: "world-cup-winner", title: "France", entityTokens: ["france"] });
const brazilWin = mkt({ id: "pm:br-win", eventKey: "world-cup-winner", title: "Brazil", entityTokens: ["brazil"], probYes: 0.06 });
const franceBoot = mkt({ id: "pm:fr-boot", eventKey: "world-cup-golden-boot-winner", marketTitle: "World Cup Golden Boot Winner", title: "France", entityTokens: ["france"], probYes: 0.1 });
const franceKalshi = mkt({ id: "ks:fr-win", venue: "kalshi", eventKey: "KXMENWORLDCUP-26", title: "France", marketTitle: "World Cup Winner", entityTokens: ["france"], probYes: 0.19 });
const mbappeBoot = mkt({ id: "pm:mbappe", eventKey: "world-cup-golden-boot-winner", marketTitle: "World Cup Golden Boot Winner", title: "Kylian Mbappe", entityTokens: ["kylian", "mbappe"], probYes: 0.23 });

describe("Stage 1 metadata filter", () => {
  test("same category + different event ⇒ compatible", () => {
    expect(metadataCompatible(franceWin, franceBoot)).toBe(true);
  });
  test("same event ⇒ NOT compatible (handled as structural, not cross-event)", () => {
    expect(metadataCompatible(franceWin, brazilWin)).toBe(false);
  });
  test("same event is not assumed exclusive when venue metadata says it is not", () => {
    const a = mkt({ id: "ks:a", eventKey: "mentions", title: "Spain", mutuallyExclusiveEvent: false });
    const b = mkt({ id: "ks:b", eventKey: "mentions", title: "France", mutuallyExclusiveEvent: false });
    expect(metadataCompatible(a, b)).toBe(true);
  });
  test("different category ⇒ not compatible", () => {
    expect(metadataCompatible(franceWin, mkt({ id: "pm:btc", category: "crypto" }))).toBe(false);
  });
  test("cross-domain recall can be explicitly enabled for mechanism discovery", () => {
    expect(metadataCompatible(franceWin, mkt({ id: "pm:hotel", eventKey: "hotel-occupancy", category: "economics" }), true)).toBe(true);
  });
});

describe("venue normalization safety", () => {
  test("does not de-vig unrelated ordinary Polymarket binaries as one exclusive partition", () => {
    const markets = normalizePolymarketEvent({
      eventId: "event", slug: "ordinary-binaries", title: "Several independent questions",
      negRisk: false, negRiskMarketId: null, tags: ["news"], yesPrices: [0.7, 0.6],
      markets: [
        { conditionId: "a", eventId: "event", eventSlug: "ordinary-binaries", question: "Will A happen?", groupItemTitle: "A", tokenIdYes: "ay", tokenIdNo: "an", midpointYes: 0.7, resolved: false, feeRate: 0.03, feeExponent: 1, feeTakerOnly: true, negRiskMarketId: null },
        { conditionId: "b", eventId: "event", eventSlug: "ordinary-binaries", question: "Will B happen?", groupItemTitle: "B", tokenIdYes: "by", tokenIdNo: "bn", midpointYes: 0.6, resolved: false, feeRate: 0.03, feeExponent: 1, feeTakerOnly: true, negRiskMarketId: null },
      ],
    }, "news");
    expect(markets.map((x) => x.probYes)).toEqual([0.7, 0.6]);
    expect(markets.every((x) => !x.mutuallyExclusiveEvent)).toBe(true);
  });

  test("does not surface closed/determined Kalshi markets as tradable candidates", () => {
    const base = {
      eventTicker: "KXTEST", seriesTicker: "KXTEST", label: "Spain", yesBid: 0.4, yesAsk: 0.42,
      yesMid: 0.41, last: 0.41, rules: "test", result: "", settledAtMs: null, deepLink: "https://kalshi.com/markets/kxtest",
    };
    const markets = normalizeKalshiEvent([
      { ...base, ticker: "KXTEST-A", status: "active" },
      { ...base, ticker: "KXTEST-D", status: "determined", result: "yes" },
    ], "Test event", "test");
    expect(markets.map((x) => x.id)).toEqual(["kalshi:KXTEST-A"]);
  });
});

describe("Stage 1 lexical similarity", () => {
  test("same entity across events scores higher than unrelated", () => {
    const same = lexicalSimilarity(franceWin, franceBoot);
    const diff = lexicalSimilarity(franceWin, mbappeBoot);
    expect(same).toBeGreaterThan(diff);
    expect(same).toBeGreaterThan(0.3); // entity-overlap boost
  });
});

describe("Stage 1 candidate generation", () => {
  const universe = [franceWin, brazilWin, franceBoot, franceKalshi, mbappeBoot];
  const cands = generateCandidates(franceWin, universe, { topK: 10 });
  test("includes same-event siblings as STRUCTURAL candidates", () => {
    const brazil = cands.find((c) => c.b.id === "pm:br-win");
    expect(brazil?.recall).toBe("structural");
    expect(brazil?.similarity).toBe(1);
  });
  test("includes cross-event candidates via recall, not the anchor itself", () => {
    expect(cands.every((c) => c.b.id !== franceWin.id)).toBe(true);
    expect(cands.some((c) => c.b.id === "pm:fr-boot" && c.recall === "lexical")).toBe(true);
  });
});

describe("Stage 2 rule classification", () => {
  test("same single-winner event ⇒ mutually_exclusive (exact)", async () => {
    const c = await classifyPair({ a: franceWin, b: brazilWin, recall: "structural", similarity: 1 });
    expect(c.relation).toBe("mutually_exclusive");
    expect(c.structuralJoint).toBe(0);
    expect(c.method).toBe("rule");
  });
  test("same non-exclusive event never receives an exact mutex joint", async () => {
    const a = mkt({ id: "ks:a", eventKey: "mentions", title: "Spain", mutuallyExclusiveEvent: false });
    const b = mkt({ id: "ks:b", eventKey: "mentions", title: "France", mutuallyExclusiveEvent: false });
    const c = await classifyPair({ a, b, recall: "lexical", similarity: 0.2 });
    expect(c.relation).not.toBe("mutually_exclusive");
    expect(c.structuralJoint).toBeUndefined();
  });
  test("same subject + equivalent question (cross-venue) ⇒ same", async () => {
    const c = await classifyPair({ a: franceWin, b: franceKalshi, recall: "lexical", similarity: 0.9 });
    expect(c.relation).toBe("same");
    expect(c.method).toBe("rule");
  });
  test("same subject + different question ⇒ related (positive)", async () => {
    const c = await classifyPair({ a: franceWin, b: franceBoot, recall: "lexical", similarity: 0.6 });
    expect(c.relation).toBe("related");
    expect(c.direction).toBe("positive");
    expect(c.estimateRho).toBeGreaterThan(0);
  });
  test("DIFFERENT entities sharing ONE token are NOT 'same' (no fabricated ANALYTIC cover)", async () => {
    // these would all false-match on a single shared token; only sameSubject (strict) blocks them
    const pairs: [string, string][] = [
      ["Korea Republic", "Korea DPR"],
      ["United States", "United Arab Emirates"],
      ["Congo", "DR Congo"],
    ];
    for (const [an, bn] of pairs) {
      const a = mkt({ id: "pm:a", eventKey: "world-cup-winner", title: an, marketTitle: "World Cup Winner", entityTokens: an.toLowerCase().split(" ") });
      const b = mkt({ id: "ks:b", venue: "kalshi", eventKey: "KXMENWORLDCUP-26", title: bn, marketTitle: "World Cup Winner", entityTokens: bn.toLowerCase().split(" ") });
      const c = await classifyPair({ a, b, recall: "lexical", similarity: 0.4 });
      expect(c.relation).not.toBe("same"); // must NOT be promotable to ANALYTIC cover-all
    }
  });
  test("the genuine cross-venue equivalent (same entity) IS 'same'/rule", async () => {
    const c = await classifyPair({ a: franceWin, b: franceKalshi, recall: "lexical", similarity: 0.9 });
    expect(c.relation).toBe("same");
    expect(c.method).toBe("rule");
  });
  test("no shared entity + low similarity ⇒ independent (heuristic, no fabrication)", async () => {
    const c = await classifyPair({ a: franceWin, b: mbappeBoot, recall: "lexical", similarity: 0.05 });
    expect(c.relation).toBe("independent");
    expect(c.method).toBe("heuristic");
  });
});

describe("Stage 2 honesty — LLM is HYPOTHESIS-only (never an exact structural relation)", () => {
  test("a Qwen MUTEX/EQUIVALENT maps to a hypothesis with NO structuralJoint/kind/estimateRho", () => {
    for (const rel of ["MUTEX", "EQUIVALENT", "IMPLICATION", "CAUSAL", "THEMATIC"] as const) {
      const c = hypothesisToClassification({
        relation: rel,
        direction: "NEGATIVE",
        mechanism: "test mechanism",
        sharedEntities: ["x"],
        counterexamples: ["y"],
        confidence: 0.9,
        requiresCalibration: true,
      });
      expect(c.method).toBe("llm");
      expect(c.structuralJoint).toBeUndefined(); // LLM may NEVER assert an exact joint
      expect(c.structuralKind).toBeUndefined();
      expect(c.estimateRho).toBeUndefined(); // LLM may NEVER invent a numeric correlation
      expect(c.hypothesis?.relation).toBe(rel);
    }
  });
});
