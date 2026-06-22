import { NextResponse } from "next/server";
import { z } from "zod";
import {
  chronologicalClusterSplit,
  upsertAssociationCandidateSnapshots,
  upsertAssociationObservations,
  upsertAssociationRelation,
  validateHistoricalAssociationSamples,
} from "@/lib/association";
import { buildRelationObservations } from "@/lib/relate/settle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const Sample = z.object({
  sampleKey: z.string().min(1).max(240),
  clusterKey: z.string().min(1).max(240),
  anchorMarketId: z.string().min(1).max(240),
  candidateMarketId: z.string().min(1).max(240),
  anchorPaysYes: z.boolean(),
  candidateYes: z.boolean(),
  resolvedAt: z.string().datetime(),
  observedAt: z.string().datetime(),
  anchorProbYes: z.number().gt(0).lt(1),
  candidatePrice: z.number().gt(0).lt(1),
});

const Body = z.object({
  anchorFamily: z.string().min(1).max(120),
  candidateFamily: z.string().min(1).max(120),
  predicate: z.string().min(1).max(160),
  role: z.enum(["same_entity", "entity_event", "event_linked", "cross_entity", "cross_domain", "same_team_player", "rival", "global_event", "unrelated"]),
  mechanismSignature: z.string().regex(/^[a-z0-9_.+=-]+$/).max(240).optional(),
  relationDirection: z.string().max(80).optional(),
  side: z.enum(["yes", "no"]),
  anchorTemplate: z.string().min(1).max(500),
  candidateTemplate: z.string().min(1).max(500),
  minLeadHours: z.number().min(1).max(24 * 365).default(24),
  samples: z.array(Sample).min(1).max(5000),
});

/** Trusted batch-ingestion surface for archived, pre-resolution evidence. It never fabricates a
 * snapshot timestamp: invalid or late rows are rejected and cannot enter the walk-forward set. */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request body", issues: parsed.error.flatten() }, { status: 400 });
  const body = parsed.data;
  const checked = validateHistoricalAssociationSamples(body.samples, body.minLeadHours);
  if (!checked.accepted.length) {
    return NextResponse.json({ error: "no leakage-safe historical samples", rejected: checked.rejected.slice(0, 100) }, { status: 422 });
  }
  const built = buildRelationObservations(
    body.anchorFamily,
    body.candidateFamily,
    body.predicate,
    body.role,
    body.side,
    checked.accepted,
    body.mechanismSignature,
  );
  const relationOk = await upsertAssociationRelation({
    relationKey: built.relationKey,
    anchorTemplate: body.anchorTemplate,
    candidateTemplate: body.candidateTemplate,
    candidateSide: body.side,
  });
  if (!relationOk) return NextResponse.json({ error: "DATABASE_URL is not configured" }, { status: 503 });
  const snapshots = checked.accepted.map((row) => ({
    relationKey: built.relationKey,
    observedAt: row.observedAt,
    anchorMarketId: row.anchorMarketId,
    candidateMarketId: row.candidateMarketId,
    candidateSide: body.side,
    anchorProbYes: row.anchorProbYes,
    candidatePrice: row.candidatePrice,
    classificationMethod: "historical_archive",
    relationDirection: body.relationDirection,
    mechanismSignature: body.mechanismSignature,
  }));
  const snapshotsWritten = await upsertAssociationCandidateSnapshots(snapshots);
  const observationsWritten = await upsertAssociationObservations(built.relationKey, built.observations);
  const split = chronologicalClusterSplit(checked.accepted);
  return NextResponse.json({
    ok: true,
    relationKey: built.relationKey,
    accepted: checked.accepted.length,
    rejected: checked.rejected.length,
    rejectedRows: checked.rejected.slice(0, 100),
    snapshotsWritten,
    observationsWritten,
    chronologicalSplit: {
      trainRows: split.train.length,
      holdoutRows: split.holdout.length,
      trainClusters: new Set(split.train.map((row) => row.clusterKey)).size,
      holdoutClusters: new Set(split.holdout.map((row) => row.clusterKey)).size,
      cutoff: split.cutoff,
    },
  });
}

