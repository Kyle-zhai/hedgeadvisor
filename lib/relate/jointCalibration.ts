/**
 * lib/relate/jointCalibration.ts — Phase 5 of the joint-combo roadmap
 * (docs/settlement-moat-and-joint-combo-calibration.md, Part II).
 *
 * Two pieces, both DORMANT until combo settlement evidence accrues:
 *   1. learnedOverlapPenalty() — replaces the Phase-2/3 rule-based overlap prior with a penalty LEARNED from
 *      realized pairwise co-payment, reliability-shrunk toward that prior. Below the sample floor it returns
 *      the prior unchanged, so the engine degrades gracefully to the conservative rule today.
 *   2. jointCalibratedGate() — decides whether a combo FAMILY has earned the JOINT-CALIBRATED tier. With no
 *      data every check fails, so it returns { eligible: false } — the product must NOT show JOINT-CALIBRATED
 *      before joint settlement evidence exists (a non-negotiable honesty rule from the doc).
 *
 * HONESTY: nothing here promotes a tier on model judgment; promotion requires settled, cluster-disjoint,
 * walk-forward combo evidence. Learned penalties only ever refine the conservative prior, never invent edge.
 */

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Realized pairwise co-payment for one bucket pair, conditioned on the anchor FAILING (the only regime that
 *  matters for a hedge). All counts must be effective-INDEPENDENT-cluster counts, not raw rows (cluster-dedup). */
export interface PairwiseOverlapEvidence {
  /** anchor-fail episodes where leg A paid. */ aPaidClusters: number;
  /** of those, episodes where B ALSO paid. */ bothPaidClusters: number;
}

/**
 * Learned overlap penalty in [0,1] = realized P(B pays | A pays, anchor fails) — i.e. how redundant B is once
 * A has fired — reliability-shrunk toward the conservative rule prior. Returns the prior unchanged until at
 * least `minClusters` independent fail-episodes where A paid (otherwise the estimate is noise).
 */
export function learnedOverlapPenalty(ev: PairwiseOverlapEvidence, prior: number, minClusters = 30): number {
  if (ev.aPaidClusters < minClusters) return clamp01(prior);
  const realized = ev.bothPaidClusters / ev.aPaidClusters;
  const w = ev.aPaidClusters / (ev.aPaidClusters + minClusters); // reliability weight
  return clamp01(w * realized + (1 - w) * prior);
}

/** Settlement-proven evidence for a combo FAMILY (all counts cluster-deduped, walk-forward). */
export interface ComboFamilyEvidence {
  effectiveClusters: number;          // independent fail-episodes backing the family
  realizedCoverageLower: number;      // combo's conservative realized P(≥1 leg pays | anchor fails)
  bestSingleLegLower: number;         // best single leg's conservative realized coverage (the bar to beat)
  secondLegMarginalContribution: number; // realized extra coverage the 2nd leg added (must be > 0)
  premiumDragFraction: number;        // premium drag ÷ kept-if-win target (≤ 1 acceptable)
  walkForwardEce: number;             // calibration error of predicted vs realized coverage
  maxSingleClusterShare: number;      // largest fraction one cluster contributes (≤ 0.5 = not dominated)
}

export interface JointGateResult { eligible: boolean; reasons: string[]; }

export interface JointGateThresholds {
  minClusters?: number; maxDragFraction?: number; maxEce?: number; maxClusterShare?: number;
}

/**
 * JOINT-CALIBRATED promotion gate (doc Part II). Returns the list of FAILED checks; eligible = none failed.
 * Conservative by construction — any missing/insufficient evidence keeps the combo at CALIBRATED-leg or MODELED.
 */
export function jointCalibratedGate(e: ComboFamilyEvidence, t: JointGateThresholds = {}): JointGateResult {
  const minClusters = t.minClusters ?? 100;
  const maxDrag = t.maxDragFraction ?? 1.0;
  const maxEce = t.maxEce ?? 0.1;
  const maxClusterShare = t.maxClusterShare ?? 0.5;
  const reasons: string[] = [];
  if (e.effectiveClusters < minClusters) reasons.push(`only ${e.effectiveClusters} effective clusters (need ${minClusters})`);
  if (!(e.realizedCoverageLower > e.bestSingleLegLower)) reasons.push("combo coverage lower-bound does not beat the best single leg");
  if (!(e.secondLegMarginalContribution > 0)) reasons.push("second leg adds no realized marginal coverage");
  if (e.premiumDragFraction > maxDrag) reasons.push(`premium drag ${e.premiumDragFraction.toFixed(2)} exceeds ${maxDrag}`);
  if (e.walkForwardEce > maxEce) reasons.push(`walk-forward ECE ${e.walkForwardEce.toFixed(2)} exceeds ${maxEce}`);
  if (e.maxSingleClusterShare > maxClusterShare) reasons.push(`one cluster contributes ${(e.maxSingleClusterShare * 100).toFixed(0)}% (max ${maxClusterShare * 100}%)`);
  return { eligible: reasons.length === 0, reasons };
}
