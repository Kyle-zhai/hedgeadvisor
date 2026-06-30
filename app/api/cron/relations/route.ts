import { NextResponse } from "next/server";
import { z } from "zod";
import { dbEnabled } from "@/lib/data/db";
import { discoverRelations } from "@/lib/relate";
import { shouldElicit, dayOfYearUTC } from "@/lib/relate/elicitSampling";
import { loadIndexAnchorRows } from "@/lib/relate/marketIndex";
import { selectIndexAnchors } from "@/lib/relate/anchorEnumeration";

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

  // Sampled elicited-prior capture (#5): ?elicitSample=0.25 runs the (costlier) withStrategies elicitation for
  // a deterministic ~1-in-4 anchors so a fraction of snapshots freeze p_given_fails/p_given_wins — enough to
  // later score the MODELED prior's accuracy without paying elicitation on every anchor every hour. Default 0.
  const params = new URL(req.url).searchParams;
  // Query string OR env fallback (HEDGE_*), so the Vercel/GitHub cron works whether or not the platform passes
  // the query string through — the operator can drive it purely from env vars instead.
  const elicitSampleRaw = Number(params.get("elicitSample") ?? process.env.HEDGE_ELICIT_SAMPLE ?? 0);
  const elicitSample = Number.isFinite(elicitSampleRaw) ? Math.min(1, Math.max(0, elicitSampleRaw)) : 0;
  const doy = dayOfYearUTC(Date.now());

  // Block A full-market radar: ?indexAnchors=N enumerates up to N anchors from the FULL market_index (rotated by
  // day-of-year for a moving sweep, diversified across categories, deduped vs configured), so discovery is no
  // longer limited to the configured anchors. Bounded (clamp 0..40); each runs through the same freeze path.
  // Default 12 (radar ON) because Vercel's cron dispatcher STRIPS the query string before the handler runs — so
  // a vercel.json `?indexAnchors=12` would otherwise be lost and the radar would silently never run. Set
  // HEDGE_INDEX_ANCHORS=0 to disable, or any N to tune. The query param still wins where it is delivered.
  const indexAnchorsRaw = Number(params.get("indexAnchors") ?? process.env.HEDGE_INDEX_ANCHORS ?? 12);
  const indexAnchorsN = Number.isFinite(indexAnchorsRaw) ? Math.min(40, Math.max(0, Math.floor(indexAnchorsRaw))) : 0;
  let enumerated: z.infer<typeof Job>[] = [];
  if (indexAnchorsN > 0) {
    const rows = await loadIndexAnchorRows().catch(() => []);
    const configuredSlugs = new Set(configured.map((j) => j.eventSlug).filter(Boolean));
    // Advance the sweep cursor PER HOUR (not per day) striding by N, so each hourly run covers a NEW slice
    // instead of re-enumerating the same N anchors all day — ~24× the index coverage at the same per-run cost.
    const offset = (doy * 24 + new Date().getUTCHours()) * indexAnchorsN;
    enumerated = selectIndexAnchors(rows, { limit: indexAnchorsN, offset }).filter((j) => !configuredSlugs.has(j.eventSlug));
  }
  const allJobs = [...configured, ...enumerated];

  const runJob = async (job: z.infer<typeof Job>, elicit: boolean) => {
    try {
      let result = await discoverRelations({ ...job, stakeUsd: 20, conservatism: 0.5, maxLegs: 1, withStrategies: elicit });
      // For COLLECTION (not a user surface) auto-disambiguate: cross-domain anchors often resolve to
      // "ambiguous" with a clearly-leading candidate (e.g. "Republican Party" in a which-party market).
      // Re-pin the top candidate to the resolved event so the job freezes a real anchor instead of no-op.
      let disambiguatedTo: string | undefined;
      if (result.status === "ambiguous" && result.candidates?.[0] && result.eventSlug) {
        disambiguatedTo = result.candidates[0].title;
        result = await discoverRelations({ query: disambiguatedTo, eventSlug: result.eventSlug, stakeUsd: 20, conservatism: 0.5, maxLegs: 1, withStrategies: elicit });
      }
      return {
        query: job.query,
        eventSlug: job.eventSlug,
        disambiguatedTo,
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
  for (let i = 0; i < allJobs.length; i += concurrency) {
    results.push(...await Promise.all(allJobs.slice(i, i + concurrency).map((job, j) => runJob(job, shouldElicit(elicitSample, i + j, doy)))));
  }
  return NextResponse.json({
    ok: results.every((result) => result.status !== "error"),
    jobs: results.length,
    indexAnchors: enumerated.length,
    elicitSample,
    elicited: allJobs.filter((_, i) => shouldElicit(elicitSample, i, doy)).length,
    written: results.reduce((sum, result) => sum + result.written, 0),
    results,
  });
}
