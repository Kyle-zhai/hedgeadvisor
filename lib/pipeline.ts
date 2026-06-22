/**
 * lib/pipeline.ts — Combo Truth Check: build a multi-leg parlay and price each leg off the REAL book
 * (de-vigged true probability), detect structural impossibility (mutual exclusivity / containment),
 * and report honest cost vs fair value + compounded vig. The former hedge/plan strategy engines
 * (runHedge / runPlan and the complement/rival "short your own bet" path) were removed in the
 * 2026-06-21 consolidation: the single hedge surface is now /hedge (lib/relate discoverRelations),
 * positive-sum only, and shorting your own bet is never recommended anywhere.
 */

import { fetchBooks, fetchMidpoints, resolveBet, resolveAnyPosition } from "@/lib/polymarket";
import { devigDetailed } from "@/lib/correlation";
import { walkBookBuyBudgetCapped } from "@/lib/netcost";
import { buildMarketDeepLink } from "@/lib/execute";
import { buildCombo, detectStructuralJoint, sharesEntity, type PricedComboLeg, type ComboResult, type StructLeg } from "@/lib/combo";
import { marginalBand, jointAllHit } from "@/lib/estimate";

// ── Combo Truth Check: build a multi-leg parlay, price each leg off the REAL book ──

export interface ComboLegRequest {
  query: string; // free-text market/position, resolved to a real Polymarket outcome
  side: "yes" | "no";
}
export interface ComboRequest {
  legs: ComboLegRequest[];
  stakeUsd?: number;
  /** Optional quoted combo price (per $1 payout), as a FRACTION 0..1, to truth-check. */
  quotedComboPrice?: number;
}
export interface ComboResponse {
  status: "ok" | "error";
  result?: ComboResult;
  unresolved?: { query: string; reason: string }[];
  pricedAt?: string;
  error?: string;
}

export async function runCombo(req: ComboRequest): Promise<ComboResponse> {
  const stakeUsd = Math.max(1, req.stakeUsd ?? 20);
  const legReqs = (req.legs ?? []).filter((l) => l.query && l.query.trim().length > 0).slice(0, 8);
  if (legReqs.length === 0) return { status: "error", error: "Add at least one leg." };

  const priced: PricedComboLeg[] = [];
  const legSlugs: string[] = []; // event slug per priced leg (to detect same-market legs)
  const legInfo: StructLeg[] = []; // structural identity per leg (for the exact-joint detector)
  const unresolved: { query: string; reason: string }[] = [];

  for (const lr of legReqs) {
    // Fixture-style leg ("X beats Y"): resolveAnyPosition mis-picks the Draw/opponent (their tokens
    // overlap the query), so resolve via the fixture resolver, which targets the WINNER's match market.
    if (/\bbeats\b|\bvs\.?\b/i.test(lr.query)) {
      let rb;
      try {
        rb = await resolveBet(lr.query);
      } catch {
        rb = null;
      }
      if (rb && rb.kind === "resolved" && rb.fixture.outcomes[rb.viewIndex]) {
        const o = rb.fixture.outcomes[rb.viewIndex];
        const ref = o.ref;
        const side = lr.side === "no" ? "no" : "yes";
        let yesMid = ref.midpointYes;
        try {
          const mids = await fetchMidpoints([ref.tokenIdYes, ref.tokenIdNo]);
          const y = mids.get(ref.tokenIdYes);
          const n = mids.get(ref.tokenIdNo);
          if (y !== undefined && n !== undefined && y + n > 0) yesMid = y / (y + n);
          else if (y !== undefined) yesMid = y;
        } catch {
          /* keep snapshot */
        }
        const qYes = Math.min(0.99, Math.max(0.01, yesMid));
        const legQ = side === "no" ? 1 - qYes : qYes;
        const token = side === "no" ? ref.tokenIdNo : ref.tokenIdYes;
        let price = side === "no" ? 1 - ref.midpointYes : ref.midpointYes;
        let capacityHit = true;
        try {
          const book = (await fetchBooks([token])).get(token);
          if (book) {
            const fill = walkBookBuyBudgetCapped(book, stakeUsd, 3);
            price = fill.avgFillPrice ?? book.bestAsk ?? price;
            capacityHit = fill.capacityHit;
          }
        } catch {
          /* keep snapshot price */
        }
        if (legQ > price) {
          price = legQ;
          capacityHit = true;
        }
        priced.push({ title: o.title, marketTitle: rb.fixture.title, side, q: legQ, price, deepLink: buildMarketDeepLink(ref.eventSlug), capacityHit, band: { lo: Math.max(0, legQ - 0.02), mid: legQ, hi: Math.min(1, legQ + 0.02) } });
        legSlugs.push(rb.fixture.slug);
        legInfo.push({ eventSlug: rb.fixture.slug, index: o.index, title: o.title, side, negRiskMarketId: ref.negRiskMarketId ?? null, q: legQ });
        continue;
      }
    }
    let resolved;
    try {
      resolved = await resolveAnyPosition(lr.query);
    } catch {
      unresolved.push({ query: lr.query, reason: "lookup failed" });
      continue;
    }
    if (resolved.kind !== "resolved") {
      unresolved.push({
        query: lr.query,
        reason: resolved.kind === "ambiguous" ? "ambiguous — be more specific" : "no real Polymarket market found",
      });
      continue;
    }
    const ref = resolved.bundle.markets[resolved.index];
    const side = lr.side === "no" ? "no" : "yes";
    // de-vigged true prob for the YES outcome; NO leg hits with 1 − qYes
    const qYes = devigDetailed(resolved.bundle.yesPrices).q[resolved.index] ?? ref.midpointYes;
    const legQ = side === "no" ? 1 - qYes : qYes;
    // marginal uncertainty band from de-vig method disagreement (flip it for a NO leg)
    const yesBand = marginalBand(resolved.bundle.yesPrices, resolved.index);
    const band = side === "no" ? { lo: 1 - yesBand.hi, mid: 1 - yesBand.mid, hi: 1 - yesBand.lo } : { lo: yesBand.lo, mid: yesBand.mid, hi: yesBand.hi };
    const token = side === "no" ? ref.tokenIdNo : ref.tokenIdYes;
    // executable per-share price: walk the real book near the touch; fall back to the touch/mid
    let price = side === "no" ? 1 - ref.midpointYes : ref.midpointYes;
    let capacityHit = true;
    try {
      const book = (await fetchBooks([token])).get(token);
      if (book) {
        const fill = walkBookBuyBudgetCapped(book, stakeUsd, 3);
        price = fill.avgFillPrice ?? book.bestAsk ?? price;
        capacityHit = fill.capacityHit;
      }
    } catch {
      /* keep the snapshot price */
    }
    // Honesty floor: you can't pay BELOW fair value on a real book. A NO leg is priced on a
    // SEPARATE book from its de-vigged YES probability, so a stale/thin fallback can imply
    // price < fair (→ positive EV). Floor the pay price at fair and flag it as not-clean-fill.
    if (legQ > price) {
      price = legQ;
      capacityHit = true;
    }
    priced.push({
      title: ref.groupItemTitle ?? ref.question,
      marketTitle: resolved.bundle.title,
      side,
      q: legQ,
      price,
      deepLink: buildMarketDeepLink(ref.eventSlug),
      capacityHit,
      band,
    });
    legSlugs.push(resolved.bundle.slug);
    legInfo.push({
      eventSlug: resolved.bundle.slug,
      index: resolved.index,
      title: ref.groupItemTitle ?? ref.question,
      side,
      negRiskMarketId: ref.negRiskMarketId,
      q: legQ,
    });
  }

  if (priced.length === 0) {
    return { status: "ok", unresolved, pricedAt: new Date().toISOString() };
  }
  // ≥2 YES legs in the SAME market are mutually exclusive → the combo can never all hit.
  const yesPerEvent = new Map<string, number>();
  priced.forEach((l, i) => {
    if (l.side === "yes") yesPerEvent.set(legSlugs[i], (yesPerEvent.get(legSlugs[i]) ?? 0) + 1);
  });
  // Try to DERIVE the joint exactly from market structure (subset/containment or exclusivity);
  // this supersedes both the slug gate and the estimate when it fires.
  const structuralJoint = detectStructuralJoint(legInfo) ?? undefined;
  const mutuallyExclusive = [...yesPerEvent.values()].some((n) => n >= 2) || structuralJoint?.p === 0;

  // Cross-market joint ESTIMATE: only when nothing structural applies, every leg is in a DISTINCT
  // market, and the combo is possible. Shared-entity legs get a higher illustrative ρ.
  const distinctEvents = new Set(legSlugs).size;
  const crossMarket = !mutuallyExclusive && !structuralJoint && priced.length >= 2 && distinctEvents === priced.length;
  let sharedEntity = false;
  for (let i = 0; i < legInfo.length && !sharedEntity; i++)
    for (let j = i + 1; j < legInfo.length; j++) if (sharesEntity(legInfo[i].title, legInfo[j].title)) sharedEntity = true;
  const jointEstimate =
    crossMarket && priced.every((l) => l.band) ? jointAllHit(priced.map((l) => l.band!), { rho: sharedEntity ? 0.6 : 0.25 }) : undefined;

  const result = buildCombo(priced, { stakeUsd, quotedComboPrice: req.quotedComboPrice, mutuallyExclusive, jointEstimate, structuralJoint });
  return { status: "ok", result, unresolved, pricedAt: new Date().toISOString() };
}
