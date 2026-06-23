import { NextResponse } from "next/server";
import { z } from "zod";
import { discoverRelations } from "@/lib/relate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// MiniMax-M2.5 is thinking-only; discovery can perform recall and classification sequentially.
export const maxDuration = 300;

const Body = z.object({
  query: z.string().min(1).max(160),
  eventSlug: z.string().min(1).max(160).optional(),
  topK: z.number().int().positive().max(40).optional(),
  stakeUsd: z.number().positive().max(1e6).optional(),
  entryPrice: z.number().gt(0).lt(1).optional(),
  keepFraction: z.number().min(0).max(1).optional(),
  conservatism: z.number().min(0).max(1).optional(),
  maxLegs: z.number().int().min(1).max(8).optional(),
});

export async function POST(req: Request) {
  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
  try {
    let result = await discoverRelations(parsed);
    // Auto-disambiguate a CLEAR leader (fix 1): when the query matched one outcome decisively (mode
    // "outcome") but landed just under the resolve threshold, re-pin the top candidate within its event
    // instead of dead-ending. Mirrors the collection cron. Event-title queries (mode "event") are left
    // ambiguous on purpose so the user picks which outcome they meant.
    if (
      result.status === "ambiguous" && result.mode === "outcome" && result.eventSlug && !parsed.eventSlug &&
      result.candidates && result.candidates.length > 0
    ) {
      const [top, next] = result.candidates;
      const clearLeader = top.score >= 0.6 && top.score - (next?.score ?? 0) >= 0.2;
      if (clearLeader) {
        const pinned = await discoverRelations({ ...parsed, query: top.title, eventSlug: result.eventSlug });
        if (pinned.status === "ok") result = { ...pinned, disambiguatedTo: top.title };
      }
    }
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: `discover failed: ${message}` }, { status: 502 });
  }
}
