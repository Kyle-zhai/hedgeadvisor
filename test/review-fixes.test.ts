import { describe, expect, test } from "vitest";
import { sizeHedge } from "@/lib/sizing";
import { decideHedge } from "@/lib/sizing";
import { priceLeg, type Outcome } from "@/lib/netcost";
import { complementEdge } from "@/lib/correlation";
import type { Book, MarketRef } from "@/lib/types";

const ref: MarketRef = {
  conditionId: "c",
  eventId: "e",
  eventSlug: "world-cup-winner",
  question: "Will Spain win?",
  groupItemTitle: "Spain",
  tokenIdYes: "yes",
  tokenIdNo: "no",
  midpointYes: 0.153,
  resolved: false,
  feeRate: 0.03,
  feeExponent: 1,
  feeTakerOnly: true,
  negRiskMarketId: "nr",
};
const outcomes: Outcome[] = [
  { label: "Spain", q: 0.158 },
  { label: "France", q: 0.175 },
  { label: "Brazil", q: 0.07 },
  { label: "Field", q: 0.597 },
];
const book = (): Book => ({
  bids: [{ price: 0.84, size: 50000 }],
  asks: [
    { price: 0.85, size: 50000 },
    { price: 0.86, size: 50000 },
  ],
  midpoint: 0.845,
  bestBid: 0.84,
  bestAsk: 0.85,
  tokenId: "no",
});

describe("review fix: depth-clip is surfaced, not silently relabeled as Kelly", () => {
  test("capacityLimited=true when the optimum is pinned to the depth ceiling", () => {
    const b = book();
    const pays = new Set([1, 2, 3]);
    const s = sizeHedge({
      outcomes,
      heldIndex: 0,
      heldShares: 6536,
      heldBasisUsd: 1000,
      hedgePaysIn: pays,
      bankrollUsd: 5000,
      maxShares: 100, // tiny cap forces the optimum to the boundary
      costOfShares: (x) => {
        const l = priceLeg(ref, "buy_no", "no", b, x);
        return { cashOutUsd: l.stakeUsd + l.takerFeeUsd, avgPrice: l.avgFillPrice, capacityHit: l.capacityHit };
      },
    });
    expect(s.capacityLimited).toBe(true);
  });

  test("decision adds a sizeNote when capacityLimited", () => {
    const b = book();
    const pays = new Set([1, 2, 3]);
    const leg = priceLeg(ref, "buy_no", "no", b, 300);
    leg.corr = complementEdge("Spain");
    const d = decideHedge({
      heldRef: ref,
      heldShares: 6536,
      heldAvgPrice: 0.153,
      heldBasisUsd: 1000,
      heldIndex: 0,
      outcomes,
      hedge: { leg, paysIn: pays, band: [200, 400] },
      capacityLimited: true,
    });
    expect(d.facts.sizeNote).toBeTruthy();
  });
});

describe("review fix: resolved held position short-circuits", () => {
  test("positionResolved => NO_GO / LEG_RESOLVED", () => {
    const d = decideHedge({
      heldRef: { ...ref, resolved: true },
      heldShares: 6536,
      heldAvgPrice: 0.153,
      heldBasisUsd: 1000,
      heldIndex: 0,
      outcomes,
      hedge: null,
      positionResolved: true,
    });
    expect(d.verdict).toBe("NO_GO");
    expect(d.reason).toBe("LEG_RESOLVED");
  });
});

describe("review fix: deep-link slug is sanitized", () => {
  test("strips path-traversal / cross-origin attempts", async () => {
    const { buildMarketDeepLink } = await import("@/lib/execute/deeplink");
    const u = buildMarketDeepLink("..%2f..%2fevil.com");
    expect(u.startsWith("https://polymarket.com/event/")).toBe(true);
    expect(new URL(u).origin).toBe("https://polymarket.com"); // never cross-origin
    expect(u).not.toContain(".."); // no path traversal
    expect(u).not.toContain("%"); // no encoded escapes survive
    expect(u).not.toContain("/evil.com"); // the host fragment isn't a path/host
  });
});
