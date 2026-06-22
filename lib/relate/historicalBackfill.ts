import { fetchEventBundle, fetchPricesHistory, tokenSetScore } from "@/lib/polymarket";
import { fetchKalshiHistory, fetchKalshiMarkets } from "@/lib/kalshi";
import { norm } from "@/lib/polymarket/text";
import { pmOutcome, kalshiOutcome } from "./enumerate";
import { buildRelationObservations } from "./settle";
import { upsertAssociationCandidateSnapshots, upsertAssociationObservations, upsertAssociationRelation } from "@/lib/association/store";
import { validateHistoricalAssociationSamples } from "@/lib/association/historical";
import type { RelationRole } from "./relationKey";

export interface HistoricalMarketRef {
  venue: "polymarket" | "kalshi";
  /** Polymarket event slug or Kalshi event ticker. */
  eventKey: string;
  /** Strongly preferred native condition id / market ticker. */
  marketId?: string;
  /** Exact outcome label fallback when ids are unavailable. */
  label?: string;
}

export interface HistoricalBackfillJob {
  id: string;
  clusterKey: string;
  anchor: HistoricalMarketRef;
  candidate: HistoricalMarketRef;
  relation: {
    anchorFamily: string;
    candidateFamily: string;
    predicate: string;
    role: RelationRole;
    side: "yes" | "no";
    mechanismSignature?: string;
    relationDirection?: string;
  };
  leadHours?: number;
}

interface ResolvedHistoricalMarket {
  venue: "polymarket" | "kalshi";
  marketId: string;
  eventKey: string;
  label: string;
  settledYes: boolean;
  resolvedAtMs: number;
  history: Array<{ t: number; p: number }>;
}

export interface HistoricalBackfillResult {
  id: string;
  status: "written" | "skipped" | "error";
  relationKey?: string;
  snapshotsWritten?: number;
  observationsWritten?: number;
  observedAt?: string;
  resolvedAt?: string;
  reason?: string;
}

/** Latest real history point at or before a cutoff. Never falls forward. */
export function historicalPointAtOrBefore(history: Array<{ t: number; p: number }>, cutoffMs: number): { t: number; p: number } | null {
  let best: { t: number; p: number } | null = null;
  for (const point of history) {
    const ms = point.t > 10_000_000_000 ? point.t : point.t * 1000;
    if (!Number.isFinite(ms) || !Number.isFinite(point.p) || point.p <= 0 || point.p >= 1 || ms > cutoffMs) continue;
    if (!best || ms > (best.t > 10_000_000_000 ? best.t : best.t * 1000)) best = point;
  }
  return best;
}

/** A joint snapshot must predate both resolutions. Using the later resolution would leak the
 * already-known outcome of whichever leg settled first. */
export function historicalPairCutoffMs(anchorResolvedAtMs: number, candidateResolvedAtMs: number, leadHours: number): number {
  return Math.min(anchorResolvedAtMs, candidateResolvedAtMs) - leadHours * 3_600_000;
}

function pickByIdOrLabel<T extends { id: string; label: string }>(rows: T[], ref: HistoricalMarketRef): T | null {
  if (ref.marketId) return rows.find((row) => row.id === ref.marketId) ?? null;
  if (!ref.label) return null;
  const exact = rows.filter((row) => norm(row.label) === norm(ref.label!));
  if (exact.length === 1) return exact[0];
  const ranked = rows.map((row) => ({ row, score: tokenSetScore(ref.label!, row.label) })).sort((a, b) => b.score - a.score);
  return ranked[0]?.score >= 0.9 && (ranked[1]?.score ?? 0) < ranked[0].score ? ranked[0].row : null;
}

async function resolveHistoricalMarket(ref: HistoricalMarketRef): Promise<ResolvedHistoricalMarket | null> {
  if (ref.venue === "polymarket") {
    const bundle = await fetchEventBundle(ref.eventKey);
    if (!bundle) return null;
    const picked = pickByIdOrLabel(bundle.markets.map((market) => ({
      id: market.conditionId,
      label: market.groupItemTitle ?? market.question,
      market,
    })), ref);
    if (!picked) return null;
    const settledYes = pmOutcome(picked.market.midpointYes, picked.market.resolved);
    if (settledYes === null || picked.market.resolvedAtMs == null) return null;
    return {
      venue: ref.venue,
      marketId: picked.id,
      eventKey: ref.eventKey,
      label: picked.label,
      settledYes,
      resolvedAtMs: picked.market.resolvedAtMs,
      history: await fetchPricesHistory(picked.market.tokenIdYes),
    };
  }
  const markets = await fetchKalshiMarkets(ref.eventKey, true);
  const picked = pickByIdOrLabel(markets.map((market) => ({ id: market.ticker, label: market.label, market })), ref);
  if (!picked) return null;
  const settledYes = kalshiOutcome(picked.market.result, picked.market.status);
  if (settledYes === null || picked.market.settledAtMs === null) return null;
  const ageDays = Math.ceil(Math.max(0, Date.now() - picked.market.settledAtMs) / 86_400_000);
  return {
    venue: ref.venue,
    marketId: picked.id,
    eventKey: ref.eventKey,
    label: picked.label,
    settledYes,
    resolvedAtMs: picked.market.settledAtMs,
    history: await fetchKalshiHistory(picked.market.ticker, Math.min(3650, Math.max(60, ageDays + 30))),
  };
}

/** Fetch one predeclared historical pair and persist it through the same v5 evidence path as live
 * snapshots. The job contains no outcome fields, so configuration cannot directly inject a winner. */
export async function runHistoricalBackfillJob(job: HistoricalBackfillJob): Promise<HistoricalBackfillResult> {
  try {
    const [anchor, candidate] = await Promise.all([
      resolveHistoricalMarket(job.anchor),
      resolveHistoricalMarket(job.candidate),
    ]);
    if (!anchor || !candidate) return { id: job.id, status: "skipped", reason: "market not found, unresolved, or missing true resolution time" };
    const resolvedAtMs = Math.max(anchor.resolvedAtMs, candidate.resolvedAtMs);
    const leadHours = Math.min(24 * 365, Math.max(24, job.leadHours ?? 168));
    const cutoffMs = historicalPairCutoffMs(anchor.resolvedAtMs, candidate.resolvedAtMs, leadHours);
    const anchorPoint = historicalPointAtOrBefore(anchor.history, cutoffMs);
    const candidatePoint = historicalPointAtOrBefore(candidate.history, cutoffMs);
    if (!anchorPoint || !candidatePoint) return { id: job.id, status: "skipped", reason: "no genuine pre-resolution price for one or both markets" };
    const pointMs = (point: { t: number }) => point.t > 10_000_000_000 ? point.t : point.t * 1000;
    const observedAt = new Date(Math.max(pointMs(anchorPoint), pointMs(candidatePoint))).toISOString();
    const resolvedAt = new Date(resolvedAtMs).toISOString();
    const candidatePrice = job.relation.side === "yes" ? candidatePoint.p : 1 - candidatePoint.p;
    const sample = {
      sampleKey: `${job.clusterKey}:${anchor.marketId}:${candidate.marketId}`,
      clusterKey: job.clusterKey,
      anchorMarketId: anchor.marketId,
      candidateMarketId: candidate.marketId,
      anchorPaysYes: anchor.settledYes,
      candidateYes: candidate.settledYes,
      resolvedAt,
      observedAt,
      anchorProbYes: anchorPoint.p,
      candidatePrice,
    };
    const checked = validateHistoricalAssociationSamples([sample], leadHours);
    if (!checked.accepted.length) return { id: job.id, status: "skipped", reason: checked.rejected[0]?.reason ?? "historical evidence rejected" };
    const built = buildRelationObservations(
      job.relation.anchorFamily,
      job.relation.candidateFamily,
      job.relation.predicate,
      job.relation.role,
      job.relation.side,
      checked.accepted,
      job.relation.mechanismSignature,
    );
    const relationOk = await upsertAssociationRelation({
      relationKey: built.relationKey,
      anchorTemplate: job.relation.anchorFamily,
      candidateTemplate: `${job.relation.candidateFamily}:${job.relation.predicate}:${job.relation.role}`,
      candidateSide: job.relation.side,
    });
    if (!relationOk) return { id: job.id, status: "error", reason: "DATABASE_URL is not configured" };
    const snapshotsWritten = await upsertAssociationCandidateSnapshots([{
      relationKey: built.relationKey,
      observedAt,
      anchorMarketId: anchor.marketId,
      candidateMarketId: candidate.marketId,
      candidateSide: job.relation.side,
      anchorProbYes: anchorPoint.p,
      candidatePrice,
      classificationMethod: "historical_archive_mid",
      relationDirection: job.relation.relationDirection,
      mechanismSignature: job.relation.mechanismSignature,
      anchorEventKey: anchor.eventKey,
      anchorVenue: anchor.venue,
      candidateEventKey: candidate.eventKey,
      candidateVenue: candidate.venue,
    }]);
    const observationsWritten = await upsertAssociationObservations(built.relationKey, built.observations);
    return { id: job.id, status: "written", relationKey: built.relationKey, snapshotsWritten, observationsWritten, observedAt, resolvedAt };
  } catch (error) {
    return { id: job.id, status: "error", reason: error instanceof Error ? error.message : "historical backfill failed" };
  }
}
