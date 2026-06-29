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

/** Flag-gated few-shot anchoring. DEFAULT OFF (HEDGE_RELATION_FEWSHOT must equal "1"); when off,
 *  returns the base prompt unchanged so elicitation behavior is identical. MODELED-only: the gold
 *  set is used purely as reasoned reference exemplars, never as settlement/CALIBRATED evidence. */
export function withFewShot(basePrompt: string, enabled = process.env.HEDGE_RELATION_FEWSHOT === "1", excludeId?: string): string {
  if (!enabled) return basePrompt;
  const examples = renderFewShot(selectFewShot(RELATION_GOLD, 6, excludeId));
  return `${basePrompt}\n\nWorked examples (anchor -> candidate => relation/direction/mechanism + conditionals):\n${examples}`;
}
