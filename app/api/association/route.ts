import { NextResponse } from "next/server";
import { z } from "zod";
import { buildHybridHedgeRecommendation } from "@/lib/association";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Market = z.object({
  title: z.string().min(1).max(500),
  rules: z.string().min(1).max(20_000),
  closeTime: z.string().max(100).optional(),
});

const Candidate = z.object({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(500),
  venue: z.enum(["polymarket", "kalshi"]),
  side: z.enum(["yes", "no"]),
  price: z.number().positive().lt(1),
  maxSpendUsd: z.number().positive().max(1e7).optional(),
  market: Market,
});

const Body = z.object({
  anchor: Market,
  stakeUsd: z.number().positive().max(1e7),
  primaryPrice: z.number().positive().lt(1),
  keepFraction: z.number().min(0).max(1).default(0.5),
  conservatism: z.number().min(0).max(1).default(0.5),
  maxLegs: z.number().int().min(1).max(8).default(3),
  credibleLevel: z.number().min(0.5).max(0.999).default(0.95),
  minSamplesPerBranch: z.number().int().min(2).max(10_000).default(20),
  analyzeWithLlm: z.boolean().default(true),
  candidates: z.array(Candidate).min(1).max(12),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body", issues: parsed.error.flatten() }, { status: 400 });
  }
  try {
    return NextResponse.json(await buildHybridHedgeRecommendation(parsed.data));
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: `association analysis failed: ${message}` }, { status: 502 });
  }
}
