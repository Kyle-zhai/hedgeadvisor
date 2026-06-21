import { NextResponse } from "next/server";
import { z } from "zod";
import { dbEnabled } from "@/lib/data/db";
import { discoverRelations } from "@/lib/relate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const Job = z.object({
  query: z.string().min(1).max(160),
  eventSlug: z.string().min(1).max(160).optional(),
  topK: z.number().int().min(1).max(6).default(4),
});

function jobs() {
  const raw = process.env.HEDGE_RELATION_SNAPSHOT_JOBS_JSON;
  if (!raw) return [];
  return z.array(Job).max(20).parse(JSON.parse(raw));
}

/** Periodically freezes the candidate set before outcomes are known. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!dbEnabled()) return NextResponse.json({ error: "DATABASE_URL is not configured" }, { status: 503 });
  let configured;
  try {
    configured = jobs();
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "invalid relation snapshot jobs" }, { status: 500 });
  }
  if (!configured.length) {
    return NextResponse.json({ ok: true, jobs: 0, written: 0, note: "HEDGE_RELATION_SNAPSHOT_JOBS_JSON is empty" });
  }

  const results = [];
  for (const job of configured) {
    try {
      const result = await discoverRelations({ ...job, stakeUsd: 20, conservatism: 0.5, maxLegs: 1 });
      results.push({
        query: job.query,
        eventSlug: job.eventSlug,
        status: result.status,
        relations: result.relations?.length ?? 0,
        written: result.candidateSnapshotsWritten ?? 0,
      });
    } catch (error) {
      results.push({ query: job.query, eventSlug: job.eventSlug, status: "error", error: error instanceof Error ? error.message : "unknown error", written: 0 });
    }
  }
  return NextResponse.json({
    ok: results.every((result) => result.status !== "error"),
    jobs: results.length,
    written: results.reduce((sum, result) => sum + result.written, 0),
    results,
  });
}
