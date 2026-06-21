import { NextResponse } from "next/server";
import { fetchEventBundle, fetchMidpoints } from "@/lib/polymarket";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// An event's outcomes with LIVE mid prices — for the Markets page to show all related bets + prices.
export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("slug");
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });
  try {
    const bundle = await fetchEventBundle(slug);
    if (!bundle || bundle.markets.length === 0) return NextResponse.json({ error: "not found" }, { status: 404 });
    try {
      const mids = await fetchMidpoints(bundle.markets.map((m) => m.tokenIdYes));
      if (mids.size) for (const m of bundle.markets) { const v = mids.get(m.tokenIdYes); if (v !== undefined) m.midpointYes = v; }
    } catch {
      /* keep snapshot */
    }
    const outcomes = bundle.markets
      .map((m) => ({ title: m.groupItemTitle ?? m.question, price: Number((m.midpointYes || 0).toFixed(4)) }))
      .filter((o) => o.price > 0)
      .sort((a, b) => b.price - a.price);
    return NextResponse.json({ title: bundle.title, slug, outcomes });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 502 });
  }
}
