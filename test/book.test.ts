import { describe, expect, test } from "vitest";
import { normalizeBook, CannotPriceError } from "@/lib/polymarket/book";

describe("order-book normalization (the reversed-sort fix)", () => {
  test("fixes reversed sort and parses string levels", () => {
    // Polymarket returns bids ASCENDING and asks DESCENDING (opposite of docs).
    const raw = {
      asset_id: "t",
      bids: [
        { price: "0.10", size: "5" },
        { price: "0.15", size: "10" },
      ],
      asks: [
        { price: "0.20", size: "5" },
        { price: "0.16", size: "10" },
      ],
    };
    const b = normalizeBook(raw, "t");
    expect(b.bestBid).toBe(0.15); // highest bid, not bids[0] of raw
    expect(b.bestAsk).toBe(0.16); // lowest ask, not asks[0] of raw
    expect(b.bids[0].price).toBe(0.15);
    expect(b.asks[0].price).toBe(0.16);
    expect(b.midpoint).toBeCloseTo(0.155, 6);
  });

  test("rejects the 0.999/0.001 degenerate placeholder book", () => {
    expect(() =>
      normalizeBook({ bids: [{ price: "0.001", size: "5" }], asks: [{ price: "0.999", size: "5" }] }, "t"),
    ).toThrow(CannotPriceError);
  });

  test("rejects an empty book rather than fabricating a fill", () => {
    expect(() => normalizeBook({ bids: [], asks: [{ price: "0.5", size: "1" }] }, "t")).toThrow(CannotPriceError);
  });
});
