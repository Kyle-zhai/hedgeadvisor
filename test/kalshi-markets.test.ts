import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchKalshiMarkets, listKalshiEvents } from "@/lib/kalshi/markets";

afterEach(() => vi.unstubAllGlobals());

describe("Kalshi catalog completeness", () => {
  test("can enumerate open events globally without an empty series filter", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.has("series_ticker")).toBe(false);
      expect(url.searchParams.get("status")).toBe("open");
      return new Response(JSON.stringify({ events: [{ event_ticker: "KXGLOBAL-1", series_ticker: "KXGLOBAL", title: "Global" }], cursor: "" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const events = await listKalshiEvents("", 1);
    expect(events[0]?.eventTicker).toBe("KXGLOBAL-1");
  });

  test("follows event cursors instead of silently dropping later pages", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const cursor = url.searchParams.get("cursor");
      return new Response(JSON.stringify(cursor
        ? { events: [{ event_ticker: "KXTESTPAGE-2", series_ticker: "KXTESTPAGE", title: "Page 2" }], cursor: "" }
        : { events: [{ event_ticker: "KXTESTPAGE-1", series_ticker: "KXTESTPAGE", title: "Page 1" }], cursor: "next" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const events = await listKalshiEvents("KXTESTPAGE", 3, "all");
    expect(events.map((e) => e.eventTicker)).toEqual(["KXTESTPAGE-1", "KXTESTPAGE-2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("settlement reads merge archived markets from the historical tier", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const historical = url.pathname.includes("/historical/markets");
      const body = historical ? {
        markets: [{
          ticker: "KXTESTHIST-YES",
          event_ticker: "KXTESTHIST",
          yes_sub_title: "Champion",
          status: "finalized",
          result: "yes",
          rules_primary: "Pays if champion is said.",
        }],
        cursor: "",
      } : { markets: [], cursor: "" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const markets = await fetchKalshiMarkets("KXTESTHIST", true);
    expect(markets).toHaveLength(1);
    expect(markets[0]).toMatchObject({ ticker: "KXTESTHIST-YES", status: "finalized", result: "yes" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
