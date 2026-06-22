import { dbEnabled } from "@/lib/data/db";
import {
  upsertAssociationCandidateSnapshots,
  upsertAssociationRelation,
  type CandidateSnapshotInput,
} from "@/lib/association";
import type { NormalizedMarket } from "./types";
import type { ClassifiedCandidate } from "./toOptimizerCandidates";
import { mechanismSignature, relationKey, relationRole } from "./relationKey";

const nativeMarketId = (id: string) => id.replace(/^(polymarket|kalshi):/, "");

/**
 * Persist what discovery knew at this moment. This is deliberately separate from settlement
 * ingestion: a future backtest may use a pair only if this evidence predates its resolution.
 */
export async function persistCandidateSnapshots(
  anchor: NormalizedMarket,
  classified: ClassifiedCandidate[],
  at = new Date(),
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
    for (const side of ["yes", "no"] as const) {
      const key = relationKey(graph.anchorEventClass, graph.candidateEventClass, candidate.predicate, role, side, signature);
      await upsertAssociationRelation({
        relationKey: key,
        anchorTemplate: graph.anchorEventClass,
        candidateTemplate: `${graph.candidateEventClass}:${candidate.predicate}:${role}:${signature ?? "instance"}`,
        candidateSide: side,
        hypothesis: cls.hypothesis,
        llmModel: process.env.QWEN_RELATION_MODEL ?? "qwen-plus",
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
      });
    }
  }
  return upsertAssociationCandidateSnapshots(snapshots);
}
