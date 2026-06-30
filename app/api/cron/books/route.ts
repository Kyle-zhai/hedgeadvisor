import { NextResponse } from "next/server";
import { dbEnabled } from "@/lib/data/db";
import { captureFrozenBooks } from "@/lib/relate/frozenBooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Execution-grade book capture for the FROZEN candidate set (Block B), DECOUPLED from the every-minute price
 * snapshot. The snapshot cron sweeps one event's tokens every minute (a fine price curve); this captures up to
 * ~800 distinct frozen candidate books FRESHEST-FIRST on an HOURLY cadence — running 800 fetches every minute
 * inside the 60s snapshot route would never finish. Returns coverage telemetry. Open markets only; no settlement.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!dbEnabled()) return NextResponse.json({ ok: true, persisted: false, note: "DATABASE_URL unset — book moat disabled" });
  const frozen = await captureFrozenBooks().catch((err) => ({ frozenMarkets: 0, written: 0, failed: 0, kalshi: 0, pm: 0, error: err instanceof Error ? err.message : "capture failed" }));
  return NextResponse.json({ ok: true, persisted: true, frozen });
}
