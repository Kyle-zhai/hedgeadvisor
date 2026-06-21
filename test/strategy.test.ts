import { describe, expect, test } from "vitest";
import { decideStrategy, sizeStrategy, type Strategy } from "@/lib/sizing";
import { priceLegBudget, walkBookBuyBudget, takerFeeUsd, type Outcome } from "@/lib/netcost";
import { complementEdge, rivalEdge } from "@/lib/correlation";
import type { Book, MarketRef } from "@/lib/types";

function mkRef(title: string, midYes: number): MarketRef {
  return {
    conditionId: `c-${title}`,
    eventId: "e",
    eventSlug: "world-cup-winner",
    question: `Will ${title} win?`,
    groupItemTitle: title,
    tokenIdYes: `${title}-yes`,
    tokenIdNo: `${title}-no`,
    midpointYes: midYes,
    resolved: false,
    feeRate: 0.03,
    feeExponent: 1,
    feeTakerOnly: true,
    negRiskMarketId: "nr",
  };
}
function deepBook(price: number, tokenId: string): Book {
  return {
    bids: [{ price: price - 0.005, size: 200000 }],
    asks: [
      { price, size: 100000 },
      { price: price + 0.01, size: 100000 },
    ],
    midpoint: price - 0.0025,
    bestBid: price - 0.005,
    bestAsk: price,
    tokenId,
  };
}

const outcomes: Outcome[] = [
  { label: "Spain", q: 0.158 },
  { label: "France", q: 0.175 },
  { label: "Brazil", q: 0.07 },
  { label: "Field", q: 0.597 },
];
const spain = mkRef("Spain", 0.153);
const heldShares = 6536;
const heldBasisUsd = 1000;
const heldAvgPrice = 0.153;

describe("multi-leg strategy engine", () => {
  test("complement strategy reduces max loss and is a real hedge (GO/PARTIAL)", () => {
    const noBook = deepBook(0.85, "Spain-no");
    const leg = priceLegBudget(spain, "buy_no", "Spain-no", noBook, 500);
    leg.corr = complementEdge("Spain");
    const allExcept = new Set([1, 2, 3]);
    const strategy: Strategy = {
      key: "complement",
      label: "Buy NO · Spain",
      why: complementEdge("Spain").why,
      legs: [leg],
      paysIn: [allExcept],
      band: [400, 600],
    };
    const d = decideStrategy({ heldRef: spain, heldShares, heldAvgPrice, heldBasisUsd, heldIndex: 0, outcomes, strategy });
    expect(d.riskAfter.maxLoss).toBeLessThan(d.riskBefore.maxLoss);
    expect(["GO", "PARTIAL"]).toContain(d.verdict);
    expect(d.facts.strategyKey).toBe("complement");
  });

  test("rival basket RAISES worst case (outsider wins) => honest NO_GO side-bet", () => {
    const france = mkRef("France", 0.17);
    const brazil = mkRef("Brazil", 0.07);
    const fLeg = priceLegBudget(france, "buy_yes", "France-yes", deepBook(0.17, "France-yes"), 250);
    fLeg.corr = rivalEdge("Spain", "France", 0.153, 0.17);
    const bLeg = priceLegBudget(brazil, "buy_yes", "Brazil-yes", deepBook(0.07, "Brazil-yes"), 250);
    bLeg.corr = rivalEdge("Spain", "Brazil", 0.153, 0.07);
    const strategy: Strategy = {
      key: "rival-basket",
      label: "Buy YES · France + Brazil",
      why: "covers France and Brazil branches",
      legs: [fLeg, bLeg],
      paysIn: [new Set([1]), new Set([2])],
      band: [400, 600],
    };
    const d = decideStrategy({ heldRef: spain, heldShares, heldAvgPrice, heldBasisUsd, heldIndex: 0, outcomes, strategy });
    expect(d.verdict).toBe("NO_GO");
    expect(d.facts.detail).toMatch(/side bet|RAISES/i);
    expect(d.legs.length).toBe(2); // both legs surfaced
  });

  test("hedge size is bankroll-sensitive (Kelly), not a flat heuristic", () => {
    const b = deepBook(0.85, "no");
    const legsAtScale = (scaleUsd: number) => {
      const fill = walkBookBuyBudget(b, scaleUsd);
      const p = fill.avgFillPrice ?? b.midpoint;
      const fee = takerFeeUsd(fill.filledShares, p, "buy");
      return {
        legs: [{ shares: fill.filledShares, cashOutUsd: fill.notionalSpent + fee, paysIn: new Set([1, 2, 3]) }],
        capacityHit: fill.capacityHit,
      };
    };
    const mk = (bankrollUsd: number) =>
      sizeStrategy({ outcomes, heldIndex: 0, heldShares: 6536, heldBasisUsd: 1000, bankrollUsd, maxScaleUsd: 6000, legsAtScale });
    const small = mk(5000).recScaleUsd;
    const large = mk(200000).recScaleUsd;
    expect(small).toBeGreaterThan(0);
    expect(small).not.toBe(large); // the bug was: identical regardless of bankroll
    // a position that's a trivial fraction of a huge bankroll warrants less (here ~zero)
    // hedging — the honest "don't pay the vig" answer. Larger bankroll => smaller hedge.
    expect(large).toBeLessThan(small);
  });

  test("sizeStrategy flags capacityLimited when depth binds", () => {
    const tinyBook = deepBook(0.85, "Spain-no");
    const legsAtScale = (scaleUsd: number) => {
      const fill = walkBookBuyBudget(tinyBook, scaleUsd);
      const p = fill.avgFillPrice ?? tinyBook.midpoint;
      const fee = takerFeeUsd(fill.filledShares, p, "buy");
      return {
        legs: [{ shares: fill.filledShares, cashOutUsd: fill.notionalSpent + fee, paysIn: new Set([1, 2, 3]) }],
        capacityHit: fill.capacityHit,
      };
    };
    const s = sizeStrategy({
      outcomes,
      heldIndex: 0,
      heldShares,
      heldBasisUsd,
      bankrollUsd: 5000,
      maxScaleUsd: 50, // tiny -> optimum pinned to the ceiling
      legsAtScale,
    });
    expect(s.capacityLimited).toBe(true);
    expect(s.recScaleUsd).toBeGreaterThan(0);
  });
});
