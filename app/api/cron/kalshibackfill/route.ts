import { NextResponse } from "next/server";
import { runKalshiBackfill } from "@/lib/relate/kalshiBackfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Self-sustaining Kalshi historical discovery (second venue). Scans settled Kalshi events and ingests the
 * structurally-guaranteed relations (2-way exclusive rivals, cumulative-threshold subsets) with NO manual
 * manifest. Idempotent, CRON_SECRET-gated. Lower-yield than Polymarket (sparse settled-market history), so
 * run it daily/weekly to catch newly-settled events.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!process.env.DATABASE_URL) return NextResponse.json({ ok: true, note: "DATABASE_URL not set; nothing to persist" });
  try {
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get("limit") ?? 1000);
    const maxJobs = Number(url.searchParams.get("maxJobs") ?? 1500);
    const series = url.searchParams.get("series") ?? undefined;
    const r = await runKalshiBackfill({ limit, maxJobs, series });
    return NextResponse.json({
      ok: r.errors === 0,
      scannedEvents: r.scannedEvents,
      jobs: r.jobs,
      written: r.written,
      skipped: r.skipped,
      errors: r.errors,
      byStructure: r.byStructure,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "kalshi backfill failed" }, { status: 500 });
  }
}
