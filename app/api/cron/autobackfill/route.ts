import { NextResponse } from "next/server";
import { runAutoBackfill } from "@/lib/relate/autoBackfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Self-sustaining historical discovery. Scans settled Polymarket multi-outcome events and ingests the
 * structurally-guaranteed relations (mutually-exclusive rivals, threshold-ladder subsets) with NO manual
 * manifest. Idempotent (relation_key+sample_key), so safe to run on a schedule. CRON_SECRET-gated.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!process.env.DATABASE_URL) return NextResponse.json({ ok: true, note: "DATABASE_URL not set; nothing to persist" });
  try {
    const url = new URL(req.url);
    const pages = Number(url.searchParams.get("pages") ?? 8);
    const maxJobs = Number(url.searchParams.get("maxJobs") ?? 200);
    const startPage = Number(url.searchParams.get("startPage") ?? 0); // page deeper into lower-volume settled events
    const r = await runAutoBackfill({ pages, maxJobs, startPage });
    return NextResponse.json({
      ok: r.errors === 0,
      scannedEvents: r.scannedEvents,
      jobs: r.jobs,
      written: r.written,
      skipped: r.skipped,
      errors: r.errors,
      byStructure: r.byStructure,
      sample: r.results.filter((x) => x.status === "written").slice(0, 4).map((x) => ({ id: x.id, relationKey: x.relationKey })),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "autobackfill failed" }, { status: 500 });
  }
}
