/**
 * Kalshi orderbook → shared Book normalization. The key invariant: a YES contract and a NO
 * contract sum to $1, so the price to BUY YES is the cross of the NO bids (ask = 1 − no_bid).
 * Fixture is the real shape returned by /markets/{ticker}/orderbook (decimal-dollar strings).
 */
import { describe, expect, test } from "vitest";
import { normalizeKalshiBook } from "@/lib/kalshi";
import { CannotPriceError } from "@/lib/polymarket";

// Real ESPKSA-ESP shape: best yes bid 0.88, best no bid 0.11 ⇒ yes ask = 0.89.
const raw = {
  orderbook_fp: {
    no_dollars: [["0.0900", "1583129.00"], ["0.1000", "2035640.86"], ["0.1100", "4539708.53"]] as [string, string][],
    yes_dollars: [["0.8600", "20074.07"], ["0.8700", "66841.65"], ["0.8800", "152712.20"]] as [string, string][],
  },
};

describe("normalizeKalshiBook", () => {
  test("YES book: asks come from the NO bids (ask = 1 − no_bid), bids from YES bids", () => {
    const b = normalizeKalshiBook(raw, "yes", "KXWCGAME-26JUN21ESPKSA-ESP");
    expect(b.bestBid).toBeCloseTo(0.88, 6); // best resting yes bid
    expect(b.bestAsk).toBeCloseTo(0.89, 6); // 1 − 0.11
    expect(b.midpoint).toBeCloseTo(0.885, 6);
    // bids descending, asks ascending
    expect(b.bids.map((l) => l.price)).toEqual([0.88, 0.87, 0.86]);
    expect(b.asks.map((l) => l.price)).toEqual([0.89, 0.9, 0.91]);
    // size carried from the originating level (best ask size = the 0.11 no-bid size)
    expect(b.asks[0].size).toBeCloseTo(4539708.53, 2);
    expect(b.bids[0].size).toBeCloseTo(152712.2, 2);
  });

  test("NO book is the symmetric mirror (ask = 1 − yes_bid)", () => {
    const b = normalizeKalshiBook(raw, "no", "KXWCGAME-26JUN21ESPKSA-KSA");
    expect(b.bestBid).toBeCloseTo(0.11, 6);
    expect(b.bestAsk).toBeCloseTo(0.12, 6); // 1 − 0.88
    expect(b.midpoint).toBeCloseTo(0.115, 6);
  });

  test("degenerate placeholder book is rejected, not faked", () => {
    const degen = { orderbook_fp: { yes_dollars: [["0.0010", "5"]] as [string, string][], no_dollars: [["0.0010", "5"]] as [string, string][] } };
    expect(() => normalizeKalshiBook(degen, "yes", "x")).toThrow(CannotPriceError);
  });

  test("empty book throws rather than fabricating a fill", () => {
    expect(() => normalizeKalshiBook({ orderbook_fp: { yes_dollars: [], no_dollars: [] } }, "yes", "x")).toThrow(CannotPriceError);
  });
});
