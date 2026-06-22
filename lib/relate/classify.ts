/**
 * lib/relate/classify.ts — Stage 2: classify each candidate pair's relation.
 *
 * Structured rules run FIRST (they're exact and free): same single-winner event ⇒ mutually
 * exclusive; same subject + equivalent question ⇒ same; same subject + different question ⇒
 * related. ONLY these deterministic rules may emit an exact structural joint / a numeric estimate.
 * Ambiguous cross-entity pairs fall through to the LLM, UNIFIED on the canonical Qwen layer
 * (lib/association) — whose output is a textual HYPOTHESIS only (never a structural joint or a
 * numeric correlation). With no Qwen key the LLM is skipped and a conservative heuristic fires.
 */
import { partitionsAligned, sameEntityStrict } from "@/lib/link";
import { analyzeRelationWithQwen } from "@/lib/association";
import type { AssociationRelation, RelationHypothesis } from "@/lib/association";
import type { CandidatePair, PairClassification } from "./types";

function sharedEntity(a: string[], b: string[]): boolean {
  return a.some((t) => b.includes(t));
}

/** Structured rules — return a classification when one fires, else null (defer to LLM/heuristic). */
function ruleClassify(pair: CandidatePair): PairClassification | null {
  const { a, b } = pair;
  // R1: same single-winner event, different outcome ⇒ mutually exclusive (exact, path A).
  if (a.eventKey === b.eventKey && a.mutuallyExclusiveEvent && b.mutuallyExclusiveEvent) {
    return {
      relation: "mutually_exclusive",
      direction: "negative",
      reasoning: `"${a.title}" and "${b.title}" are different outcomes of the same market and cannot both be true.`,
      method: "rule",
      structuralJoint: 0,
      structuralKind: "exclusive",
    };
  }
  // R2: same subject across events. Equivalent question ⇒ same; otherwise ⇒ related (correlated).
  if (sharedEntity(a.entityTokens, b.entityTokens)) {
    // "same" (EQUIVALENT) is a STRONG claim — it can drive an ANALYTIC cover-all leg — so it requires
    // STRICT outcome-identity (same normalized token SET, not containment): "Korea Republic"≠"Korea DPR",
    // "United States"≠"United Arab Emirates", "Congo"≠"DR Congo"; PLUS partitionsAligned (winner=winner).
    const sameOutcome = sameEntityStrict(a.title, b.title) && partitionsAligned(a.marketTitle, b.marketTitle);
    if (sameOutcome) {
      return {
        relation: "same",
        direction: "positive",
        reasoning: `"${a.title}" describes the same outcome in both places (${a.marketTitle}); they settle identically.`,
        method: "rule",
        estimateRho: 0.97,
      };
    }
    // Same entity does NOT imply a fixed direction or strength. Defer different questions to the
    // mechanism graph; e.g. "candidate wins" ↔ "candidate is indicted" can be negative, delayed,
    // or share a common cause. Without Qwen, the conservative heuristic remains display-only.
    return null;
  }
  return null;
}

/** Conservative fallback when no LLM: cross-entity pairs default to weak/independent by similarity. */
function heuristicClassify(pair: CandidatePair): PairClassification {
  // Without world knowledge we can't assert a cross-entity link; lean to independent, and only a
  // WEAK positive when the texts genuinely overlap. Honest: a missed link beats a fabricated one.
  if (pair.similarity >= 0.25) {
    return {
      relation: "related",
      direction: "positive",
      reasoning: `"${pair.a.title}" and "${pair.b.title}" are thematically close and may be weakly related (no world knowledge, conservative estimate).`,
      method: "heuristic",
      estimateRho: 0.25,
    };
  }
  return {
    relation: "independent",
    direction: "none",
    reasoning: `"${pair.a.title}" and "${pair.b.title}" have no clear logical link; treated as independent.`,
    method: "heuristic",
  };
}

// Map the canonical Qwen RelationHypothesis label to a DISPLAY-only relation/direction. This is the
// LLM's textual read; it carries NO numeric joint or correlation, so it can never assert an exact
// structural relation — those come only from ruleClassify.
const HYP_RELATION: Record<AssociationRelation, PairClassification["relation"]> = {
  EQUIVALENT: "same",
  MUTEX: "mutually_exclusive",
  IMPLICATION: "related",
  CAUSAL: "related",
  THEMATIC: "related",
  UNRELATED: "independent",
  AMBIGUOUS: "related",
};
const HYP_DIRECTION: Record<string, PairClassification["direction"]> = { POSITIVE: "positive", NEGATIVE: "negative", AMBIGUOUS: "none" };

/**
 * LLM path — UNIFIED on the canonical Qwen layer (lib/association). The model returns a textual
 * HYPOTHESIS only: it MUST NOT set structuralJoint / structuralKind / a numeric estimateRho. So an
 * LLM "MUTEX" or "EQUIVALENT" is a labeled, speculative hypothesis (provenance HYPOTHESIS), never an
 * exact joint — it becomes an actionable hedge leg only after settlement calibration in the optimizer.
 */
/** Map a Qwen hypothesis to a HYPOTHESIS-only classification. PURE + exported so the honesty
 *  invariant (no structuralJoint / structuralKind / estimateRho from the LLM) is unit-testable. */
export function hypothesisToClassification(h: RelationHypothesis): PairClassification {
  return {
    relation: HYP_RELATION[h.relation],
    direction: HYP_DIRECTION[h.direction] ?? "none",
    reasoning: h.mechanism.slice(0, 200),
    method: "llm",
    hypothesis: h,
    // INVARIANT: structuralJoint / structuralKind / estimateRho are intentionally LEFT UNSET.
  };
}

async function llmClassify(pair: CandidatePair): Promise<{ classification: PairClassification | null; attempts?: PairClassification["llmAttempts"]; reason?: string }> {
  const res = await analyzeRelationWithQwen(
    { title: `${pair.a.title} — ${pair.a.marketTitle}`, rules: pair.a.resolutionCriteria },
    { title: `${pair.b.title} — ${pair.b.marketTitle}`, rules: pair.b.resolutionCriteria },
  );
  if (res.status !== "ok" || !res.hypothesis) {
    if (res.status === "error") console.error(`[llmClassify] ${pair.a.title}↔${pair.b.title}: ${res.reason}`);
    return { classification: null, attempts: res.attempts, reason: res.reason }; // disabled/error ⇒ heuristic
  }
  return {
    classification: {
      ...hypothesisToClassification(res.hypothesis),
      llmModel: res.model,
      llmAttempts: res.attempts,
      llmCacheHit: res.cached,
    },
    attempts: res.attempts,
  };
}

/** Classify one candidate pair: rules → LLM → heuristic. */
export async function classifyPair(pair: CandidatePair): Promise<PairClassification> {
  const ruled = ruleClassify(pair);
  if (ruled) return ruled;
  const llm = await llmClassify(pair);
  if (llm.classification) return llm.classification;
  return { ...heuristicClassify(pair), llmAttempts: llm.attempts, llmFailureReason: llm.reason };
}
