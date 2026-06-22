import { NextResponse } from "next/server";
import { z } from "zod";
import { dbEnabled } from "@/lib/data/db";
import { discoverRelations } from "@/lib/relate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const Job = z.object({
  query: z.string().min(1).max(160),
  eventSlug: z.string().min(1).max(160).optional(),
  topK: z.number().int().min(1).max(6).default(4),
});

// Diverse default collection targets spanning domains, so the calibration training set is NOT
// concentrated in sports or macro (2026-06-22). Used only when HEDGE_RELATION_SNAPSHOT_JOBS_JSON is
// unset; the env var overrides this entirely. Each query is resolved live; an anchor that matches no
// current market no-ops gracefully, so a stale entry just contributes nothing rather than erroring.
const DEFAULT_SNAPSHOT_JOBS: z.infer<typeof Job>[] = [
  { query: "Spain wins the 2026 World Cup", topK: 4 },               // sports — football
  { query: "Lakers win the 2026 NBA championship", topK: 4 },         // sports — basketball
  { query: "Donald Trump job approval above 45 percent", topK: 4 },   // politics — US executive
  { query: "Republicans win the 2026 Senate majority", topK: 4 },     // politics — US legislative
  { query: "Bitcoin above 100000 dollars in 2026", topK: 4 },         // crypto
  { query: "Federal Reserve cuts interest rates in 2026", topK: 4 },  // macro / rates
  { query: "OpenAI releases GPT-5 in 2026", topK: 4 },                // technology / AI
  { query: "2026 Academy Award Best Picture winner", topK: 4 },       // entertainment / awards
];

function jobs() {
  const raw = process.env.HEDGE_RELATION_SNAPSHOT_JOBS_JSON;
  if (!raw) return DEFAULT_SNAPSHOT_JOBS;
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

  const runJob = async (job: z.infer<typeof Job>) => {
    try {
      const result = await discoverRelations({ ...job, stakeUsd: 20, conservatism: 0.5, maxLegs: 1 });
      return {
        query: job.query,
        eventSlug: job.eventSlug,
        status: result.status,
        relations: result.relations?.length ?? 0,
        written: result.candidateSnapshotsWritten ?? 0,
        llm: result.llm,
      };
    } catch (error) {
      return { query: job.query, eventSlug: job.eventSlug, status: "error", error: error instanceof Error ? error.message : "unknown error", written: 0 };
    }
  };
  // MiniMax-M2.5 is thinking-only and materially slower than Qwen Flash. Run independent anchors in
  // bounded parallel batches so one hourly snapshot does not multiply that latency by job count.
  const configuredConcurrency = Number(process.env.HEDGE_RELATION_JOB_CONCURRENCY ?? 8);
  const concurrency = Number.isFinite(configuredConcurrency) ? Math.min(10, Math.max(1, Math.floor(configuredConcurrency))) : 8;
  const results: Awaited<ReturnType<typeof runJob>>[] = [];
  for (let i = 0; i < configured.length; i += concurrency) {
    results.push(...await Promise.all(configured.slice(i, i + concurrency).map(runJob)));
  }
  return NextResponse.json({
    ok: results.every((result) => result.status !== "error"),
    jobs: results.length,
    written: results.reduce((sum, result) => sum + result.written, 0),
    results,
  });
}
