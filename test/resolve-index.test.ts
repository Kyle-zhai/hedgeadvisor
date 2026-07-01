import { describe, expect, test } from "vitest";
import { rankIndexEvents } from "@/lib/polymarket/resolveAny";

/** §19 resolution-from-index: the pure event-ranking half (the DB/live halves are fail-safe glue). */

const hit = (eventKey: string, title: string, marketTitle = "") => ({ eventKey, title, marketTitle });

describe("rankIndexEvents", () => {
  test("ranks the genuinely-matching event first (Jaccard, not raw count)", () => {
    const slugs = rankIndexEvents(
      ["bitcoin", "above", "150k"],
      [
        hit("btc-2026", "Bitcoin prices 2026", "Bitcoin above $150k"),
        hit("sprawl", "A very long unrelated market title mentioning bitcoin once among many many words", "and more words here"),
        hit("weather", "Hottest year on record", "2026"),
      ],
    );
    expect(slugs[0]).toBe("btc-2026");
    expect(slugs).not.toContain("weather");
  });

  test("dedupes to distinct events, keeps each event's best row score, caps at maxEvents", () => {
    const slugs = rankIndexEvents(
      ["recession", "2026"],
      [
        hit("rec", "US recession in 2026", "Yes"),
        hit("rec", "US recession in 2026", "recession declared 2026"), // same event, second row
        hit("gdp", "GDP growth 2026", "below 1%"),
        hit("cpi", "CPI 2026", "above 3%"),
        hit("fed", "Fed decision 2026", "cut"),
        hit("oil", "Oil price 2026", "above 100"),
      ],
      3,
    );
    expect(slugs.filter((s) => s === "rec")).toHaveLength(1);
    expect(slugs[0]).toBe("rec");
    expect(slugs.length).toBeLessThanOrEqual(3);
  });

  test("zero-overlap hits are dropped entirely (no noise events)", () => {
    expect(rankIndexEvents(["nvidia"], [hit("x", "Something else", "entirely")])).toHaveLength(0);
  });
});
