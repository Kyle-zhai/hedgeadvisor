/**
 * lib/relate/candidates.ts — Stage 1: cut the O(N²) pair space down to a meaningful few.
 *
 * Anchor-driven (relations FOR one market), so we never enumerate N² pairs:
 *   (a) STRUCTURAL candidates — the anchor's same-event siblings (mutually-exclusive outcomes).
 *       Surfaced directly; path 甲 will price them exactly. No embedding/LLM needed.
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
