import { describe, expect, test } from "vitest";
import { decideHedge, sizeHedge } from "@/lib/sizing";
import { priceLeg, type Outcome } from "@/lib/netcost";
import { complementEdge } from "@/lib/correlation";
import type { Book, MarketRef } from "@/lib/types";

function noBook(): Book {
  return {
    bids: [{ price: 0.84, size: 5000 }],
    asks: [
      { price: 0.85, size: 4000 },
      { price: 0.86, size: 4000 },
      { price: 0.88, size: 8000 },
    ],
    midpoint: 0.845,
    bestBid: 0.84,
    bestAsk: 0.85,
    tokenId: "no",
  };
}

const ref: MarketRef = {
  conditionId: "c",
  eventId: "e",
  eventSlug: "world-cup-winner",
  question: "Will Spain win the 2026 World Cup?",
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

describe("decideHedge — the single go/no-go authority", () => {
  test("a complement hedge reduces max loss and returns GO/PARTIAL", () => {
    const heldShares = 6536;
    const basis = 1000;
    const heldIndex = 0;
    const book = noBook();
    const pays = new Set([1, 2, 3]); // all except Spain
    const maxShares = book.asks.reduce((s, l) => s + l.size, 0) * 0.6;

    const size = sizeHedge({
      outcomes,
      heldIndex,
      heldShares,
      heldBasisUsd: basis,
      hedgePaysIn: pays,
      bankrollUsd: 5000,
      maxShares,
      uncertaintyHaircut: 0,
      costOfShares: (x) => {
        const l = priceLeg(ref, "buy_no", "no", book, x);
        return { cashOutUsd: l.stakeUsd + l.takerFeeUsd, avgPrice: l.avgFillPrice, capacityHit: l.capacityHit };
      },
    });
    expect(size.recShares).toBeGreaterThan(0);

    const leg = priceLeg(ref, "buy_no", "no", book, size.recShares);
    leg.corr = complementEdge("Spain");

    const d = decideHedge({
      heldRef: ref,
      heldShares,
      heldAvgPrice: 0.153,
      heldBasisUsd: basis,
      heldIndex,
      outcomes,
      hedge: { leg, paysIn: pays, band: size.band },
    });

    expect(d.riskBefore.maxLoss).toBeCloseTo(1000, 0);
    expect(d.riskAfter.maxLoss).toBeLessThan(d.riskBefore.maxLoss);
    expect(["GO", "PARTIAL"]).toContain(d.verdict);
    // honesty: there is always a positive expected cost (vig) — never framed as free
    expect(d.facts.expectedCostUsd).toBeTruthy();
  });

  test("degenerate book => NO_GO / CANNOT_PRICE (won't fabricate a fill)", () => {
    const d = decideHedge({
      heldRef: ref,
      heldShares: 100,
      heldAvgPrice: 0.153,
      heldBasisUsd: 15,
      heldIndex: 0,
      outcomes,
      hedge: null,
      degenerateBook: true,
    });
    expect(d.verdict).toBe("NO_GO");
    expect(d.reason).toBe("CANNOT_PRICE");
  });

  test("no viable leg => NO_GO / NO_CORRELATED_LEG", () => {
    const d = decideHedge({
      heldRef: ref,
      heldShares: 100,
      heldAvgPrice: 0.153,
      heldBasisUsd: 15,
      heldIndex: 0,
      outcomes,
      hedge: null,
    });
    expect(d.verdict).toBe("NO_GO");
    expect(d.reason).toBe("NO_CORRELATED_LEG");
  });

  test("honesty invariant: never GO when risk isn't actually removed", () => {
    // a leg that pays ONLY when Spain wins increases downside — must be rejected
    const book = noBook();
    const leg = priceLeg(ref, "buy_no", "no", book, 500);
    const d = decideHedge({
      heldRef: ref,
      heldShares: 6536,
      heldAvgPrice: 0.153,
      heldBasisUsd: 1000,
      heldIndex: 0,
      outcomes,
      hedge: { leg, paysIn: new Set([0]), band: [0, 0] },
    });
    expect(d.verdict).toBe("NO_GO");
  });
});
