import { NextResponse } from "next/server";
import { z } from "zod";
import { upsertAssociationRelation, upsertAssociationObservations } from "@/lib/association";
import { buildRelationObservations } from "@/lib/relate/settle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ingest RESOLVED-outcome observations into the calibration store (the data-supply side of the loop).
// CRON_SECRET-gated and FAIL-CLOSED, like the snapshot cron. No-ops gracefully without DATABASE_URL.
const Body = z.object({
  anchorFamily: z.string().min(1).max(120),
  candidateFamily: z.string().min(1).max(120),
  predicate: z.string().min(1).max(120),
  role: z.enum(["same_entity", "entity_event", "event_linked", "cross_entity", "cross_domain", "same_team_player", "rival", "global_event", "unrelated"]).default("global_event"),
  mechanismSignature: z.string().regex(/^[a-z0-9_.+=-]+$/).max(240).optional(),
  side: z.enum(["yes", "no"]),
  anchorTemplate: z.string().min(1).max(500),
  candidateTemplate: z.string().min(1).max(500),
  llmModel: z.string().max(120).optional(),
  instances: z.array(z.object({
    sampleKey: z.string().min(1).max(200),
    clusterKey: z.string().min(1).max(200),
    anchorPaysYes: z.boolean(),
    candidateYes: z.boolean(),
    anchorMarketId: z.string().max(200).optional(),
    candidateMarketId: z.string().max(200).optional(),
    resolvedAt: z.string().max(60).optional(),
  })).min(1).max(5000),
});

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request body", issues: parsed.error.flatten() }, { status: 400 });

  const b = parsed.data;
  const { relationKey, observations } = buildRelationObservations(b.anchorFamily, b.candidateFamily, b.predicate, b.role, b.side, b.instances, b.mechanismSignature);
  const relationOk = await upsertAssociationRelation({
    relationKey, anchorTemplate: b.anchorTemplate, candidateTemplate: b.candidateTemplate, candidateSide: b.side, llmModel: b.llmModel,
  });
  if (!relationOk) return NextResponse.json({ ok: true, dbDisabled: true, relationKey, observations: observations.length, written: 0, note: "DATABASE_URL unset — calibration store is dormant" });
  const written = await upsertAssociationObservations(relationKey, observations);
  return NextResponse.json({ ok: true, relationKey, observations: observations.length, written });
}
