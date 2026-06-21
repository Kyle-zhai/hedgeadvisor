/**
 * lib/kalshi/markets.ts — event / market / orderbook reads over Kalshi's public v2 API.
 *
 * Only confirmed-public endpoints are used:
 *   GET /events?series_ticker=&status=open   → events in a series (the negRisk-equivalent groups)
 *   GET /markets?event_ticker=               → the tradable binary outcomes of one event
 *   GET /markets/{ticker}/orderbook          → depth, normalized via book.ts
 * Prices arrive as decimal-dollar strings; we parse them at this boundary and expose a single
 * yesMid in [0,1] so the cross-venue linker can compare like-for-like against Polymarket mids.
 */
import type { Book } from "@/lib/types";
import { kalshiGet, parsePriceDollars } from "./client";
import { normalizeKalshiBook, type KalshiRawOrderbook } from "./book";

export interface KalshiMarket {
  ticker: string;
  eventTicker: string;
  seriesTicker: string;
  label: string; // outcome label, e.g. "Spain"
  yesBid: number | null;
  yesAsk: number | null;
  yesMid: number | null; // best mid in (0,1), or null if unpriced
  last: number | null;
  rules: string; // resolution text (rules_primary) — used for semantic matching
  status: string;
  result: string; // settle result ("yes" / "no" / "" when unsettled) — for the settlement enumerator
  settledAtMs: number | null; // close/settle time (epoch ms) — for leakage-safe walk-forward ordering
  deepLink: string;
}

export interface KalshiEventMeta {
  eventTicker: string;
  seriesTicker: string;
  title: string;
  subTitle: string;
  mutuallyExclusive: boolean;
  /** Series/event override from Kalshi; 1 is the standard fee schedule. */
  feeMultiplier: number;
  category: string;
}

interface RawMarket {
  ticker?: string;
  event_ticker?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  title?: string;
  yes_bid_dollars?: string | number;
  yes_ask_dollars?: string | number;
  no_bid_dollars?: string | number;
  no_ask_dollars?: string | number;
  last_price_dollars?: string | number;
  status?: string;
  result?: string;
  rules_primary?: string;
  settled_time?: string;
  close_time?: string;
  expiration_time?: string;
}
interface RawEvent {
  event_ticker?: string;
  series_ticker?: string;
  title?: string;
  sub_title?: string;
  mutually_exclusive?: boolean;
  fee_multiplier_override?: number;
  category?: string;
}

/** series ticker is the prefix before the first dash of an event/market ticker. */
export function seriesOf(ticker: string): string {
  return ticker.split("-")[0] ?? ticker;
}

function kalshiDeepLink(seriesTicker: string): string {
  return `https://kalshi.com/markets/${seriesTicker.toLowerCase()}`;
}

function parseMarket(raw: RawMarket): KalshiMarket | null {
  if (!raw.ticker) return null;
  const eventTicker = raw.event_ticker ?? seriesOf(raw.ticker);
  const seriesTicker = seriesOf(raw.ticker);
  // Prefer the YES touch fields; fall back to the NO side (yes_ask = 1 − no_bid, etc.).
  const noBid = parsePriceDollars(raw.no_bid_dollars);
  const noAsk = parsePriceDollars(raw.no_ask_dollars);
  const yesBid = parsePriceDollars(raw.yes_bid_dollars) ?? (noAsk !== null ? 1 - noAsk : null);
  const yesAsk = parsePriceDollars(raw.yes_ask_dollars) ?? (noBid !== null ? 1 - noBid : null);
  const last = parsePriceDollars(raw.last_price_dollars);
  const yesMid = yesBid !== null && yesAsk !== null ? (yesBid + yesAsk) / 2 : last;
  return {
    ticker: raw.ticker,
    eventTicker,
    seriesTicker,
    label: raw.yes_sub_title || raw.title || raw.ticker,
    yesBid,
    yesAsk,
    yesMid: yesMid !== null && yesMid > 0 && yesMid < 1 ? yesMid : null,
    last,
    rules: raw.rules_primary ?? "",
    status: raw.status ?? "",
    result: raw.result ?? "",
    settledAtMs: (() => {
      const src = raw.settled_time ?? raw.close_time ?? raw.expiration_time;
      const t = src ? Date.parse(src) : NaN;
      return Number.isFinite(t) ? t : null;
    })(),
    deepLink: kalshiDeepLink(seriesTicker),
  };
}

// Tiny TTL + in-flight dedupe so a single link request fanning out over several series
// (and repeated keystrokes) doesn't hammer the gateway. Stateless module Map, no DB.
const memo = new Map<string, { at: number; val: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && now - hit.at < ttlMs) return hit.val as T;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const p = (async () => {
    try {
      const val = await fn();
      memo.set(key, { at: Date.now(), val });
      return val;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p as Promise<T>;
}

export type KalshiEventStatus = "open" | "closed" | "settled" | "all";

/** One event by ticker. Event metadata remains on the live endpoint past the market-history cutoff. */
export async function fetchKalshiEvent(eventTicker: string): Promise<KalshiEventMeta | null> {
  return cached(`kev-one:${eventTicker}`, 30_000, async () => {
    try {
      const r = await kalshiGet<{ event?: RawEvent }>(`/events/${encodeURIComponent(eventTicker)}`);
      const e = r?.event;
      if (!e?.event_ticker) return null;
      return {
        eventTicker: e.event_ticker,
        seriesTicker: e.series_ticker ?? seriesOf(e.event_ticker),
        title: e.title ?? e.event_ticker,
        subTitle: e.sub_title ?? "",
        mutuallyExclusive: Boolean(e.mutually_exclusive),
        feeMultiplier: Number.isFinite(e.fee_multiplier_override) && (e.fee_multiplier_override ?? 0) > 0 ? e.fee_multiplier_override! : 1,
        category: e.category ?? "other",
      };
    } catch {
      return null;
    }
  });
}

/** Events in a series. Discovery defaults to open; settlement ingestion must request all. */
export async function listKalshiEvents(
  seriesTicker: string,
  limit = 60,
  status: KalshiEventStatus = "open",
): Promise<KalshiEventMeta[]> {
  return cached(`kev:${seriesTicker}:${limit}:${status}`, 30_000, async () => {
    try {
      const statusQuery = status === "all" ? "" : `&status=${encodeURIComponent(status)}`;
      const raw: RawEvent[] = [];
      let cursor = "";
      const seenCursors = new Set<string>();
      do {
        const pageSize = Math.min(200, Math.max(1, limit - raw.length));
        const cursorQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
        const seriesQuery = seriesTicker ? `series_ticker=${encodeURIComponent(seriesTicker)}&` : "";
        const r = await kalshiGet<{ events?: RawEvent[]; cursor?: string }>(
          `/events?${seriesQuery}${statusQuery.replace(/^&/, "")}${statusQuery ? "&" : ""}limit=${pageSize}${cursorQuery}`,
        );
        raw.push(...(r?.events ?? []));
        const next = r?.cursor ?? "";
        cursor = next && !seenCursors.has(next) ? next : "";
        if (cursor) seenCursors.add(cursor);
      } while (cursor && raw.length < limit);
      return raw
        .slice(0, limit)
        .filter((e) => e.event_ticker)
        .map((e) => ({
          eventTicker: e.event_ticker!,
          seriesTicker: e.series_ticker ?? seriesTicker,
          title: e.title ?? e.event_ticker!,
          subTitle: e.sub_title ?? "",
          mutuallyExclusive: Boolean(e.mutually_exclusive),
          feeMultiplier: Number.isFinite(e.fee_multiplier_override) && (e.fee_multiplier_override ?? 0) > 0 ? e.fee_multiplier_override! : 1,
          category: e.category ?? "other",
        }));
    } catch {
      return [];
    }
  });
}

async function marketPages(path: "/markets" | "/historical/markets", eventTicker: string): Promise<RawMarket[]> {
  const all: RawMarket[] = [];
  let cursor = "";
  const seenCursors = new Set<string>();
  do {
    const cursorQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const r = await kalshiGet<{ markets?: RawMarket[]; cursor?: string }>(
      `${path}?event_ticker=${encodeURIComponent(eventTicker)}&limit=1000${cursorQuery}`,
    );
    all.push(...(r?.markets ?? []));
    const next = r?.cursor ?? "";
    cursor = next && !seenCursors.has(next) ? next : "";
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return all;
}

/** The binary outcomes of one Kalshi event. Settlement backfill can merge the historical tier. */
export async function fetchKalshiMarkets(eventTicker: string, includeHistorical = false): Promise<KalshiMarket[]> {
  return cached(`kmk:${eventTicker}:${includeHistorical ? "history" : "live"}`, 20_000, async () => {
    const live = await marketPages("/markets", eventTicker).catch(() => [] as RawMarket[]);
    const historical = includeHistorical
      ? await marketPages("/historical/markets", eventTicker).catch(() => [] as RawMarket[])
      : [];
    const byTicker = new Map<string, RawMarket>();
    for (const raw of [...historical, ...live]) if (raw.ticker) byTicker.set(raw.ticker, raw);
    return [...byTicker.values()].map(parseMarket).filter((m): m is KalshiMarket => m !== null);
  });
}

interface RawCandle {
  end_period_ts?: number;
  price?: { close_dollars?: string | number; close?: string | number };
}
/** YES price history (daily close) for a Kalshi market: [{ t: epoch-seconds, p: 0..1 }]. */
export async function fetchKalshiHistory(ticker: string, days = 60): Promise<Array<{ t: number; p: number }>> {
  const series = seriesOf(ticker);
  // Kalshi caps the candlestick window; ask for the last `days` in daily (1440-min) buckets.
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 86_400;
  const query = `period_interval=1440&start_ts=${start}&end_ts=${end}`;
  const parse = (candles: RawCandle[] = []) => candles
    .map((c) => ({ t: Number(c?.end_period_ts), p: parsePriceDollars(c?.price?.close_dollars ?? c?.price?.close) }))
    .filter((x): x is { t: number; p: number } => Number.isFinite(x.t) && x.p !== null);
  try {
    const r = await kalshiGet<{ candlesticks?: RawCandle[] }>(
      `/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(ticker)}/candlesticks?${query}`,
    );
    const live = parse(r?.candlesticks);
    if (live.length) return live;
  } catch {
    /* market may have crossed Kalshi's historical cutoff */
  }
  try {
    const r = await kalshiGet<{ candlesticks?: RawCandle[] }>(
      `/historical/markets/${encodeURIComponent(ticker)}/candlesticks?${query}`,
    );
    return parse(r?.candlesticks);
  } catch {
    return [];
  }
}

/** Live order book for one Kalshi market outcome, normalized to the shared Book type. */
export async function fetchKalshiBook(ticker: string, side: "yes" | "no" = "yes", depth = 8): Promise<Book | null> {
  try {
    const raw = await kalshiGet<KalshiRawOrderbook>(
      `/markets/${encodeURIComponent(ticker)}/orderbook?depth=${depth}`,
    );
    return normalizeKalshiBook(raw, side, ticker);
  } catch {
    return null;
  }
}
