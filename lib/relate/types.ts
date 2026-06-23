/**
 * lib/relate/types.ts — the engine's input/output contract (the spec's NormalizedMarket / pipeline).
 *
 * The engine sits between the normalization layer and the φ-relation core: it takes a batch of
 * NormalizedMarket objects (from EITHER venue) and, for the meaningful pairs, outputs the relation
 * type, correlation, hedge signal and confidence. Stage 1 generates candidate pairs (metadata +
 * semantic recall), Stage 2 classifies each, and Stages 3–5 (lib/correlation/relation.ts) quantify.
 */
import type { RelationType } from "@/lib/correlation";
import type { RelationHypothesis } from "@/lib/association";
import type { ModelAttempt } from "@/lib/association/modelFallback";

export type Venue = "polymarket" | "kalshi";

/** One normalized tradable binary market, venue-agnostic. */
export interface NormalizedMarket {
  id: string; // unique: `${venue}:${nativeId}`
  venue: Venue;
  eventKey: string; // grouping key (PM eventSlug / Kalshi event_ticker) — same key ⇒ same outcome group
  /** True only when venue metadata proves outcomes in this event cannot co-occur. */
  mutuallyExclusiveEvent: boolean;
  title: string; // outcome label, e.g. "France"
  marketTitle: string; // the event/group title, e.g. "World Cup Winner"
  description: string; // title + group context, for semantic recall
  resolutionCriteria: string; // resolution rules text — the truth source for "same" judgments
  probYes: number; // de-vigged / mid YES probability in [0,1]
  category: string; // coarse domain tag (e.g. "world-cup"), for the metadata hard filter
  /** Reusable RELATION TEMPLATE (e.g. "tournament_winner", "broadcast_word", "golden_boot"). Two
   *  market INSTANCES with the same family share calibration samples via a stable relation_key. */
  eventFamily: string;
  /** The specific SETTLEMENT predicate within the family (says_champion ≠ first_song ≠ trophy_lift),
   *  so different mechanisms never pool into one calibration key. */
  predicate: string;
  liquidityOk: boolean; // a real, tradable book exists (thin/empty ⇒ false)
  endDateMs: number | null; // resolution time (epoch ms), for time-window overlap
  url: string; // deep link
  /** Normalized entity tokens (team/player), for the structured-rule classifier. */
  entityTokens: string[];
  // ── Execution fields, so a candidate can be priced off the REAL book for the robust optimizer ──
  /** The token/ticker to BUY YES on (PM: clob YES tokenId; Kalshi: market ticker, side=yes). */
  yesTokenId: string;
  /** The token/ticker to BUY NO on (PM: clob NO tokenId; Kalshi: the same market ticker, side=no). */
  noTokenId: string;
  /** PM fee schedule; for Kalshi, feeRate stores 0.07 × the event fee multiplier. */
  feeRate: number;
  feeExponent: number;
  feeTakerOnly: boolean;
}

/** A Stage-1 candidate pair (survived the metadata + semantic filters). */
export interface CandidatePair {
  a: NormalizedMarket;
  b: NormalizedMarket;
  recall: "structural" | "semantic" | "llm_recall" | "lexical" | "diversity"; // how the pair was surfaced
  similarity: number; // cosine (semantic) or token-overlap (lexical); 1 for structural same-event
}

export type RelationDirection = "positive" | "negative" | "none";

/** A Stage-2 classification (before the Stage-3 quantification). */
export interface PairClassification {
  relation: RelationType;
  direction: RelationDirection;
  reasoning: string;
  method: "rule" | "llm" | "heuristic";
  // INVARIANT: structuralJoint / structuralKind / estimateRho may be set ONLY by the deterministic
  // ruleClassify path — NEVER by the LLM. The LLM produces a textual `hypothesis` only (provenance
  // HYPOTHESIS), mirroring `OptimizerCandidate.structuralCoverage` ("LLM output must never set it").
  structuralJoint?: number; // exact joint when derivable (exclusive ⇒ 0, subset ⇒ min)
  structuralKind?: "exclusive" | "same-outcome" | "subset";
  estimateRho?: number; // a stated correlation for the Fréchet-clamped estimate path (rules only)
  /** The Qwen textual hypothesis, when the LLM path classified this pair. Never an exact joint. */
  hypothesis?: RelationHypothesis;
  /** Actual model that produced the hypothesis after ordered failover. */
  llmModel?: string;
  /** Observability only: model attempts are never used as relationship evidence. */
  llmAttempts?: ModelAttempt[];
  llmCacheHit?: boolean;
  llmFailureReason?: string;
}
