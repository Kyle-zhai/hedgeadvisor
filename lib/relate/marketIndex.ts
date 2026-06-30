/**
 * lib/relate/marketIndex.ts — #2 first slice: a continuously-refreshed catalog of ALL OPEN markets across
 * both venues (Polymarket + Kalshi). Today the recall in discover.ts only sees a fixed top-N PM-event fetch,
 * so coverage is a SAMPLE. This builds the full index so a later step can have recall draw candidates from it.
 *
 * THIS SLICE only POPULATES the index (data accrual first) — it does NOT change recall yet. Idempotent
 * (PK venue+market_id), CRON-driven. Open markets only: nothing here writes settlement evidence; the existing
 * freeze→settle path is untouched.
 */

import { gammaGet } from "@/lib/polymarket/client";
import { listKalshiEvents, fetchKalshiMarkets, type KalshiMarket, type KalshiEventMeta } from "@/lib/kalshi";
import { getSql, ensureSchema } from "@/lib/data/db";

export interface MarketIndexRow {
  venue: "polymarket" | "kalshi";
  marketId: string;
  eventKey: string;
  title: string;
  marketTitle: string;
  category: string;
  status: string;
}

interface PmMarket { conditionId?: string; groupItemTitle?: string; question?: string }
interface PmEvent { slug?: string; title?: string; closed?: boolean; markets?: PmMarket[] }

/** Pure: one open Polymarket event → its OPEN candidate rows (skips closed events / unlabelled markets). */
export function pmEventToIndexRows(ev: PmEvent): MarketIndexRow[] {
  if (!ev.slug || ev.closed) return [];
  return (ev.markets ?? [])
    .filter((m) => m.conditionId && (m.groupItemTitle || m.question))
    .map((m) => ({
      venue: "polymarket" as const,
      marketId: m.conditionId!,
      eventKey: ev.slug!,
      title: (ev.title ?? ev.slug!).slice(0, 300),
      marketTitle: (m.groupItemTitle || m.question || "").trim().slice(0, 300),
      category: "",
      status: "open",
    }));
}

/** Pure: one Kalshi event + its markets → OPEN candidate rows (skips settled). */
export function kalshiToIndexRows(ev: KalshiEventMeta, markets: KalshiMarket[]): MarketIndexRow[] {
  return markets
    .filter((m) => m.ticker && m.result !== "yes" && m.result !== "no")
    .map((m) => ({
      venue: "kalshi" as const,
      marketId: m.ticker,
      eventKey: ev.eventTicker,
      title: (ev.title || ev.eventTicker).slice(0, 300),
      marketTitle: (m.label || "").slice(0, 300),
      category: ev.category,
      status: m.status,
    }));
}

/** Batched idempotent upsert into market_index (PK venue+market_id; refreshes last_seen + mutable fields). */
export async function upsertMarketIndex(rows: MarketIndexRow[]): Promise<number> {
  const sql = await getSql();
  if (!sql || rows.length === 0) return 0;
  await ensureSchema(sql); // create market_index on first use
  // dedupe by (venue, market_id) within the batch so a single upsert never hits the same PK twice
  const byKey = new Map<string, MarketIndexRow>();
  for (const r of rows) if (r.marketId) byKey.set(`${r.venue}:${r.marketId}`, r);
  const unique = [...byKey.values()];
  const COLS = 7;
  let written = 0;
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    // STATIC query (only $-placeholders) + bound params ⇒ no string interpolation of market data.
    const placeholders = chunk.map((_, j) => `($${j * COLS + 1},$${j * COLS + 2},$${j * COLS + 3},$${j * COLS + 4},$${j * COLS + 5},$${j * COLS + 6},$${j * COLS + 7})`).join(",");
    const params = chunk.flatMap((r) => [r.venue, r.marketId, r.eventKey, r.title, r.marketTitle, r.category, r.status]);
    const res = await sql.unsafe(
      `INSERT INTO market_index (venue, market_id, event_key, title, market_title, category, status)
       VALUES ${placeholders}
       ON CONFLICT (venue, market_id) DO UPDATE SET
         event_key = EXCLUDED.event_key, title = EXCLUDED.title, market_title = EXCLUDED.market_title,
         category = EXCLUDED.category, status = EXCLUDED.status, last_seen = now()
       RETURNING market_id`,
      params,
    );
    written += res.length;
  }
  return written;
}

/**
 * Recall over the index: rows whose title/market_title contain ANY of the anchor tokens (cheap prefilter,
 * no price fetch). Caller lexically re-ranks + fetches/normalizes the top events. Open markets only.
 * Parameterized ILIKE ($1..$n); LIMIT is a bounded int. Returns [] when DB/tokens are empty (fail-safe).
 */
export async function queryMarketIndex(tokens: string[], limit = 200): Promise<MarketIndexRow[]> {
  const toks = tokens.map((t) => t.trim()).filter((t) => t.length >= 4).slice(0, 8);
  const sql = await getSql();
  if (!sql || !toks.length) return [];
  await ensureSchema(sql);
  const where = toks.map((_, i) => `(title ILIKE $${i + 1} OR market_title ILIKE $${i + 1})`).join(" OR ");
  const params = toks.map((t) => `%${t}%`);
  const rows = await sql.unsafe(
    `SELECT venue, market_id, event_key, title, market_title, category, status
     FROM market_index WHERE (${where}) ORDER BY last_seen DESC LIMIT ${Math.min(1000, Math.max(1, Math.floor(limit)))}`,
    params,
  ).catch(() => [] as unknown[]);
  return (rows as Array<{ venue: "polymarket" | "kalshi"; market_id: string; event_key: string; title: string; market_title: string; category: string; status: string }>)
    .map((r) => ({ venue: r.venue, marketId: r.market_id, eventKey: r.event_key, title: r.title, marketTitle: r.market_title, category: r.category, status: r.status }));
}

/**
 * Block A radar: PM open rows for ANCHOR enumeration, deterministic order (event_key) for stable rotation.
 * Kalshi excluded (can't anchor today). Returns [] when the DB is absent (fail-safe).
 */
export async function loadIndexAnchorRows(limit = 10000): Promise<Array<{ venue: string; eventKey: string; title: string; marketTitle: string; category: string }>> {
  const sql = await getSql();
  if (!sql) return [];
  await ensureSchema(sql);
  const rows = await sql.unsafe(
    `SELECT venue, event_key, title, market_title, category FROM market_index
     WHERE venue='polymarket' AND status='open' ORDER BY event_key
     LIMIT ${Math.min(20000, Math.max(1, Math.floor(limit)))}`,
  ).catch(() => [] as unknown[]);
  return (rows as Array<{ venue: string; event_key: string; title: string; market_title: string; category: string }>)
    .map((r) => ({ venue: r.venue, eventKey: r.event_key, title: r.title, marketTitle: r.market_title, category: r.category }));
}

export interface MarketIndexResult { pmEvents: number; kalshiEvents: number; rows: number; written: number; errors: number }

async function mapPool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); } }));
  return out;
}

/** Scan OPEN markets across both venues and upsert into market_index. Bounded + offset-rotatable per run. */
export async function runMarketIndex(opts: { pmPages?: number; pmStartPage?: number; kalshiLimit?: number } = {}): Promise<MarketIndexResult> {
  const pmPages = Math.min(40, Math.max(0, opts.pmPages ?? 10));
  const pmStart = Math.max(0, Math.floor(opts.pmStartPage ?? 0));
  const kalshiLimit = Math.min(3000, Math.max(0, opts.kalshiLimit ?? 800));
  const pageSize = 100;
  let errors = 0;

  const rows: MarketIndexRow[] = [];
  let pmEvents = 0;
  for (let p = pmStart; p < pmStart + pmPages; p++) {
    const evs = await gammaGet<PmEvent[]>(`/events?closed=false&active=true&order=volume24hr&ascending=false&limit=${pageSize}&offset=${p * pageSize}`).catch(() => { errors++; return [] as PmEvent[]; });
    if (!evs.length) break;
    pmEvents += evs.length;
    for (const ev of evs) rows.push(...pmEventToIndexRows(ev));
  }

  let kalshiEvents = 0;
  if (kalshiLimit > 0) {
    const kevs = await listKalshiEvents("", kalshiLimit, "open").catch(() => { errors++; return [] as KalshiEventMeta[]; });
    kalshiEvents = kevs.length;
    const perEvent = await mapPool(kevs, 8, async (ev) => {
      const mkts = await fetchKalshiMarkets(ev.eventTicker, false).catch(() => { errors++; return [] as KalshiMarket[]; });
      return kalshiToIndexRows(ev, mkts);
    });
    for (const rs of perEvent) rows.push(...rs);
  }

  const written = await upsertMarketIndex(rows);
  return { pmEvents, kalshiEvents, rows: rows.length, written, errors };
}
