/**
 * lib/relate/candidates.ts — Stage 1: cut the O(N²) pair space down to a meaningful few.
 *
 * Anchor-driven (relations FOR one market), so we never enumerate N² pairs:
 *   (a) STRUCTURAL candidates — the anchor's same-event siblings (mutually-exclusive outcomes).
 *       Surfaced directly; path A will price them exactly. No embedding/LLM needed.
 *   (b) SEMANTIC candidates — cross-event markets, after a metadata hard filter, ranked by a
 *       similarity score (cosine over embeddings when available, else lexical token overlap) and
 *       capped at top-K. Embedding recall finds non-obvious cross-entity links (France ↔ Mbappé)
 *       that lexical overlap misses; lexical is the always-on, key-free baseline.
 */
import { norm } from "@/lib/polymarket/text";
import type { CandidatePair, NormalizedMarket } from "./types";

const DAY = 86_400_000;

/** Metadata HARD filter: same domain, time-window overlap, and a DIFFERENT event (cross-event). */
export function metadataCompatible(a: NormalizedMarket, b: NormalizedMarket, allowCrossCategory = false): boolean {
  if (a.id === b.id) return false;
  if (!allowCrossCategory && a.category !== b.category) return false;
  if (a.eventKey === b.eventKey && a.mutuallyExclusiveEvent && b.mutuallyExclusiveEvent) return false; // exact siblings handled structurally
  // time-window overlap: if both have a resolution time, require them within ~30 days (so one
  // hasn't long settled before the other). Null end dates (common for our reads) pass.
  if (a.endDateMs != null && b.endDateMs != null && Math.abs(a.endDateMs - b.endDateMs) > 30 * DAY) return false;
  return true;
}

function tokenSet(s: string): Set<string> {
  return new Set(norm(s).split(" ").filter((w) => w.length > 1));
}

/** Lexical similarity = Jaccard of description tokens, boosted when entity tokens overlap. */
export function lexicalSimilarity(a: NormalizedMarket, b: NormalizedMarket): number {
  const ta = tokenSet(a.description);
  const tb = tokenSet(b.description);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  const jaccard = inter / (ta.size + tb.size - inter);
  const entityOverlap = a.entityTokens.some((t) => b.entityTokens.includes(t)) ? 0.3 : 0;
  return Math.min(1, jaccard + entityOverlap);
}

export interface CandidateOpts {
  topK?: number;
  /** Optional semantic scorer (cosine over embeddings). When absent, lexical similarity is used. */
  semanticScore?: (a: NormalizedMarket, b: NormalizedMarket) => number;
  minSimilarity?: number;
  /** Required for cross-domain mechanism discovery; classification/calibration remain downstream. */
  allowCrossCategory?: boolean;
}

export interface RecallSelectionOpts {
  topK: number;
  semanticScore?: (a: NormalizedMarket, b: NormalizedMarket) => number;
  llmRecall: NormalizedMarket[] | null;
  allowCrossCategory?: boolean;
  minSimilarity?: number;
  /** Inject up to this many cross-event markets from DISTINCT other events, ignoring similarity, so a combo
   *  can reach dimensions the anchor's own event lacks. The elicited-φ gate downstream still rejects non-hedges. */
  diversityK?: number;
}

/**
 * Cross-event DIVERSITY quota. Similarity recall only surfaces markets that LOOK like the anchor, so a
 * self-contained event (a single match has only its own goals/handicap markets) can never reach other
 * DIMENSIONS. This injects one representative market per DISTINCT other event — similarity ignored, spread
 * across categories/families for maximum dimensional coverage, preferring liquid, hedge-able (mid-priced)
 * markets. It only WIDENS recall; the elicited-φ gate downstream still rejects any that is not a genuine
 * hedge, and cross-domain legs are held to a higher φ bar there.
 */
export function selectDiversityCandidates(anchor: NormalizedMarket, universe: NormalizedMarket[], k: number): CandidatePair[] {
  if (k <= 0) return [];
  const hedgeable = (m: NormalizedMarket) => 0.5 - Math.abs(0.5 - m.probYes); // peaks at 0.5, → 0 at the extremes
  const perEvent = new Map<string, NormalizedMarket>();
  for (const m of universe) {
    if (m.eventKey === anchor.eventKey || !m.liquidityOk) continue;
    if (!metadataCompatible(anchor, m, true)) continue;
    const cur = perEvent.get(m.eventKey);
    if (!cur || hedgeable(m) > hedgeable(cur)) perEvent.set(m.eventKey, m);
  }
  // Round-robin across (category, family) so the sample spans many dimensions, not many events of one kind.
  const reps = [...perEvent.values()].sort((a, b) => hedgeable(b) - hedgeable(a));
  const seen = new Set<string>();
  const spread: NormalizedMarket[] = [];
  const rest: NormalizedMarket[] = [];
  for (const m of reps) {
    const key = `${m.category}|${m.eventFamily}`;
    if (seen.has(key)) rest.push(m);
    else { seen.add(key); spread.push(m); }
  }
  return [...spread, ...rest].slice(0, k).map((b) => ({ a: anchor, b, recall: "diversity" as const, similarity: 0 }));
}

/** Choose exactly one recall path. This prevents a valid semantic ranking from being accidentally
 * replaced by a later lexical regeneration in the orchestration layer. */
export function selectRecallCandidates(
  anchor: NormalizedMarket,
  universe: NormalizedMarket[],
  opts: RecallSelectionOpts,
): CandidatePair[] {
  // Cross-event diversity is merged into whichever recall path runs; on a duplicate market id the
  // similarity-recalled pair wins (it lists last, so it overwrites the diversity stub) because a real
  // similarity is more informative than the diversity placeholder.
  const diversity = selectDiversityCandidates(anchor, universe, opts.diversityK ?? 0);
  const withDiversity = (base: CandidatePair[]) =>
    [...new Map([...diversity, ...base].map((pair) => [pair.b.id, pair])).values()];
  if (opts.semanticScore) {
    return withDiversity(generateCandidates(anchor, universe, {
      topK: opts.topK,
      semanticScore: opts.semanticScore,
      allowCrossCategory: opts.allowCrossCategory,
      minSimilarity: opts.minSimilarity,
    }));
  }
  if (opts.llmRecall !== null) {
    const structural = generateCandidates(anchor, universe, { topK: 0, allowCrossCategory: opts.allowCrossCategory });
    // Also include the lexically-closest CROSS-EVENT markets, not just the LLM's picks. The LLM recall
    // pass routinely overlooks structural complements that share the anchor's theme (a "nation to reach
    // the final" / "golden boot" market for a World Cup winner, a "which party wins" market for a
    // candidate), even though those are the clean hedges. The downstream elicited-φ gate still decides
    // whether each is a genuine hedge, so this only widens recall, it does not relax correctness.
    const lexical = generateCandidates(anchor, universe, {
      topK: opts.topK,
      allowCrossCategory: opts.allowCrossCategory,
      minSimilarity: opts.minSimilarity,
    }).filter((pair) => pair.recall !== "structural");
    const merged = [
      ...structural,
      ...lexical,
      ...opts.llmRecall.slice(0, opts.topK).map((candidate) => ({
        a: anchor,
        b: candidate,
        recall: "llm_recall" as const,
        similarity: Number(lexicalSimilarity(anchor, candidate).toFixed(3)),
      })),
    ];
    return withDiversity([...new Map(merged.map((pair) => [pair.b.id, pair])).values()]);
  }
  return withDiversity(generateCandidates(anchor, universe, {
    topK: opts.topK,
    allowCrossCategory: opts.allowCrossCategory,
    minSimilarity: opts.minSimilarity,
  }));
}

/** Stage 1 for one anchor: structural siblings + top-K cross-event candidates. */
export function generateCandidates(anchor: NormalizedMarket, universe: NormalizedMarket[], opts: CandidateOpts = {}): CandidatePair[] {
  const topK = opts.topK ?? 10;
  const minSim = opts.minSimilarity ?? 0.08;
  const score = opts.semanticScore;
  const recall: CandidatePair["recall"] = score ? "semantic" : "lexical";

  // (a) structural: same single-winner event, different outcome
  const structural: CandidatePair[] = universe
    .filter((m) => m.id !== anchor.id && m.eventKey === anchor.eventKey && anchor.mutuallyExclusiveEvent && m.mutuallyExclusiveEvent)
    .map((b) => ({ a: anchor, b, recall: "structural" as const, similarity: 1 }));

  // (b) semantic/lexical: cross-event, metadata-compatible, top-K by similarity
  const crossEvent = universe
    .filter((b) => metadataCompatible(anchor, b, opts.allowCrossCategory ?? false))
    .map((b) => ({ b, sim: score ? score(anchor, b) : lexicalSimilarity(anchor, b) }))
    .filter((x) => x.sim >= minSim)
    .sort((x, y) => y.sim - x.sim)
    .slice(0, topK)
    .map((x) => ({ a: anchor, b: x.b, recall, similarity: Number(x.sim.toFixed(3)) }));

  return [...structural, ...crossEvent];
}
