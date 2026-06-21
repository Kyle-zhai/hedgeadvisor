/**
 * app/api/diag/qwen/route.ts — secret-gated diagnostic: runs the REAL Qwen relation classifier
 * (including the strict Zod schema validation) on one fixed pair and reports status + the exact
 * failure reason. Lets the GitHub Actions runner show WHY classification yields no mechanism graph.
 */
import { NextResponse } from "next/server";
import { analyzeRelationWithQwen } from "@/lib/association";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const res = await analyzeRelationWithQwen(
    { title: "France — World Cup Winner", rules: "Resolves YES if France wins the 2026 FIFA World Cup." },
    { title: "France head coach departs — Coach Exit", rules: "Resolves YES if France's national-team head coach departs his role by 31 Dec 2026." },
  );
  return NextResponse.json({
    status: res.status, // ok | disabled | error
    model: res.model,
    reason: res.reason ?? null, // schema-validation detail / HTTP code / timeout message
    hasGraph: Boolean(res.hypothesis?.mechanismGraph),
    relation: res.hypothesis?.relation ?? null,
    portability: res.hypothesis?.mechanismGraph?.portability ?? null,
  });
}
