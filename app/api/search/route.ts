import { NextResponse } from "next/server";
import { z } from "zod";
import { searchEvents, searchFixtures, searchOutcomes } from "@/lib/polymarket";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Q = z.object({
  q: z.string().max(80).optional(),
  scope: z.enum(["events", "fixtures", "outcomes"]).default("events"),
  slug: z.string().max(160).optional(),
});

// Typeahead over REAL live Polymarket markets. Degrades to an empty list (200) on any
// upstream hiccup so the input never breaks; never fabricates a market.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = Q.safeParse({
    q: url.searchParams.get("q") ?? undefined,
    scope: url.searchParams.get("scope") ?? undefined,
    slug: url.searchParams.get("slug") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ suggestions: [] }, { status: 400 });
  const { q, scope, slug } = parsed.data;
  try {
    const suggestions =
      scope === "outcomes" && slug
        ? await searchOutcomes(slug)
        : scope === "fixtures"
          ? await searchFixtures(q ?? "")
          : await searchEvents(q ?? "");
    return NextResponse.json({ suggestions });
  } catch {
    return NextResponse.json({ suggestions: [] });
  }
}
