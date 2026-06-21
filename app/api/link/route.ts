import { NextResponse } from "next/server";
import { z } from "zod";
import { relateCrossVenue } from "@/lib/link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  query: z.string().min(1).max(160),
  eventSlug: z.string().min(1).max(160).optional(),
  stakeUsd: z.number().positive().max(1e6).optional(),
});

export async function POST(req: Request) {
  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
  try {
    const result = await relateCrossVenue(parsed);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: `link failed: ${message}` }, { status: 502 });
  }
}
