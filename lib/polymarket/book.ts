/**
 * lib/polymarket/book.ts — normalize a raw CLOB /book into our Book type.
 *
 * ⚠️ VERIFIED (2026-06-15): Polymarket returns bids ASCENDING and asks DESCENDING
 * — the OPPOSITE of its own docs. Reading bids[0]/asks[0] gives the WORST prices.
 * This boundary is the ONE place we fix the ordering; everything downstream trusts
 * bids DESCENDING / asks ASCENDING. We also (a) parse string levels to numbers and
 * (b) reject degenerate (0.999/0.001 placeholder) books rather than fabricate a fill.
 */
import type { Book, OrderLevel, TokenId } from "@/lib/types";

export class CannotPriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CannotPriceError";
  }
}

interface RawLevel {
  price: string | number;
  size: string | number;
}
export interface RawBook {
  asset_id?: string;
  bids?: RawLevel[];
  asks?: RawLevel[];
  tick_size?: string | number;
}

function toLevels(raw: RawLevel[] | undefined): OrderLevel[] {
  if (!raw) return [];
  return raw
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter(
      (l) =>
        Number.isFinite(l.price) &&
        Number.isFinite(l.size) &&
        l.size > 0 &&
        l.price > 0 && // guard against 0-priced levels (would make a budget walk fill ∞ shares free)
        l.price < 1,
    );
}

export function normalizeBook(raw: RawBook, tokenId: TokenId): Book {
  const bids = toLevels(raw.bids).sort((a, b) => b.price - a.price); // DESCENDING (best first)
  const asks = toLevels(raw.asks).sort((a, b) => a.price - b.price); // ASCENDING (best first)

  if (bids.length === 0 || asks.length === 0) {
    throw new CannotPriceError(`empty book for token ${tokenId}`);
  }
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;

  // Degenerate / stale placeholder guard: a real book never has best ask ~1 and best bid ~0.
  if (bestAsk >= 0.99 && bestBid <= 0.01) {
    throw new CannotPriceError(`degenerate book for token ${tokenId} (${bestBid}/${bestAsk})`);
  }
  if (bestAsk <= bestBid) {
    // crossed/locked book — don't fabricate; let caller degrade
    throw new CannotPriceError(`crossed book for token ${tokenId} (${bestBid}/${bestAsk})`);
  }

  return {
    bids,
    asks,
    bestBid,
    bestAsk,
    midpoint: (bestBid + bestAsk) / 2,
    tokenId,
  };
}
