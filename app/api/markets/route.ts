import { NextResponse } from "next/server";
import { gammaGet, parseJsonArray } from "@/lib/polymarket/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RawMarket {
  id?: string;
  slug?: string;
  question?: string;
  groupItemTitle?: string;
  outcomePrices?: unknown;
  bestBid?: number | string;
  bestAsk?: number | string;
  lastTradePrice?: number | string;
  oneDayPriceChange?: number | string;
  volume24hr?: number | string;
  volume?: number | string;
  liquidity?: number | string;
  endDate?: string;
  events?: { slug?: string; title?: string; category?: string }[];
}

const n = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function categoryFor(value: string) {
  const text = value.toLowerCase();
  if (/world cup|nba|nfl|mlb|nhl|champion|match|game|league|tournament|final/.test(text)) return "Sports";
  if (/bitcoin|ethereum|crypto|btc|eth|token/.test(text)) return "Crypto";
  if (/fed|rate|inflation|gdp|recession|econom/.test(text)) return "Economics";
  if (/election|president|congress|senate|approval|minister|party/.test(text)) return "Politics";
  if (/stock|earnings|apple|nvidia|tesla|openai/.test(text)) return "Business";
  return "Other";
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const limit = Math.min(100, Math.max(12, n(params.get("limit"), 48)));
  try {
    const rows = await gammaGet<RawMarket[]>(`/markets?active=true&closed=false&limit=${limit}&order=volume24hr&ascending=false`);
    const markets = rows.map((market) => {
      const prices = parseJsonArray(market.outcomePrices).map(Number).filter(Number.isFinite);
      const yes = n(market.lastTradePrice, prices[0] ?? 0);
      const bid = n(market.bestBid, Math.max(0, yes - 0.01));
      const ask = n(market.bestAsk, Math.min(1, yes + 0.01));
      const event = market.events?.[0];
      const title = event?.title || market.question || "Untitled market";
      const outcome = market.groupItemTitle || market.question || title;
      return {
        id: market.id || market.slug || `${title}-${outcome}`,
        slug: event?.slug || market.slug || "",
        title,
        outcome,
        category: event?.category || categoryFor(`${title} ${outcome}`),
        yesPrice: yes,
        change24h: n(market.oneDayPriceChange),
        spread: Math.max(0, ask - bid),
        liquidity: n(market.liquidity),
        volume24h: n(market.volume24hr),
        volume: n(market.volume),
        endDate: market.endDate || null,
      };
    }).filter((market) => market.yesPrice > 0 && market.yesPrice < 1);

    return NextResponse.json({ markets, pricedAt: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "failed to load markets" }, { status: 502 });
  }
}
