/**
 * lib/relate/frozenBooks.ts — #3 first slice: execution-grade book capture for the FROZEN candidate set.
 *
 * /api/cron/snapshot today sweeps only the default PM event's YES tokens. But the markets that matter for an
 * execution-grade backtest are the FROZEN anchor/candidate tokens (association_candidate_snapshot) — across
 * BOTH venues. This captures best bid/ask/mid/spread/depth for each still-relevant frozen candidate token into
 * the existing book_snapshot table (which already has those columns), adding Kalshi (zero coverage today) and
 * non-default-event PM. Open markets only; writes price history, never settlement evidence.
 */

import { fetchEventBundle, fetchBooks } from "@/lib/polymarket";
import { fetchKalshiBook } from "@/lib/kalshi";
import { getSql, ensureSchema } from "@/lib/data/db";
import { notionalDepth, type Book } from "@/lib/types";

type Sql = NonNullable<Awaited<ReturnType<typeof getSql>>>;

async function storeBook(sql: Sql, tokenId: string, book: Book, nowIso: string, source: string): Promise<void> {
  const askDepth1 = notionalDepth(book.asks.filter((l) => l.price <= book.bestAsk + 0.01));
  const bidDepth1 = notionalDepth(book.bids.filter((l) => l.price >= book.bestBid - 0.01));
  await sql`
    INSERT INTO book_snapshot (token_id, ts, best_bid, best_ask, midpoint, spread, ask_depth_1pct, bid_depth_1pct, source)
    VALUES (${tokenId}, ${nowIso}, ${book.bestBid}, ${book.bestAsk}, ${book.midpoint},
            ${book.bestAsk - book.bestBid}, ${askDepth1}, ${bidDepth1}, ${source})
    ON CONFLICT (token_id, ts) DO NOTHING`;
}

export interface FrozenBooksResult { frozenMarkets: number; written: number; failed: number; kalshi: number; pm: number }

/** Capture books for distinct frozen candidate tokens observed in the last `days` (still likely open). */
export async function captureFrozenBooks(limit = 400, days = 21): Promise<FrozenBooksResult> {
  const sql = await getSql();
  if (!sql) return { frozenMarkets: 0, written: 0, failed: 0, kalshi: 0, pm: 0 };
  await ensureSchema(sql);
  const rows = await sql`
    SELECT DISTINCT candidate_venue AS venue, candidate_event_key AS event_key, candidate_market_id AS market_id
    FROM association_candidate_snapshot
    WHERE candidate_venue IS NOT NULL AND candidate_market_id IS NOT NULL
      AND observed_at > now() - (${days} * interval '1 day')
    LIMIT ${limit}` as Array<{ venue: string; event_key: string | null; market_id: string }>;
  const nowIso = new Date().toISOString();
  let written = 0, failed = 0, kalshi = 0, pm = 0;

  // Kalshi: the market ticker IS the book key — fetch directly.
  for (const r of rows.filter((r) => r.venue === "kalshi")) {
    try {
      const book = await fetchKalshiBook(r.market_id);
      if (book) { await storeBook(sql, r.market_id, book, nowIso, "frozen-kalshi"); written++; kalshi++; }
    } catch { failed++; }
  }

  // Polymarket: the snapshot stores the conditionId; resolve it to the YES token via the event bundle.
  const pmByEvent = new Map<string, string[]>();
  for (const r of rows.filter((r) => r.venue === "polymarket" && r.event_key)) {
    const list = pmByEvent.get(r.event_key!) ?? [];
    list.push(r.market_id);
    pmByEvent.set(r.event_key!, list);
  }
  for (const [eventKey, condIds] of pmByEvent) {
    try {
      const bundle = await fetchEventBundle(eventKey);
      if (!bundle) continue;
      const tokenByCond = new Map(bundle.markets.filter((m) => !m.resolved).map((m) => [m.conditionId, m.tokenIdYes]));
      const tokenIds = condIds.map((c) => tokenByCond.get(c)).filter((t): t is string => Boolean(t));
      if (!tokenIds.length) continue;
      const books = await fetchBooks(tokenIds);
      for (const [tid, book] of books) { await storeBook(sql, tid, book, nowIso, "frozen-pm"); written++; pm++; }
    } catch { failed++; }
  }

  return { frozenMarkets: rows.length, written, failed, kalshi, pm };
}
