/**
 * lib/relate/graphGuards.ts — Gate 4: deterministic honesty guards over the LLM's mechanismGraph, plus
 * §13 operator-ontology coverage accounting.
 *
 * Until now two §13 rejections existed ONLY in the prompt (zero code enforcement):
 *   N3 shared resolution source — anchor & candidate settle off the SAME feed/authority (RESOLVES_WITH):
 *       a source error hits both, so the "hedge" fails exactly on the tail events it exists for.
 *   P3 collider — anchor→E←candidate: marginally ≈ independent; any association is an artifact of
 *       conditioning/selection on the common effect (Berkson). Not a hedge basis.
 * These guards VETO (drop) — they never admit, never size, never promote a tier. A veto can only remove a
 * leg, so a missing/incomplete LLM graph simply means no veto (the guard is only as complete as the graph;
 * that caveat is §18#3's, and it still strictly improves on prompt-only).
 *
 * Coverage accounting maps each classified relation onto its §13 operator row and reports the EMPTY rows
 * as an explicit uncovered vector — descriptive only, mirrors the /protect uncovered-failure-state idea.
 */
import type { MechanismGraph } from "@/lib/association";

// Directed-influence edge kinds (can form a collider); SHARES_DRIVER/RESOLVES_WITH/SIGNALS are not arrows.
const DIRECTED = new Set(["CAUSES", "ENABLES", "INHIBITS"]);

/** Find the anchor/candidate node ids (prompt uses anchor_event/candidate_event; fall back to order). */
function endpoints(g: MechanismGraph): { a: string; c: string } | null {
  const nodes = g.nodes ?? [];
  if (nodes.length < 2) return null;
  const find = (re: RegExp) => nodes.find((n) => re.test(n.id) || re.test(n.label ?? ""))?.id;
  const a = find(/anchor/i) ?? nodes[0].id;
  const c = find(/cand/i) ?? nodes.find((n) => n.id !== a)?.id;
  return c && a !== c ? { a, c } : null;
}

/** N3: the graph asserts anchor and candidate share a settlement/resolution source. */
export function sharesResolutionSource(g?: MechanismGraph): boolean {
  if (!g?.edges?.length) return false;
  const ep = endpoints(g);
  if (!ep) return false;
  return g.edges.some((e) => e.kind === "RESOLVES_WITH"
    && ((e.from === ep.a && e.to === ep.c) || (e.from === ep.c && e.to === ep.a)));
}

/**
 * P3: pure collider topology — anchor and candidate BOTH point (directed influence) into a common effect
 * node, with NO direct edge of any kind between them. Marginal dependence ≈ 0; reject as a hedge basis.
 */
export function isColliderTopology(g?: MechanismGraph): boolean {
  if (!g?.edges?.length) return false;
  const ep = endpoints(g);
  if (!ep) return false;
  const direct = g.edges.some((e) =>
    (e.from === ep.a && e.to === ep.c) || (e.from === ep.c && e.to === ep.a));
  if (direct) return false;
  const froms = (to: string) => new Set(g.edges!.filter((e) => DIRECTED.has(e.kind) && e.to === to).map((e) => e.from));
  return (g.nodes ?? []).some((n) => {
    if (n.id === ep.a || n.id === ep.c) return false;
    const s = froms(n.id);
    return s.has(ep.a) && s.has(ep.c);
  });
}

/** The single veto entry point. Null = no veto; otherwise the reason (for diagnostics). */
export function graphVeto(g?: MechanismGraph): "shared_resolution_source" | "collider" | null {
  if (sharesResolutionSource(g)) return "shared_resolution_source";
  if (isColliderTopology(g)) return "collider";
  return null;
}

// ── §13 operator-ontology coverage accounting (descriptive only) ─────────────────────────────────────────

/** The fixed §13 operator rows. W1 part-whole is currently undetectable from LLM output and will honestly
 *  show as uncovered rather than being silently absorbed into another row. */
export const OPERATOR_ROWS = [
  "L1_equivalence", "L2_implication", "L3_mutex", "L5_partial_overlap",
  "C1_cause", "C2_enable", "C3_prevent", "C4_motivate",
  "P1_common_cause", "P2_chain", "P3_collider",
  "N1_proxy", "N2_narrative", "N3_shared_source",
  "W1_part_whole", "W2_substitute", "W3_complement",
] as const;
export type OperatorRow = (typeof OPERATOR_ROWS)[number] | "OTHER";

export interface RelationSignals {
  relation?: string;       // EQUIVALENT | MUTEX | IMPLICATION | CAUSAL | THEMATIC | ...
  direction?: string;      // POSITIVE | NEGATIVE | ...
  mechanismType?: string;  // IDENTITY | LOGICAL | CAUSAL | BEHAVIORAL | ECONOMIC | ... (association enum)
  graph?: MechanismGraph;
}

/** Map one classified relation onto its §13 operator row (deterministic; priority = specificity). */
export function operatorOf(sig: RelationSignals): OperatorRow {
  const rel = (sig.relation ?? "").toUpperCase();
  const mech = (sig.mechanismType ?? sig.graph?.mechanismType ?? "").toUpperCase();
  const neg = (sig.direction ?? "").toUpperCase() === "NEGATIVE";
  const kinds = new Set((sig.graph?.edges ?? []).map((e) => e.kind));
  if (sharesResolutionSource(sig.graph)) return "N3_shared_source";
  if (isColliderTopology(sig.graph)) return "P3_collider";
  if (rel === "EQUIVALENT" || mech === "IDENTITY") return "L1_equivalence";
  if (rel === "MUTEX") return "L3_mutex";
  if (rel === "IMPLICATION" || kinds.has("IMPLIES")) return "L2_implication";
  if (mech === "COMMON_CAUSE" || kinds.has("SHARES_DRIVER")) return "P1_common_cause";
  if (mech === "INFORMATION" || kinds.has("SIGNALS")) return "N1_proxy";
  if (mech === "NARRATIVE") return "N2_narrative";
  if (mech === "BEHAVIORAL" || mech === "INSTITUTIONAL") return "C4_motivate";
  if (mech === "ECONOMIC") return neg ? "W2_substitute" : "W3_complement";
  if (mech === "CAUSAL" || rel === "CAUSAL") {
    if (isChain(sig.graph)) return "P2_chain";
    if (kinds.has("INHIBITS") || neg) return "C3_prevent";
    if (kinds.has("ENABLES")) return "C2_enable";
    return "C1_cause";
  }
  if (mech === "LOGICAL") return "L5_partial_overlap";
  return "OTHER";
}

/** A→M→C mediated chain (anchor reaches candidate only through an intermediate node). */
function isChain(g?: MechanismGraph): boolean {
  if (!g?.edges?.length) return false;
  const ep = endpoints(g);
  if (!ep) return false;
  const direct = g.edges.some((e) => e.from === ep.a && e.to === ep.c);
  if (direct) return false;
  const outs = new Set(g.edges.filter((e) => DIRECTED.has(e.kind) && e.from === ep.a).map((e) => e.to));
  return g.edges.some((e) => DIRECTED.has(e.kind) && outs.has(e.from) && e.to === ep.c);
}

/** Tally relations by operator row + list the EMPTY rows (the explicit uncovered vector). */
export function tallyOperators(rels: RelationSignals[]): { operators: Record<string, number>; uncovered: string[] } {
  const operators: Record<string, number> = {};
  for (const r of rels) {
    const op = operatorOf(r);
    operators[op] = (operators[op] ?? 0) + 1;
  }
  const uncovered = OPERATOR_ROWS.filter((op) => !operators[op]);
  return { operators, uncovered };
}
