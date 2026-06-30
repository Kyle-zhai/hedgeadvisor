import { dbEnabled } from "@/lib/data/db";
import {
  upsertAssociationCandidateSnapshots,
  upsertAssociationRelation,
  type CandidateSnapshotInput,
} from "@/lib/association";
import { relationModelChain } from "@/lib/association/modelFallback";
import type { NormalizedMarket } from "./types";
import type { ClassifiedCandidate } from "./toOptimizerCandidates";
import { marketDimension, mechanismSignature, relationKey, relationRole } from "./relationKey";
import { classifyScenarioBucket } from "./scenarioBucket";

const nativeMarketId = (id: string) => id.replace(/^(polymarket|kalshi):/, "");

/** The LLM-elicited conditional prior for a candidate's YES side, captured at freeze time. */
export interface ElicitedPrior { pGivenWins: number; pGivenFails: number; model?: string; confidence?: number }

/**
 * Persist what discovery knew at this moment. This is deliberately separate from settlement
 * ingestion: a future backtest may use a pair only if this evidence predates its resolution.
 * `priors` (keyed by candidate market id) freezes the elicitor's conditional prior so it can later be
 * calibrated against realized outcomes — leakage-safe because it predates settlement.
 */
export async function persistCandidateSnapshots(
  anchor: NormalizedMarket,
  classified: ClassifiedCandidate[],
  at = new Date(),
  priors?: Map<string, ElicitedPrior>,
): Promise<number> {
  if (!dbEnabled()) return 0;
  // Minute buckets make repeated UI refreshes idempotent without erasing the price time series.
  const observedAt = new Date(Math.floor(at.getTime() / 60_000) * 60_000).toISOString();
  const snapshots: CandidateSnapshotInput[] = [];

  for (const { pair, cls } of classified) {
    const graph = cls.hypothesis?.mechanismGraph;
    if (!graph || graph.portability === "INSTANCE_ONLY" || cls.hypothesis?.relation === "UNRELATED") continue;
    const candidate = pair.b;
    const role = relationRole(anchor.title, {
      entity: candidate.title,
      family: candidate.eventFamily,
      context: `${candidate.marketTitle} ${candidate.description} ${candidate.resolutionCriteria}`,
      mechanismGraph: graph,
    });
    if (role === "unrelated" || role === "rival") continue;
    const signature = mechanismSignature(graph, cls.hypothesis?.direction);
    // Freeze combo metadata (#4): which anchor-failure PATH this candidate covers + its orthogonal facet, so
    // future pairwise-overlap / joint-combo backtests have these dimensions on historical evidence. Candidate-
    // level (same for both sides). Descriptive only — never sizes/calibrates.
    const scenarioBucket = classifyScenarioBucket({
      anchorTitle: anchor.title,
      candidateTitle: candidate.title,
      candidateMarketTitle: candidate.marketTitle,
      relation: cls.hypothesis?.relation,
      scope: graph.scope,
      direction: cls.hypothesis?.direction,
      reason: cls.hypothesis?.mechanism,
    });
    const dimension = marketDimension(candidate.marketTitle, candidate.category ?? "");
    // The elicited prior is for the candidate's YES side; the NO side is its complement (1 − p).
    const prior = priors?.get(candidate.id);
    for (const side of ["yes", "no"] as const) {
      const key = relationKey(graph.anchorEventClass, graph.candidateEventClass, candidate.predicate, role, side, signature);
      await upsertAssociationRelation({
        relationKey: key,
        anchorTemplate: graph.anchorEventClass,
        candidateTemplate: `${graph.candidateEventClass}:${candidate.predicate}:${role}:${signature ?? "instance"}`,
        candidateSide: side,
        hypothesis: cls.hypothesis,
        llmModel: cls.llmModel ?? relationModelChain()[0] ?? "MiniMax-M2.5",
      });
      const price = side === "yes" ? candidate.probYes : 1 - candidate.probYes;
      if (!(price > 0 && price < 1)) continue;
      snapshots.push({
        relationKey: key,
        observedAt,
        anchorMarketId: nativeMarketId(anchor.id),
        candidateMarketId: nativeMarketId(candidate.id),
        candidateSide: side,
        anchorProbYes: anchor.probYes,
        candidatePrice: price,
        classificationMethod: cls.method,
        relationDirection: cls.hypothesis?.direction ?? cls.direction,
        mechanismSignature: signature,
        hypothesis: cls.hypothesis,
        // event/venue refs so the settle cron can re-fetch both markets by id (no job re-enumeration)
        anchorEventKey: anchor.eventKey,
        anchorVenue: anchor.venue,
        candidateEventKey: candidate.eventKey,
        candidateVenue: candidate.venue,
        // frozen elicitor prior for THIS side (NO = complement of the elicited YES conditional)
        pGivenFails: prior ? (side === "yes" ? prior.pGivenFails : 1 - prior.pGivenFails) : undefined,
        pGivenWins: prior ? (side === "yes" ? prior.pGivenWins : 1 - prior.pGivenWins) : undefined,
        elicitorModel: prior?.model,
        priorConfidence: prior?.confidence,
        scenarioBucket,
        dimension,
        candidateTokenId: candidate.yesTokenId, // book key (PM yes-token / Kalshi ticker) for execution-grade backtest
      });
    }
  }
  return upsertAssociationCandidateSnapshots(snapshots);
}
