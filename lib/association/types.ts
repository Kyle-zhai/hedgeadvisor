export type AssociationRelation =
  | "EQUIVALENT"
  | "MUTEX"
  | "IMPLICATION"
  | "CAUSAL"
  | "THEMATIC"
  | "UNRELATED"
  | "AMBIGUOUS";

export type AssociationDirection = "POSITIVE" | "NEGATIVE" | "AMBIGUOUS" | "ANCHOR_TO_CANDIDATE" | "CANDIDATE_TO_ANCHOR";

export type MechanismType =
  | "IDENTITY" | "LOGICAL" | "INSTITUTIONAL" | "CAUSAL" | "BEHAVIORAL"
  | "INFORMATION" | "ECONOMIC" | "NARRATIVE" | "TEMPORAL" | "COMMON_CAUSE" | "IMPLICATION" | "OTHER";
export type MechanismScope = "SAME_ENTITY" | "ENTITY_SPECIFIC" | "EVENT_GLOBAL" | "CROSS_ENTITY" | "CROSS_DOMAIN";
export type MechanismTimeOrder = "ANCHOR_BEFORE_CANDIDATE" | "CANDIDATE_BEFORE_ANCHOR" | "OVERLAPPING" | "COMMON_HORIZON" | "UNKNOWN";
export type MechanismPortability = "INSTANCE_ONLY" | "ENTITY_CLASS" | "EVENT_CLASS" | "CROSS_DOMAIN_CLASS";
export type MechanismNodeKind = "ENTITY" | "EVENT" | "CONDITION" | "INSTITUTION" | "OBSERVABLE";
export type MechanismEdgeKind = "CAUSES" | "ENABLES" | "INHIBITS" | "SIGNALS" | "REACTS_TO" | "SHARES_DRIVER" | "RESOLVES_WITH" | "IMPLIES";

/** Canonical metadata + an auditable directed graph. Free text explains; enums define cohorts. */
export interface MechanismGraph {
  /** Entity/date-free snake_case classes, e.g. national_team_title and coach_departure. */
  anchorEventClass: string;
  candidateEventClass: string;
  mechanismType: MechanismType;
  scope: MechanismScope;
  timeOrder: MechanismTimeOrder;
  portability: MechanismPortability;
  nodes: Array<{ id: string; label: string; kind: MechanismNodeKind }>;
  edges: Array<{ from: string; to: string; kind: MechanismEdgeKind }>;
  sharedDrivers: string[];
}

/** LLM output is a hypothesis. It is never a numeric correlation or an execution signal. */
export interface RelationHypothesis {
  relation: AssociationRelation;
  direction: AssociationDirection;
  mechanism: string;
  sharedEntities: string[];
  counterexamples: string[];
  confidence: number;
  requiresCalibration: boolean;
  /** Required from new Qwen responses; optional only for stored v3/backward-compatible records. */
  mechanismGraph?: MechanismGraph;
}

export interface BinaryObservation {
  anchorPays: boolean;
  candidatePays: boolean;
  /** Optional importance/frequency weight. Defaults to one. */
  weight?: number;
}

export interface ConditionalCounts {
  anchorPayCandidatePay: number;
  anchorPayCandidateNoPay: number;
  anchorNoPayCandidatePay: number;
  anchorNoPayCandidateNoPay: number;
}

export interface ProbabilityInterval {
  mean: number;
  lower: number;
  upper: number;
  alpha: number;
  beta: number;
  samples: number;
}

export interface ConditionalCalibration {
  method: "beta-binomial-jeffreys";
  credibleLevel: number;
  payGivenAnchorPays: ProbabilityInterval;
  payGivenAnchorFails: ProbabilityInterval;
  /** Conservative separation: fail lower bound minus win upper bound. */
  hedgeSpecificityLower: number;
  posteriorSpecificity: number;
  sufficientEvidence: boolean;
}

export type AssociationProvenance = "ANALYTIC" | "CALIBRATED" | "HYPOTHESIS";

export interface OptimizerCandidate {
  id: string;
  label: string;
  venue: "polymarket" | "kalshi";
  side: "yes" | "no";
  /** Executable all-in price per $1 payout, including fees. */
  price: number;
  /** Hard liquidity/capacity limit. Omit for no additional candidate-specific cap. */
  maxSpendUsd?: number;
  provenance: AssociationProvenance;
  calibration?: ConditionalCalibration;
  /** Mutually redundant execution alternatives (e.g. YES/NO choice or same relation template). */
  associationGroup?: string;
  /** Only verified structural logic may set this. LLM output must never set it. */
  structuralCoverage?: "ALL_ANCHOR_FAIL_STATES";
  /** Structurally-DERIVED conditional payoff for legs that are logically certain but do NOT cover all
   *  fail states (mutually-exclusive rival, subset/implication). Computed from the rules + current
   *  prices, never from the LLM and never from settlement history — honest at launch without
   *  calibration. The premium still increases strict worst-case loss (it can pay 0 in a fail state),
   *  but the MODELED conditional payoff is certain. */
  structuralPayoff?: { payGivenFail: number; payGivenWin: number };
  /** INFERRED conditional payoff for a cross-event/cross-domain mechanism leg that has a coherent Qwen
   *  mechanism graph but NO settlement calibration. The edge is ASSUMED (scaled by the LLM's stated
   *  confidence), not proven — so it is admitted ONLY at lower conservatism, ranks below structural/
   *  calibrated legs, is capped in count, and is always labeled "inferred / low-confidence". Honest
   *  about its basis, never presented as guaranteed or calibrated. */
  inferredPayoff?: { payGivenFail: number; payGivenWin: number; confidence: number };
}

export interface RobustOptimizerInput {
  stakeUsd: number;
  primaryPrice: number;
  /** Fraction of unhedged profit that must remain in every primary-win state. */
  keepFraction: number;
  /** 0=model mean, 1=credible-bound/strictest admissibility. */
  conservatism: number;
  candidates: OptimizerCandidate[];
  maxLegs?: number;
  /** Until a joint settlement model exists, default to at most one probabilistic soft leg. */
  maxCalibratedSoftLegs?: number;
}

export interface RobustAllocation {
  candidateId: string;
  label: string;
  venue: "polymarket" | "kalshi";
  side: "yes" | "no";
  spendUsd: number;
  shares: number;
  effectivePayGivenFail: number;
  effectivePayGivenWin: number;
  modeledLossReductionUsd: number;
  provenance: AssociationProvenance;
}

export interface RobustOptimizerResult {
  status: "RECOMMEND" | "NO_ACTION";
  reason: string;
  conservatism: number;
  budgetUsd: number;
  spendUsd: number;
  keepIfPrimaryWinsFloorUsd: number;
  modeledLossIfPrimaryFailsUsd: number;
  /** True adversarial floor: calibrated legs may all fail to pay. */
  strictWorstLossIfPrimaryFailsUsd: number;
  allocations: RobustAllocation[];
  rejected: Array<{ candidateId: string; reason: string }>;
}

export interface MarketRuleInput {
  title: string;
  rules: string;
  closeTime?: string;
}
