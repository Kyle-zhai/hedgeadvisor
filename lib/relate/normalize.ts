/**
 * lib/relate/normalize.ts — adapt each venue's native market objects into NormalizedMarket.
 * One shape so Stage 1/2/3 never branch on venue. Probabilities are de-vigged (PM) or mids (Kalshi).
 */
import { devigDetailed } from "@/lib/correlation";
import { norm } from "@/lib/polymarket/text";
import type { EventBundle } from "@/lib/polymarket";
import type { KalshiMarket } from "@/lib/kalshi";
import { eventFamily, predicateOf } from "./relationKey";
import type { NormalizedMarket } from "./types";

const GENERIC = new Set([
  "the", "to", "win", "wins", "winning", "won", "of", "a", "an", "world", "cup", "winner",
  "golden", "boot", "final", "tie", "draw", "vs", "or", "and", "scored", "goals", "total", "over", "under",
]);

/** Distinguishing entity tokens from an outcome label (team/player/continent), accent-folded. */
function entityTokens(label: string): string[] {
  return norm(label).split(" ").filter((w) => w.length > 1 && !GENERIC.has(w));
}

function parseEnd(d: string | null | undefined): number | null {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isFinite(t) ? t : null;
}

/** Polymarket negRisk event → one NormalizedMarket per outcome (de-vigged YES). */
export function normalizePolymarketEvent(bundle: EventBundle, category: string): NormalizedMarket[] {
  // Only negRisk outcomes form one exhaustive/mutually-exclusive partition. Ordinary binary
  // markets inside a Gamma event can co-occur, so normalizing their YES prices against each other
  // would fabricate probabilities and distort semantic ranking.
  const q = bundle.negRisk ? devigDetailed(bundle.yesPrices).q : bundle.yesPrices;
  // q is aligned 1:1 with the FULL bundle.markets array (resolved outcomes included), so it MUST be
  // indexed by the ORIGINAL position, not the post-filter index — otherwise a resolved outcome that
  // precedes an unresolved one shifts every later probability onto the wrong outcome.
  return bundle.markets
    .map((m, origIdx) => ({ m, origIdx }))
    .filter(({ m }) => !m.resolved)
    .map(({ m, origIdx }) => {
      const label = m.groupItemTitle ?? m.question;
      const p = q[origIdx] ?? m.midpointYes;
      return {
        id: `polymarket:${m.conditionId}`,
        venue: "polymarket" as const,
        eventKey: m.negRiskMarketId ?? bundle.slug,
        mutuallyExclusiveEvent: bundle.negRisk,
        title: label,
        marketTitle: bundle.title.trim(),
        description: `${label} — ${bundle.title.trim()}`,
        resolutionCriteria: m.question,
        probYes: p,
        category,
        eventFamily: eventFamily(bundle.title, category),
        // include the outcome label only for narrative multi-outcome events (so distinct contracts
        // don't collide); entity events pool by event-type + role instead.
        predicate: predicateOf(bundle.title, m.question, eventFamily(bundle.title, category) === "broadcast_word" ? label : undefined),
        // Proxy: a real de-vigged mid in (0,1) implies a tradable book. TODO: thread true book depth +
        // event end-time through EventBundle/MarketRef for an exact liquidity/time-window gate.
        liquidityOk: Number.isFinite(p) && p > 0 && p < 1,
        endDateMs: null,
        url: `https://polymarket.com/event/${bundle.slug}`,
        entityTokens: entityTokens(label),
        yesTokenId: m.tokenIdYes,
        noTokenId: m.tokenIdNo,
        feeRate: m.feeRate,
        feeExponent: m.feeExponent,
        feeTakerOnly: m.feeTakerOnly,
      };
    });
}

/** Kalshi event markets → NormalizedMarket per outcome (raw YES mid). */
export function normalizeKalshiEvent(
  markets: KalshiMarket[],
  marketTitle: string,
  category: string,
  mutuallyExclusiveEvent = false,
  feeMultiplier = 1,
): NormalizedMarket[] {
  return markets
    .filter((m) => m.yesMid != null && ["active", "open"].includes(m.status.toLowerCase()))
    .map((m) => ({
      id: `kalshi:${m.ticker}`,
      venue: "kalshi" as const,
      eventKey: m.eventTicker,
      mutuallyExclusiveEvent,
      title: m.label,
      marketTitle: marketTitle.trim(),
      description: `${m.label} — ${marketTitle.trim()}${m.rules ? `. ${m.rules.slice(0, 160)}` : ""}`,
      resolutionCriteria: m.rules || m.label,
      probYes: m.yesMid as number,
      category,
      eventFamily: eventFamily(marketTitle, category),
      predicate: predicateOf(marketTitle, m.rules, eventFamily(marketTitle, category) === "broadcast_word" ? m.label : undefined),
      liquidityOk: m.yesBid != null && m.yesAsk != null,
      endDateMs: null,
      url: m.deepLink,
      entityTokens: entityTokens(m.label),
      yesTokenId: m.ticker, // Kalshi: same ticker, buy the YES side
      noTokenId: m.ticker, // Kalshi: same ticker, buy the NO side
      feeRate: 0.07 * Math.max(0, feeMultiplier), // interpreted as Kalshi's series multiplier in priceSide
      feeExponent: 1,
      feeTakerOnly: false,
    }));
}
