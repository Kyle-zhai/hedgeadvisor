/**
 * app/api/cron/snapshot/route.ts — the proprietary-history moat (Vercel Cron).
 *
 * Sweeps the default event's tokens and persists best bid/ask/midpoint/depth to
 * book_snapshot. No-ops gracefully if DATABASE_URL is unset (the app still works;
 * the moat just doesn't accrue). Resolved markets lose fine granularity, so this
 * must run DURING the tournament — capture-or-lose-it.
 *
 * Schedule via vercel.json: { "crons": [{ "path": "/api/cron/snapshot", "schedule": "* * * * *" }] }
 */
import { NextResponse } from "next/server";
import { fetchEventBundle, fetchBooks } from "@/lib/polymarket";
import { getSql, dbEnabled, ensureSchema } from "@/lib/data/db";
import { notionalDepth } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_SLUG = process.env.HEDGE_DEFAULT_EVENT_SLUG ?? "world-cup-winner";

export async function GET(req: Request) {
  // Auth: FAIL CLOSED. A missing/empty CRON_SECRET denies all requests (so a forgotten
  // env var disables the endpoint rather than exposing it). Vercel Cron sends this header.
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let bundle;
  try {
    bundle = await fetchEventBundle(DEFAULT_SLUG);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "upstream error";
    return NextResponse.json({ ok: false, reason }, { status: 502 });
  }
  if (!bundle) return NextResponse.json({ ok: false, reason: "event not found" }, { status: 404 });

  // YES tokens only for the curve (NO = 1 - YES for binaries).
  const tokenIds = bundle.markets.filter((m) => !m.resolved).map((m) => m.tokenIdYes);
  const books = await fetchBooks(tokenIds);

  if (!dbEnabled()) {
    return NextResponse.json({
      ok: true,
      persisted: false,
      note: "DATABASE_URL unset — snapshot computed but not stored (moat disabled).",
      sampled: books.size,
    });
  }

  const sql = await getSql();
  if (!sql) {
    return NextResponse.json({ ok: true, persisted: false, note: "postgres unavailable", sampled: books.size });
  }

  await ensureSchema(sql);
  const nowIso = new Date().toISOString();
  let written = 0;
  let failed = 0;
  for (const [tokenId, book] of books) {
    try {
      const askDepth1 = notionalDepth(book.asks.filter((l) => l.price <= book.bestAsk + 0.01));
      const bidDepth1 = notionalDepth(book.bids.filter((l) => l.price >= book.bestBid - 0.01));
      await sql`
        INSERT INTO book_snapshot (token_id, ts, best_bid, best_ask, midpoint, spread, ask_depth_1pct, bid_depth_1pct, source)
        VALUES (${tokenId}, ${nowIso}, ${book.bestBid}, ${book.bestAsk}, ${book.midpoint},
                ${book.bestAsk - book.bestBid}, ${askDepth1}, ${bidDepth1}, 'cron')
        ON CONFLICT (token_id, ts) DO NOTHING
      `;
      written++;
    } catch {
      failed++; // skip the bad row, keep sweeping
    }
  }
  return NextResponse.json({ ok: true, persisted: true, written, failed, ts: nowIso });
}
