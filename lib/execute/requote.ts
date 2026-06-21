/**
 * lib/execute/requote.ts — re-price a hedge leg at the moment of action.
 *
 * Prices move between recommendation and click, and the book is thin. Before any
 * execution (L1 hand-off card OR L2 signed order) we pull a FRESH book and recompute
 * the executable cost, surfacing the drift. Reuses the net-cost engine — never a
 * second cost path. The limit price we surface caps the user's worst fill.
 */
import type { MarketRef, TokenId } from "@/lib/types";
import { fetchBook } from "@/lib/polymarket";
import { CannotPriceError } from "@/lib/polymarket/book";
import { walkBookBuy, takerFeeUsd } from "@/lib/netcost";

const DRIFT_CONFIRM = 0.02; // >2% drift forces a re-confirm
const LIMIT_BUFFER = 0.005; // small buffer so micro-jitter doesn't auto-reject

export interface Requote {
  ok: boolean;
  reason?: "CANNOT_PRICE";
  shares: number; // shares actually fillable at quoted price
  estPayUsd: number;
  recoPayUsd: number;
  driftPct: number;
  needsConfirm: boolean;
  limitPrice: number;
  resolved: boolean;
  capacityHit: boolean;
  unfilledShares: number; // > 0 => requested size can't fully fill at this price
  /** The drift baseline is client-supplied (advisory); the gate never trusts it alone. */
  baselineFromClient: boolean;
}

export async function requote(
  ref: MarketRef,
  side: "buy_yes" | "buy_no",
  tokenId: TokenId,
  shares: number,
  recoPayUsd: number,
): Promise<Requote> {
  if (ref.resolved) {
    return cannotPrice(shares, recoPayUsd, { resolved: true });
  }
  try {
    const book = await fetchBook(tokenId); // fresh, not cached
    const fill = walkBookBuy(book, shares);
    const p = fill.avgFillPrice ?? book.midpoint;
    const fee = takerFeeUsd(fill.filledShares, p, "buy", {
      rate: ref.feeRate,
      exponent: ref.feeExponent,
      takerOnly: ref.feeTakerOnly,
    });
    const estPayUsd = fill.filledShares * p + fee;
    const driftPct = recoPayUsd > 0 ? Math.abs(estPayUsd - recoPayUsd) / recoPayUsd : 1;
    const worst = fill.worstFillPrice ?? p;
    const limitPrice = Math.min(0.999, Number((worst * (1 + LIMIT_BUFFER)).toFixed(3)));

    // The drift baseline (recoPayUsd) is client-supplied; never trust it as the sole gate.
    // Force a re-confirm on big drift, capacity exhaustion, a non-positive baseline, or a
    // baseline implausibly far from the live executable cost (>2x or <0.5x).
    const ratio = recoPayUsd > 0 ? estPayUsd / recoPayUsd : Infinity;
    const implausibleBaseline = recoPayUsd <= 0 || ratio > 2 || ratio < 0.5;

    return {
      ok: true,
      shares: fill.filledShares,
      estPayUsd: Number(estPayUsd.toFixed(2)),
      recoPayUsd,
      driftPct: Number(driftPct.toFixed(4)),
      needsConfirm: driftPct > DRIFT_CONFIRM || fill.capacityHit || implausibleBaseline,
      limitPrice,
      resolved: false,
      capacityHit: fill.capacityHit,
      unfilledShares: Number(fill.unfilledShares.toFixed(2)),
      baselineFromClient: true,
    };
  } catch (e) {
    if (e instanceof CannotPriceError) {
      return cannotPrice(shares, recoPayUsd, { capacityHit: true });
    }
    throw e;
  }
}

function cannotPrice(
  shares: number,
  recoPayUsd: number,
  opts: { resolved?: boolean; capacityHit?: boolean },
): Requote {
  return {
    ok: false,
    reason: "CANNOT_PRICE",
    shares,
    estPayUsd: 0,
    recoPayUsd,
    driftPct: 1,
    needsConfirm: true,
    limitPrice: 0,
    resolved: Boolean(opts.resolved),
    capacityHit: Boolean(opts.capacityHit),
    unfilledShares: shares,
    baselineFromClient: true,
  };
}
