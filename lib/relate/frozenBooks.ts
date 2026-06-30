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

export interface BookCoverageStats {
  eligibleSnapshots: number;   // frozen candidate snapshots carrying a candidate_token_id (can get an exec price)
  withBook: number;            // … that have a book_snapshot AT/BEFORE observed_at (execution-grade, zero look-ahead)
  coverage: number;            // withBook / eligibleSnapshots
  distinctTokens: number;      // distinct candidate tokens in the eligible set
  tokensWithAnyBook: number;   // … with ANY book_snapshot row (freshness proxy)
}

/**
 * Execution-grade book coverage telemetry (Block B): of the frozen candidate snapshots that carry a
 * candidate_token_id, how many have a book_snapshot at/before observed_at — the EXACT condition the
 * execution-grade backtest joins on. Descriptive only; never sizes/calibrates. Pure SQL, no fetches.
 */
export async function bookCoverageStats(relationPrefix?: string): Promise<BookCoverageStats> {
  const empty: BookCoverageStats = { eligibleSnapshots: 0, withBook: 0, coverage: 0, distinctTokens: 0, tokensWithAnyBook: 0 };
  const sql = await getSql();
  if (!sql) return empty;
  await ensureSchema(sql);
  // Optional relation_key prefix scopes the population (used by tests for isolation; prod calls it unscoped).
  const cond = relationPrefix ? "AND s.relation_key LIKE $1" : "";
  const params = relationPrefix ? [`${relationPrefix}%`] : [];
  const rows = await sql.unsafe(`
    SELECT
      count(*)::int AS eligible,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM book_snapshot b WHERE b.token_id = s.candidate_token_id AND b.ts <= s.observed_at))::int AS with_book,
      count(DISTINCT s.candidate_token_id)::int AS distinct_tokens,
      count(DISTINCT s.candidate_token_id) FILTER (WHERE EXISTS (
        SELECT 1 FROM book_snapshot b WHERE b.token_id = s.candidate_token_id))::int AS tokens_with_any_book
    FROM association_candidate_snapshot s
    WHERE s.candidate_token_id IS NOT NULL ${cond}`, params) as Array<{ eligible: number; with_book: number; distinct_tokens: number; tokens_with_any_book: number }>;
  const r = rows[0];
  const eligibleSnapshots = Number(r?.eligible ?? 0);
  const withBook = Number(r?.with_book ?? 0);
  return {
    eligibleSnapshots, withBook,
    coverage: eligibleSnapshots ? withBook / eligibleSnapshots : 0,
    distinctTokens: Number(r?.distinct_tokens ?? 0),
    tokensWithAnyBook: Number(r?.tokens_with_any_book ?? 0),
  };
}

export interface FrozenBooksResult { frozenMarkets: number; written: number; failed: number; kalshi: number; pm: number; coverage?: BookCoverageStats }

/** Capture books for distinct frozen candidate tokens observed in the last `days`, FRESHEST first (so this
 *  hour's freezes get a book this hour → next hour's re-freeze joins it). Still-likely-open markets only. */
export async function captureFrozenBooks(limit = 800, days = 21): Promise<FrozenBooksResult> {
  const sql = await getSql();
  if (!sql) return { frozenMarkets: 0, written: 0, failed: 0, kalshi: 0, pm: 0 };
  await ensureSchema(sql);
  const rows = await sql`
    SELECT candidate_venue AS venue, candidate_event_key AS event_key, candidate_market_id AS market_id
    FROM association_candidate_snapshot
    WHERE candidate_venue IS NOT NULL AND candidate_market_id IS NOT NULL
      AND observed_at > now() - (${days} * interval '1 day')
    GROUP BY candidate_venue, candidate_event_key, candidate_market_id
    ORDER BY max(observed_at) DESC
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

  const coverage = await bookCoverageStats().catch(() => undefined);
  return { frozenMarkets: rows.length, written, failed, kalshi, pm, coverage };
}
