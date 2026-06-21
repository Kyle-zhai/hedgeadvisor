import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchEventBundle } from "@/lib/polymarket";
import { requote } from "@/lib/execute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  eventSlug: z.string().min(1).max(120),
  conditionId: z.string().min(1).max(80),
  side: z.enum(["buy_yes", "buy_no"]),
  shares: z.number().positive().max(1e9),
  recoPayUsd: z.number().nonnegative(),
});

export async function POST(req: Request) {
  let body;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
  try {
    const bundle = await fetchEventBundle(body.eventSlug);
    const ref = bundle?.markets.find((m) => m.conditionId === body.conditionId);
    if (!ref) return NextResponse.json({ error: "market not found" }, { status: 404 });
    const tokenId = body.side === "buy_no" ? ref.tokenIdNo : ref.tokenIdYes;
    const rq = await requote(ref, body.side, tokenId, body.shares, body.recoPayUsd);
    return NextResponse.json(rq);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: `requote failed: ${message}` }, { status: 502 });
  }
}
