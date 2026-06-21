import { describe, expect, test } from "vitest";
import { walkBookBuyBudget, walkBookBuyBudgetCapped, bandDepthUsd } from "@/lib/netcost";
import type { Book } from "@/lib/types";

// Mirrors the live "England 0-3" exact-score book (the phantom-depth trap):
// touch is cheap, a few cents of real depth, then the ladder is climbed at up to ~12x.
const phantomBook: Book = {
  bids: [{ price: 0.02, size: 100 }],
  asks: [
    { price: 0.024, size: 100 }, // ~$2.4 at touch
    { price: 0.05, size: 50 }, //   ~$2.5 within +3c band (cap = 0.054)
    { price: 0.15, size: 500 }, //  outside band — the trap
    { price: 0.29, size: 5000 }, // outside band — deep, far above touch
  ],
  midpoint: 0.022,
  bestBid: 0.02,
  bestAsk: 0.024,
  tokenId: "eng-0-3",
};

describe("capped near-touch walk (the phantom-depth guard)", () => {
  test("UNCAPPED walk fabricates a $20 fill by climbing 12x the touch (the bug)", () => {
    const f = walkBookBuyBudget(phantomBook, 20);
    expect(f.capacityHit).toBe(false); // it 'fills' the whole $20...
    expect(f.avgFillPrice).toBeGreaterThan(0.05); // ...but only by climbing far past touch
  });

  test("CAPPED walk declines: only ~$5 clears within +3c, rest is honestly capacityHit", () => {
    const f = walkBookBuyBudgetCapped(phantomBook, 20, 3);
    expect(f.fillableUsd).toBeLessThan(20);
    expect(f.fillableUsd).toBeLessThan(6); // ~$4.9 of real near-touch depth
    expect(f.capacityHit).toBe(true); // couldn't deploy $20 within the band — honest
    expect(f.worstFillPrice).toBeLessThanOrEqual(0.054 + 1e-9); // never climbed past the band
  });

  test("bandDepthUsd reports the real near-touch depth (for the pre-optimizer gate)", () => {
    expect(bandDepthUsd(phantomBook, 3)).toBeLessThan(6);
  });

  test("a deep book fills fully within the band (no false positive)", () => {
    const deep: Book = {
      bids: [{ price: 0.56, size: 100000 }],
      asks: [{ price: 0.57, size: 100000 }],
      midpoint: 0.565,
      bestBid: 0.56,
      bestAsk: 0.57,
      tokenId: "eng-win",
    };
    const f = walkBookBuyBudgetCapped(deep, 200, 3);
    expect(f.capacityHit).toBe(false);
    expect(f.fillableUsd).toBeGreaterThanOrEqual(199);
  });
});
