import { RELATION_GOLD, type GoldRelation } from "./relationGold";

/** One high-confidence exemplar per relationType (diverse), excluding an optional held-out id. */
export function selectFewShot(pool: GoldRelation[] = RELATION_GOLD, k = 6, excludeId?: string): GoldRelation[] {
  const eligible = pool.filter((g) => g.id !== excludeId).sort((a, b) => b.label.confidence - a.label.confidence);
  const seen = new Set<string>(); const out: GoldRelation[] = [];
  for (const g of eligible) {
    if (out.length >= k) break;
    if (seen.has(g.relationType)) continue;
    seen.add(g.relationType); out.push(g);
  }
  return out;
}

export function renderFewShot(picks: GoldRelation[]): string {
  return picks.map((g) =>
    `- "${g.anchor.title}" -> "${g.candidate.title}": ${g.label.relation}/${g.label.direction} (${g.label.mechanismType}); ` +
    `pGivenAnchorWins=${g.label.pGivenAnchorWins}, pGivenAnchorFails=${g.label.pGivenAnchorFails}. ` +
    `counterexample: ${g.label.counterexamples[0] ?? "none"}`,
  ).join("\n");
}
