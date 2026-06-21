/**
 * lib/netcost/walk.ts — walk the order book to get the TRUE executable price.
 *
 * The product's whole "honest cost" claim lives here: we NEVER price a hedge off
 * the displayed midpoint. We consume real ask levels for a BUY (bid levels for a
 * SELL) and report average fill, worst fill, slippage, and whether depth ran out.
 *
 * Precondition: `book` is already normalized (asks ASCENDING, bids DESCENDING)
 * by lib/polymarket/book.ts. We defensively re-sort anyway — the sort is
 * load-bearing and must never be "optimized away".
 */
import type { Book, FillResult, OrderLevel } from "@/lib/types";

function sortedAsc(levels: OrderLevel[]): OrderLevel[] {
  return [...levels].sort((a, b) => a.price - b.price);
}
function sortedDesc(levels: OrderLevel[]): OrderLevel[] {
  return [...levels].sort((a, b) => b.price - a.price);
}

/** Walk the ask side for a BUY of `targetShares`. */
export function walkBookBuy(book: Book, targetShares: number): FillResult {
  const asks = sortedAsc(book.asks);
  const mid = book.midpoint;
  let remaining = targetShares;
  let cost = 0;
  let worst = 0;
  for (const lvl of asks) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lvl.size);
    cost += take * lvl.price;
    worst = lvl.price;
    remaining -= take;
  }
  const filled = targetShares - remaining;
  const avg = filled > 0 ? cost / filled : null;
  return {
    filledShares: filled,
    unfilledShares: Math.max(0, remaining),
    avgFillPrice: avg,
    worstFillPrice: filled > 0 ? worst : null,
    notionalSpent: cost,
    midpoint: mid,
    slippagePerShare: avg !== null ? avg - mid : null,
    slippageUsd: avg !== null ? (avg - mid) * filled : 0,
    capacityHit: remaining > 1e-9,
  };
}

/** Walk the bid side for a SELL of `targetShares` (used for exit-cost estimates). */
export function walkBookSell(book: Book, targetShares: number): FillResult {
  const bids = sortedDesc(book.bids);
  const mid = book.midpoint;
  let remaining = targetShares;
  let proceeds = 0;
  let worst = 1;
  for (const lvl of bids) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lvl.size);
    proceeds += take * lvl.price;
    worst = lvl.price;
    remaining -= take;
  }
  const filled = targetShares - remaining;
  const avg = filled > 0 ? proceeds / filled : null;
  return {
    filledShares: filled,
    unfilledShares: Math.max(0, remaining),
    avgFillPrice: avg,
    worstFillPrice: filled > 0 ? worst : null,
    notionalSpent: proceeds,
    midpoint: mid,
    slippagePerShare: avg !== null ? mid - avg : null, // sell slippage = mid - avgFill
    slippageUsd: avg !== null ? (mid - avg) * filled : 0,
    capacityHit: remaining > 1e-9,
  };
}

/**
 * Walk a buy sized by a USD budget but STOP at a near-touch price band
 * (bestAsk + maxCents). This is the honest costing primitive: a thin book whose
 * deep levels are 3-12x the touch price will report a tiny `fillableUsd` and
 * `capacityHit: true`, instead of fabricating a fill by climbing the whole ladder.
 * `walkBookBuyBudget` (uncapped) must NOT be used to price legs offered to users.
 */
export function walkBookBuyBudgetCapped(book: Book, budgetUsd: number, maxCents = 3): FillResult {
  const asks = sortedAsc(book.asks);
  const cap = book.bestAsk + maxCents / 100;
  let budget = budgetUsd;
  let cost = 0;
  let shares = 0;
  let worst = 0;
  for (const lvl of asks) {
    if (budget <= 0) break;
    if (lvl.price <= 0) continue;
    if (lvl.price > cap + 1e-9) break; // outside the near-touch band — stop, don't climb
    const affordable = budget / lvl.price;
    const take = Math.min(affordable, lvl.size);
    shares += take;
    cost += take * lvl.price;
    worst = lvl.price;
    budget -= take * lvl.price;
  }
  const avg = shares > 0 ? cost / shares : null;
  return {
    filledShares: shares,
    unfilledShares: 0,
    avgFillPrice: avg,
    worstFillPrice: shares > 0 ? worst : null,
    notionalSpent: cost,
    midpoint: book.midpoint,
    slippagePerShare: avg !== null ? avg - book.midpoint : null,
    slippageUsd: avg !== null ? (avg - book.midpoint) * shares : 0,
    capacityHit: budget > 1e-6, // couldn't deploy the full budget within the band
    fillableUsd: cost,
  };
}

/** USD available to BUY within `maxCents` of the best ask (depth gate input). */
export function bandDepthUsd(book: Book, maxCents = 3): number {
  const cap = book.bestAsk + maxCents / 100;
  return book.asks.filter((l) => l.price <= cap + 1e-9 && l.price > 0).reduce((s, l) => s + l.price * l.size, 0);
}

/** Walk a buy sized by a USD budget instead of shares (UNCAPPED — internal only). */
export function walkBookBuyBudget(book: Book, budgetUsd: number): FillResult {
  const asks = sortedAsc(book.asks);
  let budget = budgetUsd;
  let cost = 0;
  let shares = 0;
  let worst = 0;
  for (const lvl of asks) {
    if (budget <= 0) break;
    if (lvl.price <= 0) continue; // defensive: never divide by a 0-priced level
    const affordable = budget / lvl.price;
    const take = Math.min(affordable, lvl.size);
    shares += take;
    cost += take * lvl.price;
    worst = lvl.price;
    budget -= take * lvl.price;
  }
  const avg = shares > 0 ? cost / shares : null;
  return {
    filledShares: shares,
    unfilledShares: 0,
    avgFillPrice: avg,
    worstFillPrice: shares > 0 ? worst : null,
    notionalSpent: cost,
    midpoint: book.midpoint,
    slippagePerShare: avg !== null ? avg - book.midpoint : null,
    slippageUsd: avg !== null ? (avg - book.midpoint) * shares : 0,
    capacityHit: budget > 1e-6, // couldn't deploy the whole budget => book too thin
  };
}
