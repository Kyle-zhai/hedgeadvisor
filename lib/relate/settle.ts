/**
 * lib/relate/settle.ts — turn RESOLVED outcomes into calibration observations (the data-supply side).
 *
 * Two honesty rules from the design, both fixing real bugs:
 *  - SAMPLE UNIT: an observation is one (event-instance, entity, candidate-contract), so its sampleKey
 *    is UNIQUE — we never drop the 2nd-32nd team of a tournament just because they share a key (that
 *    made the result depend on array order). Idempotency dedups only EXACT-duplicate sampleKeys.
 *  - CLUSTER WEIGHTING: the 32 teams of one tournament are NOT 32 independent samples (same announcer,
 *    same broadcast). Each observation is weighted 1/clusterSize so a whole tournament contributes
 *    total weight 1 — hierarchical calibration, so one event can't manufacture false confidence.
 * The candidate's recorded payoff is the SIDE you would buy (side "no" pays on a NO settle). The
 * automatic resolved-market enumerator that FEEDS this is lib/relate/enumerate.ts.
 */
import type { ObservationInput } from "@/lib/association";
import { relationKey, type RelationRole } from "./relationKey";

export interface ResolvedInstance {
  /** UNIQUE per observation: `${clusterKey}:${entity}:${candidateContract}`. */
  sampleKey: string;
  /** The event INSTANCE this belongs to (e.g. "wc2022") — the cluster for weighting. */
  clusterKey: string;
  anchorPaysYes: boolean; // did the anchor market (team-wins-tournament) settle YES
  candidateYes: boolean; // did the candidate market settle YES
  anchorMarketId?: string;
  candidateMarketId?: string;
  resolvedAt?: string;
}

/** One settled instance → an observation for the chosen hedge side, with a cluster weight. */
export function toObservation(inst: ResolvedInstance, side: "yes" | "no", weight = 1): ObservationInput {
  return {
    sampleKey: inst.sampleKey,
    clusterKey: inst.clusterKey,
    anchorPays: inst.anchorPaysYes,
    candidatePays: side === "no" ? !inst.candidateYes : inst.candidateYes,
    weight,
    anchorMarketId: inst.anchorMarketId,
    candidateMarketId: inst.candidateMarketId,
    resolvedAt: inst.resolvedAt,
  };
}

/**
 * Build the relation_key + per-(cluster, BRANCH)-normalized observations for ONE relation. Pass ALL
 * instances of the relation (across every candidate contract) in a SINGLE call — weighting groups by
 * (clusterKey, anchor-pays branch), so:
 *   - each event instance contributes total weight 1 to the anchor-WINS branch AND 1 to the
 *     anchor-FAILS branch (BALANCED — neither branch needs hundreds of tournaments, fixing the 1/32
 *     vs 31/32 imbalance), and
 *   - many candidate contracts of one event do NOT multiply the weight (fixing the per-contract
 *     amplification when this used to be called once per contract).
 * Effective per-branch sample size then = number of event instances — the honest unit.
 */
export function buildRelationObservations(
  anchorFamily: string,
  candidateFamily: string,
  predicate: string,
  role: RelationRole,
  side: "yes" | "no",
  instances: ResolvedInstance[],
  mechanism?: string,
): { relationKey: string; observations: ObservationInput[] } {
  const key = relationKey(anchorFamily, candidateFamily, predicate, role, side, mechanism);
  return { relationKey: key, observations: observationsForResolvedInstances(side, instances) };
}

export interface SettledOutcome {
  settledYes: boolean | null; // null ⇒ unsettled/ambiguous (the pair is dropped)
  resolvedAtMs: number | null; // true venue resolution time when known
}

/**
 * Pair a FROZEN (relation, side, anchor, candidate) snapshot with both venues' settle outcomes.
 * Cluster = the anchor EVENT instance, so distinct events become distinct clusters (the unit the
 * walk-forward backtest trains across). resolved_at = the LATER of the two true venue resolution
 * times (the pair is only "known" once BOTH settle), falling back to fallbackMs when a venue does
 * not expose a timestamp. Returns null unless BOTH sides are settled (no leakage, no fabrication).
 */
export function frozenResolvedInstance(
  pair: { anchorMarketId: string; candidateMarketId: string; clusterKey: string },
  anchor: SettledOutcome,
  candidate: SettledOutcome,
  fallbackMs: number,
): ResolvedInstance | null {
  if (anchor.settledYes === null || candidate.settledYes === null) return null;
  const ms = Math.max(anchor.resolvedAtMs ?? fallbackMs, candidate.resolvedAtMs ?? fallbackMs);
  return {
    sampleKey: `${pair.clusterKey}:${pair.anchorMarketId}:${pair.candidateMarketId}`,
    clusterKey: pair.clusterKey,
    anchorPaysYes: anchor.settledYes,
    candidateYes: candidate.settledYes,
    anchorMarketId: pair.anchorMarketId,
    candidateMarketId: pair.candidateMarketId,
    resolvedAt: new Date(ms).toISOString(),
  };
}

/** Apply idempotency + per-(cluster, branch) normalization when the relation key was frozen earlier. */
export function observationsForResolvedInstances(
  side: "yes" | "no",
  instances: ResolvedInstance[],
): ObservationInput[] {
  // idempotency: collapse only EXACT-duplicate sampleKeys
  const byKey = new Map<string, ResolvedInstance>();
  for (const inst of instances) if (!byKey.has(inst.sampleKey)) byKey.set(inst.sampleKey, inst);
  const uniq = [...byKey.values()];
  // group size per (cluster, branch) ⇒ each (cluster, branch) sums to weight 1
  const groupSize = new Map<string, number>();
  const gk = (i: ResolvedInstance) => `${i.clusterKey}|${i.anchorPaysYes ? 1 : 0}`;
  for (const inst of uniq) groupSize.set(gk(inst), (groupSize.get(gk(inst)) ?? 0) + 1);
  return uniq.map((inst) => toObservation(inst, side, 1 / (groupSize.get(gk(inst)) || 1)));
}
