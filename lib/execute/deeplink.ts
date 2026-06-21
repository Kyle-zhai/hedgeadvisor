/**
 * lib/execute/deeplink.ts — L1 execution: deep-link to the exact Polymarket market.
 *
 * ⚠️ VERIFIED: Polymarket exposes NO URL params to pre-fill order side/size/price.
 * We can only deep-link to the EVENT page (/event/{slug}). The order parameters are
 * conveyed in OUR "place it like this" card (see the UI), not pre-filled on Polymarket.
 * Do not call this "pre-fill" — it deep-links to the market page only.
 *
 * Zero execution liability: we emit a URL; the user signs/funds/places ON Polymarket.
 */
import type { Decision, MarketRef } from "@/lib/types";

const PM_BASE = "https://polymarket.com";

export interface PlacementCard {
  side: "Buy NO" | "Buy YES";
  outcomeTitle: string; // e.g. "France"
  shares: number;
  limitPrice: number; // protective limit to type on Polymarket
  estPayUsd: number;
  deepLink: string;
  /** Instructions for the user to follow on Polymarket. */
  steps: string[];
}

/** Deep-link to the event page (the only thing Polymarket supports). */
export function buildMarketDeepLink(eventSlug: string, utmSource = "hedgeadvisor"): string {
  // Sanitize: Polymarket slugs are [a-z0-9-]. Strip anything else so a malformed slug
  // can never produce a cross-origin or path-traversal href in the rendered link.
  const safe = String(eventSlug).toLowerCase().replace(/[^a-z0-9-]/g, "");
  const u = new URL(`${PM_BASE}/event/${safe}`);
  // Guard the resolved origin (belt-and-suspenders against URL parsing surprises).
  if (u.origin !== PM_BASE) return PM_BASE;
  u.searchParams.set("utm_source", utmSource); // our own attribution param, not Polymarket's
  return u.toString();
}

/** Build the per-leg "place it like this" cards for an L1 hand-off. */
export function buildPlacementCards(decision: Decision): PlacementCard[] {
  return decision.legs.map(({ leg }) => {
    const outcomeTitle = leg.ref.groupItemTitle ?? leg.ref.question;
    const side: PlacementCard["side"] = leg.side === "buy_no" ? "Buy NO" : "Buy YES";
    const estPay = leg.stakeUsd + leg.takerFeeUsd;
    return {
      side,
      outcomeTitle,
      shares: Math.round(leg.shares),
      limitPrice: Number(leg.worstFillPrice.toFixed(3)),
      estPayUsd: Number(estPay.toFixed(2)),
      deepLink: buildMarketDeepLink(leg.ref.eventSlug),
      steps: [
        "Open Polymarket (link below).",
        `Select the “${outcomeTitle}” outcome and choose ${side === "Buy NO" ? "No" : "Yes"}.`,
        `Enter ~${Math.round(leg.shares)} shares with a limit price of ${leg.worstFillPrice.toFixed(3)} (protects you from a worse fill).`,
        "Confirm on Polymarket. We never touch your funds, keys, or order.",
      ],
    };
  });
}
