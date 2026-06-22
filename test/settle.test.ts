/**
 * Closed-loop data plumbing, hardened: GRANULAR templates (predicate + role + version, no pollution),
 * per-(cluster, BRANCH) weighting (balanced + no per-contract amplification), and ROLE-AWARE pairing
 * (unlike entities never pool). These are the corrections that make a CALIBRATED label trustworthy.
 */
import { describe, expect, test } from "vitest";
import { eventFamily, mechanismSignature, relationKey, predicateOf, relationRole } from "@/lib/relate/relationKey";
import { canonicalEventClass } from "@/lib/relate/ontology";
import { buildRelationObservations, observationsForResolvedInstances, frozenResolvedInstance, type ResolvedInstance } from "@/lib/relate";
import { pmOutcome, kalshiOutcome, pairResolvedInstances, type MarketOutcome } from "@/lib/relate";
import { countConditionalObservations, calibrateConditionalPayoff } from "@/lib/association";

describe("granular templates: predicate + role + version", () => {
  test("predicate separates mechanisms; outcome label de-collides multi-outcome contracts", () => {
    expect(predicateOf("Halftime: First Song", "first song", "Swim")).toBe("first_song=swim");
    expect(predicateOf("Halftime: First Song", "first song", "Hung Up")).toBe("first_song=hung_up");
    expect(predicateOf("Will announcer say champion", "announcer says champion")).toBe("says_champion");
    // says_champion ≠ first_song ≠ trophy_lift, and two songs ≠ each other
    const keys = new Set([
      relationKey("tournament_winner", "broadcast_word", "says_champion", "global_event", "no"),
      relationKey("tournament_winner", "broadcast_word", "first_song=swim", "global_event", "no"),
      relationKey("tournament_winner", "broadcast_word", "first_song=hung_up", "global_event", "no"),
    ]);
    expect(keys.size).toBe(3);
  });
  test("key carries role + version and is side-specific", () => {
    expect(relationKey("a", "b", "p", "same_entity", "no")).toContain("->same_entity->no@v");
    expect(relationKey("a", "b", "p", "same_entity", "no")).not.toBe(relationKey("a", "b", "p", "global_event", "no"));
  });
  test("v5 ontology merges synonyms but separates payoff directions", () => {
    expect(canonicalEventClass("national_team_title")).toBe("competition_winner");
    expect(canonicalEventClass("tournament_champion")).toBe("competition_winner");
    expect(relationKey("national_team_title", "broadcast_word_occurrence", "says_champion", "cross_domain", "no", "causal.cross_domain.overlapping.event_class.positive.edges=causes"))
      .not.toBe(relationKey("national_team_title", "broadcast_word_occurrence", "says_champion", "cross_domain", "no", "causal.cross_domain.overlapping.event_class.negative.edges=causes"));
  });
  test("relationRole classifies entity relationships", () => {
    expect(relationRole("France", { entity: "first song", family: "broadcast_word" })).toBe("global_event");
    expect(relationRole("Spain", { entity: "champion", family: "broadcast_word", context: "during Spain's live match" })).toBe("entity_event");
    expect(relationRole("France", { entity: "champion", family: "broadcast_word", context: "during Spain's live match" })).toBe("global_event");
    expect(relationRole("France", { entity: "France", family: "stage_advance" })).toBe("same_entity");
    expect(relationRole("France", { entity: "Brazil", family: "tournament_winner" })).toBe("rival");
    expect(relationRole("France", { entity: "Mbappe", family: "golden_boot" })).toBe("unrelated");
  });
  test("mechanism graph opens reusable cross-entity and cross-domain roles", () => {
    const base = {
      anchorEventClass: "national_team_title",
      candidateEventClass: "coach_departure",
      mechanismType: "BEHAVIORAL" as const,
      scope: "CROSS_ENTITY" as const,
      timeOrder: "ANCHOR_BEFORE_CANDIDATE" as const,
      portability: "EVENT_CLASS" as const,
      nodes: [
        { id: "anchor_event", label: "team result", kind: "EVENT" as const },
        { id: "candidate_event", label: "coach leaves", kind: "EVENT" as const },
      ],
      edges: [{ from: "anchor_event", to: "candidate_event", kind: "CAUSES" as const }],
      sharedDrivers: [],
    };
    expect(relationRole("Spain", { entity: "Luis de la Fuente", family: "employment", mechanismGraph: base })).toBe("cross_entity");
    const crossDomain = { ...base, scope: "CROSS_DOMAIN" as const, candidateEventClass: "hotel_occupancy_threshold", mechanismType: "ECONOMIC" as const };
    expect(relationRole("Spain", { entity: "Madrid hotels", family: "economics", mechanismGraph: crossDomain })).toBe("cross_domain");
    expect(mechanismSignature(crossDomain, "NEGATIVE")).toBe("economic.cross_domain.anchor_before_candidate.event_class.negative.edges=causes");
  });
});

describe("per-(cluster, BRANCH) weighting (balanced, no amplification)", () => {
  test("each event contributes total weight 1 to EACH branch (win and fail)", () => {
    // one tournament: 1 winner, 3 losers → win branch and fail branch each total weight 1
    const instances: ResolvedInstance[] = [
      { sampleKey: "wc:arg:c", clusterKey: "wc", anchorPaysYes: true, candidateYes: false },
      { sampleKey: "wc:spa:c", clusterKey: "wc", anchorPaysYes: false, candidateYes: true },
      { sampleKey: "wc:fra:c", clusterKey: "wc", anchorPaysYes: false, candidateYes: true },
      { sampleKey: "wc:bra:c", clusterKey: "wc", anchorPaysYes: false, candidateYes: true },
    ];
    const { observations } = buildRelationObservations("tournament_winner", "broadcast_word", "says_champion", "global_event", "no", instances);
    const winW = observations.filter((o) => o.anchorPays).reduce((s, o) => s + (o.weight ?? 0), 0);
    const failW = observations.filter((o) => !o.anchorPays).reduce((s, o) => s + (o.weight ?? 0), 0);
    expect(winW).toBeCloseTo(1, 9); // win branch total 1 (was 1/4 under flat clustering)
    expect(failW).toBeCloseTo(1, 9); // fail branch total 1
  });
  test("aggregating many candidate contracts in ONE call does not multiply event weight", () => {
    // same event, 3 candidate contracts, 2 teams each → fail branch still totals 1 per event
    const insts: ResolvedInstance[] = [];
    for (const c of ["c1", "c2", "c3"]) for (const [t, won] of [["arg", true], ["spa", false]] as const)
      insts.push({ sampleKey: `wc:${t}:${c}`, clusterKey: "wc", anchorPaysYes: won, candidateYes: false });
    const { observations } = buildRelationObservations("a", "b", "p", "global_event", "no", insts);
    const failW = observations.filter((o) => !o.anchorPays).reduce((s, o) => s + (o.weight ?? 0), 0);
    expect(failW).toBeCloseTo(1, 9); // NOT 3× — aggregated and normalized once
  });
  test("balanced branches let a true NO-side hedge clear with ~20 events per branch", () => {
    const instances: ResolvedInstance[] = [];
    for (let i = 0; i < 40; i++) instances.push({ sampleKey: `s${i}:e:c`, clusterKey: `s${i}`, anchorPaysYes: i < 20, candidateYes: i < 20 });
    const obs = buildRelationObservations("tournament_winner", "x", "p", "global_event", "no", instances).observations.map((o) => ({ anchorPays: o.anchorPays, candidatePays: o.candidatePays, weight: o.weight }));
    const cal = calibrateConditionalPayoff(countConditionalObservations(obs), 0.95, 20);
    expect(cal.sufficientEvidence).toBe(true);
    expect(cal.payGivenAnchorFails.mean).toBeGreaterThan(cal.payGivenAnchorPays.mean);
  });
});

describe("role-aware enumerator (no entity mismatch)", () => {
  const anchors: MarketOutcome[] = [
    { entity: "France", marketId: "a1", settledYes: true },
    { entity: "Spain", marketId: "a2", settledYes: false },
  ];
  test("global_event pairs EVERY settled anchor", () => {
    const inst = pairResolvedInstances("wc", anchors, { entity: "first song", marketId: "c", settledYes: false }, "global_event");
    expect(inst.length).toBe(2);
  });
  test("same_entity pairs ONLY the matching team (Spain↔Spain, never Argentina↔Spain)", () => {
    const inst = pairResolvedInstances("wc", anchors, { entity: "Spain", marketId: "c", settledYes: true }, "same_entity");
    expect(inst.length).toBe(1);
    expect(inst[0].anchorMarketId).toBe("a2");
  });
  test("entity_event pairs ONLY explicitly referenced anchors", () => {
    const inst = pairResolvedInstances("wc", anchors, {
      entity: "champion", marketId: "c", settledYes: true, relatedEntities: ["Spain"],
    }, "entity_event");
    expect(inst).toHaveLength(1);
    expect(inst[0].anchorMarketId).toBe("a2");
  });
  test("cross-domain mechanism pairs only the classified anchor, not every outcome", () => {
    const inst = pairResolvedInstances("wc", anchors, {
      entity: "Madrid hotel occupancy", marketId: "c", settledYes: true, relatedEntities: ["Spain"],
    }, "cross_domain");
    expect(inst).toHaveLength(1);
    expect(inst[0].anchorMarketId).toBe("a2");
  });
  test("rival / unrelated generate NO observations (structural or noise)", () => {
    expect(pairResolvedInstances("wc", anchors, { entity: "Brazil", marketId: "c", settledYes: true }, "rival")).toEqual([]);
    expect(pairResolvedInstances("wc", anchors, { entity: "Mbappe", marketId: "c", settledYes: true }, "unrelated")).toEqual([]);
  });
  test("settle outcomes are leakage/dispute-safe", () => {
    expect(pmOutcome(0.99, true)).toBe(true);
    expect(pmOutcome(0.6, true)).toBeNull();
    expect(pmOutcome(0.99, false)).toBeNull();
    expect(kalshiOutcome("yes", "settled")).toBe(true);
    expect(kalshiOutcome("yes", "active")).toBeNull();
  });
});

describe("snapshot-driven frozen resolution (decoupled settle, true timestamps)", () => {
  const pair = { anchorMarketId: "0xanchor", candidateMarketId: "KX-CAND", clusterKey: "world-cup-winner" };

  test("pairs only when BOTH sides settled; cluster = anchor event; resolved_at = LATER true time", () => {
    const t1 = Date.UTC(2026, 6, 1), t2 = Date.UTC(2026, 6, 10);
    const inst = frozenResolvedInstance(pair, { settledYes: false, resolvedAtMs: t1 }, { settledYes: true, resolvedAtMs: t2 }, 0);
    expect(inst).not.toBeNull();
    expect(inst!.clusterKey).toBe("world-cup-winner"); // anchor EVENT instance, not a global constant
    expect(inst!.sampleKey).toBe("world-cup-winner:0xanchor:KX-CAND");
    expect(inst!.anchorPaysYes).toBe(false);
    expect(inst!.candidateYes).toBe(true);
    expect(inst!.resolvedAt).toBe(new Date(t2).toISOString()); // the LATER of the two settlements
  });

  test("either side unsettled ⇒ null (no leakage, no fabrication)", () => {
    expect(frozenResolvedInstance(pair, { settledYes: null, resolvedAtMs: 1 }, { settledYes: true, resolvedAtMs: 2 }, 0)).toBeNull();
    expect(frozenResolvedInstance(pair, { settledYes: true, resolvedAtMs: 1 }, { settledYes: null, resolvedAtMs: 2 }, 0)).toBeNull();
  });

  test("missing venue timestamps fall back, and the chosen side drives candidatePays", () => {
    const fb = Date.UTC(2026, 0, 1);
    const inst = frozenResolvedInstance(pair, { settledYes: true, resolvedAtMs: null }, { settledYes: false, resolvedAtMs: null }, fb);
    expect(inst!.resolvedAt).toBe(new Date(fb).toISOString());
    // candidate settled NO: a "no" leg PAYS, a "yes" leg does not
    expect(observationsForResolvedInstances("no", [inst!])[0].candidatePays).toBe(true);
    expect(observationsForResolvedInstances("yes", [inst!])[0].candidatePays).toBe(false);
  });
});
