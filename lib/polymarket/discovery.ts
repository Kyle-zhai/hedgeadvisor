/**
 * lib/polymarket/discovery.ts — live book fetching + outcome-partition building.
 *
 * For the MVP the candidate hedge universe is the single negRisk Winner event:
 * the held team's OWN NO (exact complement) and rival outcomes are all siblings
 * of the same event, so no manual structure seed is needed (mutual exclusivity is
 * auto-derived from the shared negRiskMarketId).
 */
import type { Book, MarketRef, TokenId } from "@/lib/types";
import { clobGet, clobPost } from "./client";
import { normalizeBook, type RawBook } from "./book";
import { devigDetailed } from "@/lib/correlation";
import type { Outcome } from "@/lib/netcost";
import type { EventBundle } from "./resolve";

export async function fetchBook(tokenId: TokenId): Promise<Book> {
  const raw = await clobGet<RawBook>(`/book?token_id=${encodeURIComponent(tokenId)}`);
  return normalizeBook(raw, tokenId);
}

/** Historical midpoint series for a token: [{ t: epoch-seconds, p: price }]. Used by the
 *  (offline) calibration backtest to read a past price for a now-resolved market. */
export async function fetchPricesHistory(tokenId: TokenId, fidelity = 1440): Promise<Array<{ t: number; p: number }>> {
  try {
    const r = await clobGet<{ history?: Array<{ t: number; p: number }> }>(
      `/prices-history?market=${encodeURIComponent(tokenId)}&interval=max&fidelity=${fidelity}`,
    );
    return (r?.history ?? []).filter((h) => Number.isFinite(h.t) && Number.isFinite(h.p));
  } catch {
    return [];
  }
}

/**
 * Live CLOB midpoints for many tokens in one (chunked) batch call.
 * Used to de-vig off FRESH prices instead of the Gamma event snapshot — so q and
 * every risk metric reflect the current market and stay consistent with the book
 * the hedge is actually walked against. Returns tokenId -> midpoint.
 */
export async function fetchMidpoints(tokenIds: TokenId[]): Promise<Map<TokenId, number>> {
  const out = new Map<TokenId, number>();
  const CHUNK = 100;
  for (let i = 0; i < tokenIds.length; i += CHUNK) {
    const chunk = tokenIds.slice(i, i + CHUNK);
    try {
      const resp = await clobPost<Record<string, string>>("/midpoints", chunk.map((token_id) => ({ token_id })));
      for (const [k, v] of Object.entries(resp ?? {})) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0 && n < 1) out.set(k, n);
      }
    } catch {
      /* partial success is fine; caller falls back to the snapshot for missing tokens */
    }
  }
  return out;
}

/** Batch book fetch; returns a map tokenId -> Book (skips tokens that can't be priced). */
export async function fetchBooks(tokenIds: TokenId[]): Promise<Map<TokenId, Book>> {
  const out = new Map<TokenId, Book>();
  try {
    const raws = await clobPost<Array<RawBook>>("/books", tokenIds.map((token_id) => ({ token_id })));
    raws.forEach((raw, i) => {
      const id = raw.asset_id ?? tokenIds[i];
      try {
        out.set(id, normalizeBook(raw, id));
      } catch {
        /* skip degenerate/empty */
      }
    });
    if (out.size > 0) return out;
  } catch {
    /* fall through to per-token */
  }
  // fallback: per-token (some deployments restrict the batch endpoint)
  await Promise.all(
    tokenIds.map(async (id) => {
      try {
        out.set(id, await fetchBook(id));
      } catch {
        /* skip */
      }
    }),
  );
  return out;
}

/** Build the de-vigged outcome partition (one entry per team in the negRisk event).
 *  Uses the best valid de-vig method (Shin → power → proportional). */
export function buildOutcomes(bundle: EventBundle): Outcome[] {
  const q = devigDetailed(bundle.yesPrices).q;
  return bundle.markets.map((m, i) => ({
    label: m.groupItemTitle ?? m.question ?? `outcome ${i}`,
    q: q[i],
  }));
}

/** Rank rival outcomes (other teams) by de-vigged probability — the most likely
 *  ways your team loses. Used to build a rival-NO basket hedge alternative. */
export function topRivals(
  bundle: EventBundle,
  heldIndex: number,
  outcomes: Outcome[],
  n = 4,
): Array<{ index: number; ref: MarketRef; q: number }> {
  return outcomes
    .map((o, index) => ({ index, ref: bundle.markets[index], q: o.q }))
    .filter((r) => r.index !== heldIndex && !r.ref.resolved)
    .sort((a, b) => b.q - a.q)
    .slice(0, n);
}
