import { NextResponse } from "next/server";
import { runMarketIndex } from "@/lib/relate/marketIndex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Full-market indexer (#2 first slice). Paginates OPEN Polymarket + Kalshi markets into market_index so
 * relation discovery can later recall from the whole universe rather than a fixed sample. Idempotent,
 * CRON_SECRET-gated. Open markets only — writes no settlement evidence. Rotate ?pmStartPage daily to page deep.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!process.env.DATABASE_URL) return NextResponse.json({ ok: true, note: "DATABASE_URL not set; nothing to persist" });
  try {
    const url = new URL(req.url);
    const pmPages = Number(url.searchParams.get("pmPages") ?? 10);
    const pmStartPage = Number(url.searchParams.get("pmStartPage") ?? 0);
    const kalshiLimit = Number(url.searchParams.get("kalshiLimit") ?? 800);
    const r = await runMarketIndex({ pmPages, pmStartPage, kalshiLimit });
    return NextResponse.json({ ok: r.errors === 0, ...r });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "market index failed" }, { status: 500 });
  }
}
