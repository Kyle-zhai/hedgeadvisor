import { NextResponse } from "next/server";
import { z } from "zod";
import { runPlan } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    query: z.string().min(1).max(120),
    budgetUsd: z.number().positive().max(1e6).optional(),
    budget: z.number().positive().max(1e6).optional(),
    sliderS: z.number().min(0).max(1).optional(),
    s: z.number().min(0).max(1).optional(),
    slider: z.number().min(0).max(1).optional(),
    maxLegs: z.number().int().min(1).max(20).optional(),
  })
  .transform(({ query, budgetUsd, budget, sliderS, s, slider, maxLegs }) => ({
    query,
    budgetUsd: budgetUsd ?? budget,
    sliderS: sliderS ?? s ?? slider,
    maxLegs,
  }));

export async function POST(req: Request) {
  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
  try {
    const result = await runPlan(parsed);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: `plan failed: ${message}` }, { status: 502 });
  }
}
