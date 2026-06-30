import { NextResponse } from "next/server";
import { dbEnabled } from "@/lib/data/db";
import { loadAssociationBacktestRows, walkForwardAssociationBacktest } from "@/lib/association";
import { walkForwardByBucket } from "@/lib/relate/bucketBacktest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bounded = (raw: string | null, fallback: number, lo: number, hi: number) => {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** Secret-gated, read-only point-in-time backtest over persisted snapshots + resolutions. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!dbEnabled()) return NextResponse.json({ error: "DATABASE_URL is not configured" }, { status: 503 });

  const url = new URL(req.url);
  const minLeadHours = bounded(url.searchParams.get("minLeadHours"), 24, 0, 24 * 365);
  const minSamplesPerBranch = Math.floor(bounded(url.searchParams.get("minSamplesPerBranch"), 20, 2, 10_000));
  const credibleLevel = bounded(url.searchParams.get("credibleLevel"), 0.95, 0.5, 0.999);
  const maxRows = Math.floor(bounded(url.searchParams.get("maxRows"), 10_000, 1, 100_000));
  const forecastLimit = Math.floor(bounded(url.searchParams.get("forecastLimit"), 100, 0, 1_000));

  // grain=bucket reproduces the engine's ACTUAL calibration grain (role|mech|dir|side) — the per-relationKey
  // default is too sparse to clear the gate, so this is the meaningful credibility view (matches tuningProfile).
  const grain = url.searchParams.get("grain") === "bucket" ? "bucket" : "relation";
  const rows = await loadAssociationBacktestRows(minLeadHours, maxRows);
  if (grain === "bucket") {
    const result = walkForwardByBucket(rows, { credibleLevel, minSamplesPerBranch });
    return NextResponse.json({ ok: true, grain, parameters: { minLeadHours, minSamplesPerBranch, credibleLevel, maxRows }, ...result });
  }
  const result = walkForwardAssociationBacktest(rows, { credibleLevel, minSamplesPerBranch });
  return NextResponse.json({
    ok: true,
    grain,
    parameters: { minLeadHours, minSamplesPerBranch, credibleLevel, maxRows },
    ...result,
    forecasts: forecastLimit ? result.forecasts.slice(-forecastLimit) : [],
  });
}
