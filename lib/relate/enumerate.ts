/**
 * lib/relate/enumerate.ts — the resolved-market enumerator's PURE core (the "water source").
 *
 * Turns settled venue markets into paired ResolvedInstances, leakage-safe and dispute-safe:
 *  - settlement outcome is read from the venue's OWN settle state (price→1/0 for Polymarket, result
 *    for Kalshi); anything ambiguous/cancelled/unsettled returns null and is EXCLUDED (never guessed).
 *  - an anchor "team wins tournament" is paired with the tournament-level candidate outcome, one
 *    observation per (cluster, entity, candidate-contract); cluster weighting happens downstream.
 * The cron (app/api/cron/settle) fetches resolved markets and feeds this; persistence needs a DB.
 */
import { norm } from "@/lib/polymarket/text";
import { sameEntityStrict } from "@/lib/link/match";
import type { RelationRole } from "./relationKey";
import type { ResolvedInstance } from "./settle";

export interface MarketOutcome {
  entity: string; // the anchor entity (team) or candidate label
  marketId: string;
  /** true = settled YES, false = settled NO, null = unsettled / cancelled / disputed (EXCLUDED). */
  settledYes: boolean | null;
  /** Anchor entities explicitly referenced by an entity-specific broadcast/event contract. */
  relatedEntities?: string[];
  /** Venue resolution timestamp when known; otherwise first trustworthy settlement-ingestion time. */
  resolvedAt?: string;
}

/** Polymarket settle outcome from a RESOLVED market's YES price (1 ⇒ yes, 0 ⇒ no, else ambiguous). */
export function pmOutcome(midpointYes: number, resolved: boolean): boolean | null {
  if (!resolved || !Number.isFinite(midpointYes)) return null;
  if (midpointYes >= 0.98) return true;
  if (midpointYes <= 0.02) return false;
  return null; // a resolved market that isn't ~0/1 is disputed/odd — exclude rather than guess
}

/** Kalshi settle outcome from the market's result + status. */
export function kalshiOutcome(result: string | undefined, status: string): boolean | null {
  if (!["settled", "finalized", "closed", "determined"].includes(status.toLowerCase())) return null;
  if (result?.toLowerCase() === "yes") return true;
  if (result?.toLowerCase() === "no") return false;
  return null; // cancelled/voided/unknown ⇒ exclude
}

/**
 * Pair resolved anchors with one candidate outcome, ROLE-AWARE so unlike entities never pool:
 *   - global_event (broadcast, team-independent): pair EVERY settled anchor (each team is a sample).
 *   - same_entity: pair ONLY the anchor whose entity matches the candidate (e.g. Spain-wins ↔
 *     Spain-reaches-final), so "Argentina wins ↔ Spain reaches final" is never generated.
 *   - entity_event / event_linked / cross_entity / cross_domain: pair only the anchor entity for
 *     which the mechanism graph was classified. The stable mechanism signature pools comparable
 *     historical pairs later; it never turns every outcome in the event into a match.
 *   - rival / unrelated: pairing is skipped — rivals are structural (ANALYTIC, no calibration needed)
 *     and unrelated player/cross-entity markets (Mbappé-golden-boot ↔ Spain-wins) would be pure noise.
 * Unsettled/cancelled outcomes (null) are dropped on both sides (no leakage, no fabrication).
 */
export function pairResolvedInstances(clusterKey: string, anchorOutcomes: MarketOutcome[], candidate: MarketOutcome, role: RelationRole): ResolvedInstance[] {
  if (candidate.settledYes === null) return [];
  const scoped = ["entity_event", "event_linked", "cross_entity", "cross_domain"].includes(role);
  if (role !== "global_event" && role !== "same_entity" && !scoped) return []; // skip rival/unrelated noise
  const out: ResolvedInstance[] = [];
  for (const a of anchorOutcomes) {
    if (a.settledYes === null) continue;
    if (role === "same_entity" && !sameEntityStrict(a.entity, candidate.entity)) continue;
    if (scoped && !(candidate.relatedEntities ?? []).some((e) => sameEntityStrict(a.entity, e))) continue;
    out.push({
      sampleKey: `${clusterKey}:${norm(a.entity).replace(/\s+/g, "_")}:${candidate.marketId}`,
      clusterKey,
      anchorPaysYes: a.settledYes,
      candidateYes: candidate.settledYes,
      anchorMarketId: a.marketId,
      candidateMarketId: candidate.marketId,
      resolvedAt: candidate.resolvedAt,
    });
  }
  return out;
}
