/**
 * lib/kalshi/catalog.ts — a cached catalog of Kalshi SERIES, the only discovery surface.
 *
 * Kalshi has no text-search endpoint, but GET /series?category= enumerates every series in a
 * category (Politics ~2k, Sports ~2.2k, …), each with a title + ticker. We cache the catalog per
 * category (long TTL — series are slow-moving) and keyword-match a Polymarket bet's event title +
 * entity against series titles. This is the generic analog of the hand-coded World Cup series map.
 */
import { kalshiGet } from "./client";

export type KalshiCategory = "Politics" | "Sports" | "Economics" | "Crypto" | "World" | "Companies";
export const KALSHI_CATEGORIES: KalshiCategory[] = ["Politics", "Sports", "Economics", "Crypto", "World", "Companies"];

export interface KalshiSeries {
  ticker: string;
  title: string;
  category: string;
}

interface RawSeries {
  ticker?: string;
  title?: string;
  category?: string;
}

// Long-TTL module cache + in-flight dedupe. The catalog is large but slow-moving; a 6h TTL keeps a
// warm function instance to ~6 GETs total, and concurrent identical loads collapse into one.
const TTL_MS = 6 * 60 * 60 * 1000;
const memo = new Map<string, { at: number; val: KalshiSeries[] }>();
const inflight = new Map<string, Promise<KalshiSeries[]>>();

/** All series in one Kalshi category (cached). Empty array on any failure. */
export async function fetchSeriesByCategory(category: KalshiCategory): Promise<KalshiSeries[]> {
  const key = `cat:${category}`;
  const hit = memo.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.val;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async () => {
    try {
      const r = await kalshiGet<{ series?: RawSeries[] }>(`/series?category=${encodeURIComponent(category)}`);
      const out: KalshiSeries[] = (r?.series ?? [])
        .filter((s) => s.ticker && s.title)
        .map((s) => ({ ticker: s.ticker!, title: s.title!, category: s.category ?? category }));
      memo.set(key, { at: Date.now(), val: out });
      return out;
    } catch {
      return [];
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** The union of series across the given categories (default: all six). */
export async function listSeriesCatalog(categories: KalshiCategory[] = KALSHI_CATEGORIES): Promise<KalshiSeries[]> {
  const lists = await Promise.all(categories.map((c) => fetchSeriesByCategory(c)));
  return lists.flat();
}
