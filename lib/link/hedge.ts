/**
 * lib/link/hedge.ts — turn the EQUIVALENT cross-venue link into a REAL, sized hedge.
 *
 * The product's loss-min engine is already venue-agnostic: solveMaximin consumes legs with a
 * price + paysIn:Set over a single-winner partition and never uses probabilities. So we size the
 * Kalshi cover-all leg (buy NO on the entity's Kalshi market = pays whenever your Polymarket bet
 * loses) with the SAME solver protect.ts uses in-venue, priced off the REAL Kalshi order book with
 * the Kalshi fee, and compare the executable cost against doing the same hedge on Polymarket.
 */
import type { Book } from "@/lib/types";
import { walkBookBuyBudgetCapped, kalshiTakerFeeUsd, takerFeeUsd, SPORTS_FEE } from "@/lib/netcost";
import { solveMaximin, type MaximinLeg } from "@/lib/hedge";
import { fetchKalshiBook } from "@/lib/kalshi";
import type { ClaimKind, CrossVenueHedge, Venue } from "./types";

export interface CrossVenueHedgeInput {
  claimKind: ClaimKind;
  entity: string;
  stakeUsd: number;
  keepFraction?: number; // k ∈ [0,1); default 0.5
  pmYesMid: number | null; // price of the Polymarket bet B (0..1)
  partition: "champion" | "match" | "generic";
  states: string[]; // the single-winner partition
  heldIndex: number; // index of B's entity in `states`
  coverTicker: string; // the EQUIVALENT Kalshi market (we buy its NO)
  coverLabel: string; // e.g. "Spain"
  coverDeepLink: string;
  kalshiFeeMultiplier?: number;
  pmNoBook?: Book | null; // Polymarket anchor NO book, for the executable venue-cost compare
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Near-touch executable price for a budget walk, plus the per-share fee folded in. */
function effectivePrice(book: Book, budgetUsd: number, venue: Venue, feeMultiplier = 1): { price: number; capacityHit: boolean } | null {
  const fill = walkBookBuyBudgetCapped(book, Math.max(5, budgetUsd), 3);
  const p = fill.avgFillPrice ?? book.bestAsk;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  const perShareFee = venue === "kalshi"
    ? kalshiTakerFeeUsd(1, p, feeMultiplier)
    : takerFeeUsd(1, p, "buy", SPORTS_FEE);
  return { price: clamp01(p + perShareFee), capacityHit: fill.capacityHit };
}

export async function buildCrossVenueHedge(input: CrossVenueHedgeInput): Promise<CrossVenueHedge> {
  const k = input.keepFraction ?? 0.5;
  const stakeUsd = Math.max(1, input.stakeUsd);
  const unhedged: CrossVenueHedge = {
    available: false,
    partition: input.partition,
    states: input.states,
    coverLabel: `${input.coverLabel} does NOT win`,
    coverTicker: input.coverTicker,
    coverSide: "no",
    coverDeepLink: input.coverDeepLink,
    stakeUsd,
    keepFraction: k,
    spendUsd: 0,
    keepIfWinUsd: 0,
    lossIfFailUsd: stakeUsd,
    unhedgedLossUsd: stakeUsd,
    kalshiCoverPrice: 0,
    polymarketCoverPrice: null,
    cheaperVenue: null,
    venueNote: "",
  };

  const primaryPrice = input.pmYesMid != null && input.pmYesMid > 0 && input.pmYesMid < 1 ? input.pmYesMid : null;
  if (primaryPrice == null || input.heldIndex < 0 || input.states.length < 2) return unhedged;

  // profit if B wins, and the protection budget (the win-floor cap)
  const payout = stakeUsd / primaryPrice;
  const profit = Math.max(0, payout - stakeUsd);
  const budget = Math.max(5, (1 - clamp01(k)) * profit);

  // price the Kalshi cover-all NO leg off the real book
  const noBook = await fetchKalshiBook(input.coverTicker, "no").catch(() => null);
  if (!noBook) return unhedged;
  const kalshi = effectivePrice(noBook, budget, "kalshi", input.kalshiFeeMultiplier ?? 1);
  if (!kalshi) return unhedged;

  const allExceptHeld = new Set<number>();
  input.states.forEach((_, i) => i !== input.heldIndex && allExceptHeld.add(i));
  const leg: MaximinLeg = { id: "cover", label: `${input.coverLabel} NO`, price: kalshi.price, paysIn: allExceptHeld, provenance: "ANALYTIC" };

  const r = solveMaximin({
    states: input.states,
    primaryWinIdx: [input.heldIndex],
    stakeUsd,
    primaryPrice,
    legs: [leg],
    keepFraction: clamp01(k),
  });

  // executable Polymarket cost for the SAME cover (buy NO on the anchor), for an honest venue compare
  let pmPrice: number | null = null;
  if (input.pmNoBook) {
    const pm = effectivePrice(input.pmNoBook, budget, "polymarket");
    if (pm) pmPrice = pm.price;
  }
  let cheaperVenue: Venue | null = null;
  let venueNote = `Cross-venue hedge: buy NO on Kalshi at ~${Math.round(kalshi.price * 100)}¢ (incl. fee). It pays whenever your bet loses${kalshi.capacityHit ? " — note the Kalshi book is thin near the touch" : ""}.`;
  if (pmPrice != null) {
    cheaperVenue = kalshi.price <= pmPrice ? "kalshi" : "polymarket";
    const diff = Math.round(Math.abs(kalshi.price - pmPrice) * 100);
    venueNote =
      diff <= 1
        ? `Protection costs about the same on both venues (~${Math.round(kalshi.price * 100)}¢ to buy NO).`
        : `Buy NO to hedge: Kalshi ~${Math.round(kalshi.price * 100)}¢ vs Polymarket ~${Math.round(pmPrice * 100)}¢ — ${cheaperVenue === "kalshi" ? "Kalshi" : "Polymarket"} is ${diff}¢ cheaper.`;
  }

  return {
    available: true,
    partition: input.partition,
    states: input.states,
    coverLabel: `${input.coverLabel} does NOT win`,
    coverTicker: input.coverTicker,
    coverSide: "no",
    coverDeepLink: input.coverDeepLink,
    stakeUsd,
    keepFraction: clamp01(k),
    spendUsd: Number(r.spendUsd.toFixed(2)),
    keepIfWinUsd: Number(r.keepIfWinUsd.toFixed(2)),
    lossIfFailUsd: Number(r.lossIfPrimaryFailsUsd.toFixed(2)),
    unhedgedLossUsd: stakeUsd,
    kalshiCoverPrice: Number(kalshi.price.toFixed(4)),
    polymarketCoverPrice: pmPrice != null ? Number(pmPrice.toFixed(4)) : null,
    cheaperVenue,
    venueNote,
  };
}
