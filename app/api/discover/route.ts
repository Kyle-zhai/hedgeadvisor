import { NextResponse } from "next/server";
import { z } from "zod";
import { discoverRelations } from "@/lib/relate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const result = await discoverRelations(parsed);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: `discover failed: ${message}` }, { status: 502 });
  }
}
