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

// ── Gate 2: query-term construction (floor 3 + word boundaries + short-anchor expansion) ─────────────────
import { buildIndexQueryTerms } from "@/lib/relate/marketIndex";

describe("buildIndexQueryTerms", () => {
  it("keeps >=4-char tokens as substring terms, longest (most specific) first", () => {
    const { sub } = buildIndexQueryTerms(["reserve", "bitcoin", "cut"]);
    expect(sub).toContain("reserve");
    expect(sub).toContain("bitcoin");
    expect(sub[0].length).toBeGreaterThanOrEqual(sub[sub.length - 1].length);
  });

  it("routes 3-char tokens to the word-boundary path (fed never matches federer)", () => {
    const { sub, word } = buildIndexQueryTerms(["fed", "gdp"]);
    expect(word).toContain("gdp");
    expect(word).toContain("fed");
    expect(sub).toContain("federal reserve"); // known short anchor also expands to its written-out form
  });

  it("expands known short anchors (uk/eu/ai) that would otherwise recall nothing", () => {
    const { sub } = buildIndexQueryTerms(["uk", "eu", "ai"]);
    expect(sub).toContain("united kingdom");
    expect(sub).toContain("european union");
    expect(sub).toContain("artificial intelligence");
  });

  it("dedupes, drops empties, and caps: 8 substring terms + 4 word terms", () => {
    const many = ["alpha1", "alpha2", "alpha3", "alpha4", "alpha5", "alpha6", "alpha7", "alpha8", "alpha9", "alpha9", ""];
    const { sub } = buildIndexQueryTerms(many);
    expect(sub.length).toBeLessThanOrEqual(8);
    const { word } = buildIndexQueryTerms(["abc", "xyz", "cpi", "sec", "fda", "nlp"]);
    expect(word.length).toBeLessThanOrEqual(4);
  });

  it("2-char tokens without a known expansion are dropped (noise)", () => {
    const { sub, word } = buildIndexQueryTerms(["zz"]);
    expect(sub).toHaveLength(0);
    expect(word).toHaveLength(0);
  });
});
