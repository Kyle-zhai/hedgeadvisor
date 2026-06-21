import { NextResponse } from "next/server";
import { z } from "zod";
import { runCombo } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  legs: z
    .array(z.object({ query: z.string().min(1).max(120), side: z.enum(["yes", "no"]) }))
    .min(1)
    .max(8),
  stakeUsd: z.number().positive().max(1e6).optional(),
  quotedComboPrice: z.number().gt(0).lt(1).optional(),
});

export async function POST(req: Request) {
  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
  try {
    const result = await runCombo(parsed);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: `combo check failed: ${message}` }, { status: 502 });
  }
}
