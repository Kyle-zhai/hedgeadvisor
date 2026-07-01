import { describe, expect, test } from "vitest";
import { sharesResolutionSource, isColliderTopology, graphVeto, operatorOf, tallyOperators, OPERATOR_ROWS } from "@/lib/relate/graphGuards";
import type { MechanismGraph, MechanismEdgeKind } from "@/lib/association";

type Edge = { from: string; to: string; kind: MechanismEdgeKind };

function mkGraph(edges: Edge[], extraNodes: string[] = [], overrides: Partial<MechanismGraph> = {}): MechanismGraph {
  const nodes = [
    { id: "anchor_event", label: "anchor", kind: "EVENT" as const },
    { id: "candidate_event", label: "candidate", kind: "EVENT" as const },
    ...extraNodes.map((id) => ({ id, label: id, kind: "EVENT" as const })),
  ];
  return {
    anchorEventClass: "a_class", candidateEventClass: "b_class",
    mechanismType: "CAUSAL", scope: "CROSS_DOMAIN", timeOrder: "ANCHOR_BEFORE_CANDIDATE",
    portability: "EVENT_CLASS", nodes, edges, sharedDrivers: [],
    ...overrides,
  };
}

describe("N3 shared resolution source (RESOLVES_WITH)", () => {
  test("vetoes when anchor and candidate resolve off the same source", () => {
    const g = mkGraph([{ from: "anchor_event", to: "candidate_event", kind: "RESOLVES_WITH" }]);
    expect(sharesResolutionSource(g)).toBe(true);
    expect(graphVeto(g)).toBe("shared_resolution_source");
  });

  test("direction-agnostic (candidate → anchor also vetoes)", () => {
    const g = mkGraph([{ from: "candidate_event", to: "anchor_event", kind: "RESOLVES_WITH" }]);
    expect(sharesResolutionSource(g)).toBe(true);
  });

  test("a CAUSES edge does not trigger N3", () => {
    const g = mkGraph([{ from: "anchor_event", to: "candidate_event", kind: "CAUSES" }]);
    expect(sharesResolutionSource(g)).toBe(false);
    expect(graphVeto(g)).toBeNull();
  });

  test("missing graph never vetoes (guard is only as complete as the graph)", () => {
    expect(sharesResolutionSource(undefined)).toBe(false);
    expect(graphVeto(undefined)).toBeNull();
  });
});

describe("P3 collider topology (anchor→E←candidate)", () => {
  test("vetoes the pure collider: both point into a common effect, no direct edge", () => {
    const g = mkGraph([
      { from: "anchor_event", to: "market_rally", kind: "CAUSES" },
      { from: "candidate_event", to: "market_rally", kind: "CAUSES" },
    ], ["market_rally"]);
    expect(isColliderTopology(g)).toBe(true);
    expect(graphVeto(g)).toBe("collider");
  });

  test("a DIRECT edge between anchor and candidate defeats the collider veto", () => {
    const g = mkGraph([
      { from: "anchor_event", to: "market_rally", kind: "CAUSES" },
      { from: "candidate_event", to: "market_rally", kind: "CAUSES" },
      { from: "anchor_event", to: "candidate_event", kind: "CAUSES" },
    ], ["market_rally"]);
    expect(isColliderTopology(g)).toBe(false);
  });

  test("a common CAUSE (fork, SHARES_DRIVER / Z→both) is NOT a collider", () => {
    const fork = mkGraph([
      { from: "regime", to: "anchor_event", kind: "CAUSES" },
      { from: "regime", to: "candidate_event", kind: "CAUSES" },
    ], ["regime"], { mechanismType: "COMMON_CAUSE" });
    expect(isColliderTopology(fork)).toBe(false);
    expect(graphVeto(fork)).toBeNull();
  });

  test("undirected kinds (SIGNALS/SHARES_DRIVER) into a common node do not form a collider", () => {
    const g = mkGraph([
      { from: "anchor_event", to: "narrative", kind: "SIGNALS" },
      { from: "candidate_event", to: "narrative", kind: "SIGNALS" },
    ], ["narrative"]);
    expect(isColliderTopology(g)).toBe(false);
  });
});

describe("§13 operator tagging + coverage accounting", () => {
  test("maps the load-bearing operators deterministically", () => {
    expect(operatorOf({ relation: "EQUIVALENT" })).toBe("L1_equivalence");
    expect(operatorOf({ relation: "MUTEX" })).toBe("L3_mutex");
    expect(operatorOf({ relation: "IMPLICATION" })).toBe("L2_implication");
    expect(operatorOf({ mechanismType: "COMMON_CAUSE" })).toBe("P1_common_cause");
    expect(operatorOf({ mechanismType: "INFORMATION" })).toBe("N1_proxy");
    expect(operatorOf({ mechanismType: "NARRATIVE" })).toBe("N2_narrative");
    expect(operatorOf({ mechanismType: "BEHAVIORAL" })).toBe("C4_motivate");
    expect(operatorOf({ mechanismType: "ECONOMIC", direction: "NEGATIVE" })).toBe("W2_substitute");
    expect(operatorOf({ mechanismType: "ECONOMIC", direction: "POSITIVE" })).toBe("W3_complement");
  });

  test("CAUSAL refines by edge kind / direction: INHIBITS→prevent, ENABLES→enable, else cause", () => {
    const inhibit = mkGraph([{ from: "anchor_event", to: "candidate_event", kind: "INHIBITS" }]);
    expect(operatorOf({ mechanismType: "CAUSAL", graph: inhibit })).toBe("C3_prevent");
    const enable = mkGraph([{ from: "anchor_event", to: "candidate_event", kind: "ENABLES" }]);
    expect(operatorOf({ mechanismType: "CAUSAL", graph: enable })).toBe("C2_enable");
    expect(operatorOf({ mechanismType: "CAUSAL", direction: "POSITIVE" })).toBe("C1_cause");
    expect(operatorOf({ mechanismType: "CAUSAL", direction: "NEGATIVE" })).toBe("C3_prevent");
  });

  test("mediated chain A→M→C tags P2_chain", () => {
    const chain = mkGraph([
      { from: "anchor_event", to: "mediator", kind: "CAUSES" },
      { from: "mediator", to: "candidate_event", kind: "CAUSES" },
    ], ["mediator"]);
    expect(operatorOf({ mechanismType: "CAUSAL", graph: chain })).toBe("P2_chain");
  });

  test("veto classes surface as their own rows (N3/P3 win priority)", () => {
    const n3 = mkGraph([{ from: "anchor_event", to: "candidate_event", kind: "RESOLVES_WITH" }]);
    expect(operatorOf({ relation: "CAUSAL", mechanismType: "CAUSAL", graph: n3 })).toBe("N3_shared_source");
  });

  test("tally reports counts + the EMPTY rows as an explicit uncovered vector", () => {
    const { operators, uncovered } = tallyOperators([
      { relation: "MUTEX" },
      { relation: "MUTEX" },
      { mechanismType: "COMMON_CAUSE" },
    ]);
    expect(operators["L3_mutex"]).toBe(2);
    expect(operators["P1_common_cause"]).toBe(1);
    expect(uncovered).toContain("C2_enable");
    expect(uncovered).toContain("W1_part_whole"); // undetectable today — honestly reported, never absorbed
    expect(uncovered).not.toContain("L3_mutex");
    // uncovered ⊆ the fixed §13 row list
    for (const u of uncovered) expect((OPERATOR_ROWS as readonly string[]).includes(u)).toBe(true);
  });
});
