/**
 * lib/netcost/fee.ts — THE single fee function. Nobody re-derives this.
 *
 * Verified against Polymarket's live feeSchedule + help center (2026-06-15):
 *   sports feeSchedule = { exponent: 1, rate: 0.03, takerOnly: true, rebateRate: 0.25 }
 *   fee_usd = shares * p * rate * (p*(1-p))^exponent
 *   => fee as a fraction of notional = rate * p(1-p), PEAKS at 0.75% at p=0.5.
 *
 * ⚠️ The "1.80%" figure floating around is the CRYPTO 15-min tier, NOT sports.
 * Sells are fee-exempt. Makers (limit orders) pay ~0% and earn a rebate.
 */
import type { Price } from "@/lib/types";

export const FEE_RATE_SPORTS = 0.03;
export const FEE_EXPONENT_SPORTS = 1;
const MIN_FEE_USD = 0.0001;

export interface FeeSchedule {
  rate: number;
  exponent: number;
  takerOnly: boolean;
}

export const SPORTS_FEE: FeeSchedule = {
  rate: FEE_RATE_SPORTS,
  exponent: FEE_EXPONENT_SPORTS,
  takerOnly: true,
};

/** Kalshi's base parameters. Its formula is NOT the Polymarket formula; use kalshiTakerFeeUsd. */
export const KALSHI_FEE: FeeSchedule = {
  rate: 0.07,
  exponent: 1,
  takerOnly: false,
};

/**
 * Kalshi general taker fee: 0.07 × contracts × P × (1-P), times any series fee multiplier.
 * This intentionally does not route through `takerFeeUsd`: that function includes Polymarket's
 * additional notional-price factor. Trade-fee rounding moved to centicents; rounding up here keeps
 * the executable price conservative without adding a full cent to every individual contract.
 */
export function kalshiTakerFeeUsd(contracts: number, p: Price, feeMultiplier = 1): number {
  if (contracts <= 0 || p <= 0 || p >= 1 || feeMultiplier <= 0) return 0;
  const raw = 0.07 * feeMultiplier * contracts * p * (1 - p);
  return Math.ceil(raw * 10_000 - 1e-9) / 10_000;
}

/**
 * Taker fee in USD for a BUY of `shares` at average price p.
 * Sells are exempt (return 0). Makers/limit orders also pay ~0 (caller decides side).
 */
export function takerFeeUsd(
  shares: number,
  p: Price,
  side: "buy" | "sell" = "buy",
  fee: FeeSchedule = SPORTS_FEE,
): number {
  if (side === "sell") return 0;
  if (shares <= 0 || p <= 0 || p >= 1) return 0;
  const pp = Math.pow(p * (1 - p), fee.exponent);
  const usd = shares * p * fee.rate * pp;
  return usd > 0 ? Math.max(usd, MIN_FEE_USD) : 0;
}

/** Fee as a fraction of notional (notional = shares*p). Peaks 0.75% at p=0.5 (sports). */
export function feeFracOfNotional(p: Price, fee: FeeSchedule = SPORTS_FEE): number {
  if (p <= 0 || p >= 1) return 0;
  return fee.rate * Math.pow(p * (1 - p), fee.exponent);
}
