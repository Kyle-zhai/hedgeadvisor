/**
 * lib/kalshi/book.ts — normalize a Kalshi orderbook into our shared Book type.
 *
 * Kalshi's `orderbook_fp` returns RESTING BIDS ONLY, on two sides:
 *   yes_dollars: [[price, size], ...]   bids to BUY YES   (ascending price)
 *   no_dollars:  [[price, size], ...]   bids to BUY NO    (ascending price)
 * A YES contract and a NO contract on the same market sum to $1, so the price to BUY YES
 * is the cross against the NO book: ask_yes = 1 − bid_no. We synthesize the YES (or NO) book
 * here so the SAME walk/fill engine used for Polymarket prices a Kalshi leg unchanged.
 *
 * Sizes are CONTRACT counts; each contract pays $1, so a contract == a "share" — identical
 * units to Polymarket downstream. Prices are decimal dollars in (0,1).
 */
import type { Book, OrderLevel, TokenId } from "@/lib/types";
import { CannotPriceError } from "@/lib/polymarket";

type RawLevel = [string | number, string | number];
export interface KalshiRawOrderbook {
  orderbook_fp?: { yes_dollars?: RawLevel[]; no_dollars?: RawLevel[] };
  orderbook?: { yes?: RawLevel[]; no?: RawLevel[] };
}

/** Parse + clamp a raw [price, size] level list into OrderLevels (dropping junk levels). */
function toLevels(raw: RawLevel[] | undefined, centScale: boolean): OrderLevel[] {
  if (!raw) return [];
  return raw
    .map(([p, s]) => ({ price: centScale ? Number(p) / 100 : Number(p), size: Number(s) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0 && l.price > 0 && l.price < 1);
}

/** Mirror a bid book to the opposite side's asks: ask_price = 1 − bid_price, same size. */
function asksFromOppositeBids(bids: OrderLevel[]): OrderLevel[] {
  return bids.map((l) => ({ price: 1 - l.price, size: l.size }));
}

/**
 * Build a normalized Book for one side of a Kalshi market.
 *   side "yes" → you can BUY YES (asks) and SELL YES / others buy YES (bids)
 *   side "no"  → symmetric for the NO contract
 * Applies the same degenerate/crossed guards as the Polymarket boundary.
 */
export function normalizeKalshiBook(raw: KalshiRawOrderbook, side: "yes" | "no", tokenId: TokenId): Book {
  const fp = raw.orderbook_fp;
  const cents = !fp; // the legacy `orderbook` field is integer cents
  const yesRaw = fp?.yes_dollars ?? raw.orderbook?.yes;
  const noRaw = fp?.no_dollars ?? raw.orderbook?.no;

  const yesBids = toLevels(yesRaw, cents);
  const noBids = toLevels(noRaw, cents);

  // bids = resting buys of THIS side; asks = synthesized from the opposite side's bids.
  const ownBids = side === "yes" ? yesBids : noBids;
  const oppBids = side === "yes" ? noBids : yesBids;

  const bids = ownBids.slice().sort((a, b) => b.price - a.price); // DESCENDING (best first)
  const asks = asksFromOppositeBids(oppBids).sort((a, b) => a.price - b.price); // ASCENDING (best first)

  // A side is BUYABLE as long as asks exist (synthesized from the opposite side's resting bids). Don't
  // drop a buyable hedge leg just because no one is currently bidding to take THIS side off you (an empty
  // exit book): only a missing ask makes a buy unpriceable. The fully-empty book still throws (no asks).
  if (asks.length === 0) {
    throw new CannotPriceError(`empty Kalshi book for ${tokenId} (${side}) — no buyable ask`);
  }
  const bestAsk = asks[0].price;
  // With no resting bids, synthesize bestBid = 0 and reference the midpoint off the ask. We never fabricate
  // an exit price; a buyer's slippage is measured from the real ask, which stays honest.
  const bestBid = bids.length ? bids[0].price : 0;
  const midpoint = bids.length ? (bestBid + bestAsk) / 2 : bestAsk;
  if (bestAsk >= 0.99 && bestBid <= 0.01) {
    throw new CannotPriceError(`degenerate Kalshi book for ${tokenId} (${bestBid}/${bestAsk})`);
  }
  if (bids.length && bestAsk <= bestBid) {
    throw new CannotPriceError(`crossed Kalshi book for ${tokenId} (${bestBid}/${bestAsk})`);
  }
  return { bids, asks, bestBid, bestAsk, midpoint, tokenId };
}
