import { NextResponse } from "next/server";
import { z } from "zod";
import { runHistoricalBackfillJob, type HistoricalBackfillJob } from "@/lib/relate/historicalBackfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MarketRef = z.object({
  venue: z.enum(["polymarket", "kalshi"]),
  eventKey: z.string().min(1).max(200),
  marketId: z.string().min(1).max(240).optional(),
  label: z.string().min(1).max(240).optional(),
}).refine((value) => value.marketId || value.label, "marketId or label is required");

const Job = z.object({
  id: z.string().min(1).max(160),
  clusterKey: z.string().min(1).max(200),
  anchor: MarketRef,
  candidate: MarketRef,
  relation: z.object({
    anchorFamily: z.string().min(1).max(120),
    candidateFamily: z.string().min(1).max(120),
    predicate: z.string().min(1).max(160),
    role: z.enum(["same_entity", "entity_event", "event_linked", "cross_entity", "cross_domain", "same_team_player", "rival", "global_event", "unrelated"]),
    side: z.enum(["yes", "no"]),
    mechanismSignature: z.string().regex(/^[a-z0-9_.+=-]+$/).max(240).optional(),
    relationDirection: z.string().max(80).optional(),
  }),
  leadHours: z.number().min(24).max(24 * 365).optional(),
});

function configuredJobs(): HistoricalBackfillJob[] {
  const raw = process.env.HEDGE_HISTORICAL_BACKFILL_JOBS_JSON;
  if (!raw) return [];
  return z.array(Job).max(150).parse(JSON.parse(raw)) as HistoricalBackfillJob[];
}

/** Manual/idempotent historical backfill. Keep this out of the hourly loop: archived prices do not
 * change, and repeated work only consumes venue rate limits. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let jobs: HistoricalBackfillJob[];
  try {
    jobs = configuredJobs();
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "invalid historical backfill configuration" }, { status: 500 });
  }
  if (!jobs.length) return NextResponse.json({ ok: true, jobs: 0, note: "HEDGE_HISTORICAL_BACKFILL_JOBS_JSON is empty" });
  const results = [];
  for (const job of jobs) results.push(await runHistoricalBackfillJob(job));
  return NextResponse.json({
    ok: results.every((result) => result.status !== "error"),
    jobs: results.length,
    written: results.filter((result) => result.status === "written").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    errors: results.filter((result) => result.status === "error").length,
    results,
  });
}

