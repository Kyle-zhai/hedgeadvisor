import { NextResponse } from "next/server";
import { z } from "zod";
import { runHedge } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  query: z.string().min(1).max(120),
  eventSlug: z.string().max(120).optional(),
  stakeUsd: z.number().positive().max(1e7).optional(),
  shares: z.number().positive().max(1e9).optional(),
  avgPrice: z.number().gt(0).lt(1).optional(),
  bankrollUsd: z.number().positive().max(1e9).optional(),
});

export async function POST(req: Request) {
  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
  try {
    const result = await runHedge(parsed);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: `hedge analysis failed: ${message}` }, { status: 502 });
  }
}
