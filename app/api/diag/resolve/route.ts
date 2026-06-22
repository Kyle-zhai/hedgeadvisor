/**
 * app/api/diag/resolve/route.ts — secret-gated resolve-only probe. Calls resolveAnyPosition (no LLM
 * pipeline) so anchor resolution can be checked rapidly across domains (which queries resolve / are
 * ambiguous / not found, and the event slug + outcome labels). Companion to /api/diag/qwen and /stats.
 */
import { NextResponse } from "next/server";
import { resolveAnyPosition } from "@/lib/polymarket";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const q = new URL(req.url).searchParams.get("q") ?? "";
  if (!q) return NextResponse.json({ error: "missing q" }, { status: 400 });
  const r = await resolveAnyPosition(q);
  return NextResponse.json({
    query: q,
    kind: r.kind,
    eventSlug: "eventSlug" in r ? r.eventSlug : null,
    anchor: r.kind === "resolved" ? (r.bundle.markets[r.index]?.groupItemTitle ?? r.bundle.markets[r.index]?.question) : null,
    marketTitle: r.kind === "resolved" || r.kind === "ambiguous" ? r.bundle.title : null,
    candidates: r.kind === "ambiguous" ? r.candidates.map((c) => ({ title: c.title, score: Number(c.score.toFixed(2)) })) : undefined,
    suggestions: r.kind === "not_found" ? r.suggestions : undefined,
  });
}
