import { describe, it, expect } from "vitest";
import { pmEventToIndexRows, kalshiToIndexRows } from "@/lib/relate/marketIndex";
import type { KalshiMarket, KalshiEventMeta } from "@/lib/kalshi";

describe("pmEventToIndexRows", () => {
  it("maps open PM event markets to index rows", () => {
    const rows = pmEventToIndexRows({
      slug: "world-cup-winner", title: "World Cup Winner", closed: false,
      markets: [{ conditionId: "0xabc", groupItemTitle: "France" }, { conditionId: "0xdef", question: "Spain to win?" }],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ venue: "polymarket", marketId: "0xabc", eventKey: "world-cup-winner", marketTitle: "France", status: "open" });
    expect(rows[1].marketTitle).toBe("Spain to win?");
  });
  it("skips closed events + markets with no id/label", () => {
    expect(pmEventToIndexRows({ slug: "x", closed: true, markets: [{ conditionId: "0x1", groupItemTitle: "y" }] })).toHaveLength(0);
    expect(pmEventToIndexRows({ slug: "x", closed: false, markets: [{ groupItemTitle: "no-id" }, { conditionId: "0x2" }] })).toHaveLength(0);
  });
});

describe("kalshiToIndexRows", () => {
  const ev: KalshiEventMeta = { eventTicker: "EVT-26", seriesTicker: "EVT", title: "Some Event", subTitle: "", mutuallyExclusive: true, feeMultiplier: 1, category: "Economics" };
  const mkt = (ticker: string, result: "yes" | "no" | "", status = "active"): KalshiMarket => ({ ticker, eventTicker: "EVT-26", seriesTicker: "EVT", label: ticker + " label", yesBid: null, yesAsk: null, yesMid: 0.5, last: 0.5, rules: "", status, result, settledAtMs: null, deepLink: "" });
  it("maps OPEN Kalshi markets to index rows, skipping settled", () => {
    const rows = kalshiToIndexRows(ev, [mkt("A", ""), mkt("B", "yes"), mkt("C", "")]);
    expect(rows.map((r) => r.marketId)).toEqual(["A", "C"]); // B is settled (result=yes) ⇒ skipped
    expect(rows[0]).toMatchObject({ venue: "kalshi", eventKey: "EVT-26", category: "Economics" });
  });
});
