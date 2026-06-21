import { describe, expect, test } from "vitest";
import { walkBookBuy } from "@/lib/netcost";
import type { Book } from "@/lib/types";

const book: Book = {
  bids: [{ price: 0.84, size: 1000 }],
  asks: [
    { price: 0.85, size: 400 },
    { price: 0.86, size: 400 },
    { price: 0.9, size: 1000 },
  ],
  midpoint: 0.845,
  bestBid: 0.84,
  bestAsk: 0.85,
  tokenId: "t",
};

describe("walkBookBuy (true executable price, never the midpoint)", () => {
  test("walks levels and computes VWAP + slippage vs mid", () => {
    const f = walkBookBuy(book, 600);
    // 400@0.85 + 200@0.86 = 340 + 172 = 512; /600 = 0.853333
    expect(f.avgFillPrice).toBeCloseTo(0.853333, 5);
    expect(f.capacityHit).toBe(false);
    expect(f.slippagePerShare).toBeCloseTo(0.853333 - 0.845, 5);
    expect(f.filledShares).toBe(600);
  });

  test("flags capacity hit when size exceeds available depth", () => {
    const f = walkBookBuy(book, 5000);
    expect(f.capacityHit).toBe(true);
    expect(f.unfilledShares).toBeGreaterThan(0);
  });
});
