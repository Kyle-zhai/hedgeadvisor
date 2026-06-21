/**
 * lib/netcost — the net-cost engine. Single source of truth for execution cost.
 */
import type { Book, FilledLeg, MarketRef, TokenId } from "@/lib/types";
import { takerFeeUsd, type FeeSchedule } from "./fee";
import { walkBookBuy, walkBookBuyBudgetCapped } from "./walk";

export { takerFeeUsd, kalshiTakerFeeUsd, feeFracOfNotional, SPORTS_FEE, KALSHI_FEE, FEE_RATE_SPORTS, type FeeSchedule } from "./fee";
export { walkBookBuy, walkBookSell, walkBookBuyBudget, walkBookBuyBudgetCapped, bandDepthUsd } from "./walk";
export { pnlDistribution, pnlDistributionSim, riskMetrics, lossIfPrimaryFails, costOfProtection, type Outcome, type PnLLeg, type SimLeg } from "./benefit";

/**
 * Price a single hedge leg against a live book.
 * Always walks the book; never uses the displayed midpoint as a fill price.
 */
export function priceLeg(
  ref: MarketRef,
  side: "buy_yes" | "buy_no",
  tokenId: TokenId,
  book: Book,
  shares: number,
): FilledLeg {
  const fill = walkBookBuy(book, shares);
  const p = fill.avgFillPrice ?? book.midpoint;
  const fee: FeeSchedule = {
    rate: ref.feeRate,
    exponent: ref.feeExponent,
    takerOnly: ref.feeTakerOnly,
  };
  const takerFee = takerFeeUsd(fill.filledShares, p, "buy", fee);
  const spreadCostUsd = (book.bestAsk - book.midpoint) * fill.filledShares;
  const stakeUsd = fill.filledShares * p;
  const entryCostUsd = fill.slippageUsd + takerFee; // execution premium over mid + fee

  return {
    ref,
    side,
    tokenId,
    shares: fill.filledShares,
    avgFillPrice: p,
    worstFillPrice: fill.worstFillPrice ?? p,
    slippageUsd: fill.slippageUsd,
    spreadCostUsd,
    takerFeeUsd: takerFee,
    entryCostUsd,
    stakeUsd,
    capacityHit: fill.capacityHit,
  };
}

/**
 * Price a leg by a USD budget, costed at the NEAR-TOUCH band only (the honest path).
 * `capacityHit` is true when the budget can't fill within `maxCents` of the touch —
 * the caller must then cap/decline the leg, never quote a climbed-ladder fill.
 */
export function priceLegBudget(
  ref: MarketRef,
  side: "buy_yes" | "buy_no",
  tokenId: TokenId,
  book: Book,
  budgetUsd: number,
  maxCents = 3,
): FilledLeg {
  const fill = walkBookBuyBudgetCapped(book, budgetUsd, maxCents);
  const p = fill.avgFillPrice ?? book.midpoint;
  const fee: FeeSchedule = { rate: ref.feeRate, exponent: ref.feeExponent, takerOnly: ref.feeTakerOnly };
  const takerFee = takerFeeUsd(fill.filledShares, p, "buy", fee);
  const spreadCostUsd = (book.bestAsk - book.midpoint) * fill.filledShares;
  return {
    ref,
    side,
    tokenId,
    shares: fill.filledShares,
    avgFillPrice: p,
    worstFillPrice: fill.worstFillPrice ?? p,
    slippageUsd: fill.slippageUsd,
    spreadCostUsd,
    takerFeeUsd: takerFee,
    entryCostUsd: fill.slippageUsd + takerFee,
    stakeUsd: fill.filledShares * p,
    capacityHit: fill.capacityHit,
  };
}
