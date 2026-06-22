/**
 * app/api/diag/elicit/route.ts — secret-gated VALIDATION harness for the cross-event dependence
 * estimator (lib/association/elicit + correlation/frechetProjectedPhi). POST a ground-truth pair set;
 * it elicits the conditional probabilities from the LLM, derives the Fréchet-projected signed φ, and
 * reports per-pair results + overall sign accuracy. Lets us empirically validate the method (and
 * compare against the old engine's ~0 default) without exposing the API key.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { elicitConditionalWithQwen } from "@/lib/association";
import { frechetProjectedPhi } from "@/lib/correlation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const Pair = z.object({
  anchorTitle: z.string().min(1).max(200),
  candidateTitle: z.string().min(1).max(200),
  pA: z.number().min(0).max(1),
  pB: z.number().min(0).max(1),
  expectedSign: z.enum(["positive", "negative", "zero"]).optional(),
});
const Body = z.object({ pairs: z.array(Pair).min(1).max(24) });

const sign = (phi: number): "positive" | "negative" | "zero" => (phi > 0.05 ? "positive" : phi < -0.05 ? "negative" : "zero");

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const results: Record<string, unknown>[] = [];
  let scored = 0;
  let correct = 0;
  for (const p of parsed.pairs) {
    const e = await elicitConditionalWithQwen(p.anchorTitle, p.candidateTitle);
    if (e.status !== "ok" || e.pGivenAnchorWins == null) {
      results.push({ ...p, status: e.status, failReason: e.failReason ?? null });
      continue;
    }
    const fp = frechetProjectedPhi(p.pA, p.pB, e.pGivenAnchorWins);
    const got = sign(fp.phi);
    const ok = p.expectedSign ? got === p.expectedSign : null;
    if (p.expectedSign) { scored++; if (ok) correct++; }
    results.push({
      anchorTitle: p.anchorTitle,
      candidateTitle: p.candidateTitle,
      pGivenAnchorWins: e.pGivenAnchorWins,
      pGivenAnchorFails: e.pGivenAnchorFails ?? null,
      llmConfidence: e.confidence ?? null,
      phi: fp.phi,
      pAB: fp.pAB,
      frechetClamped: fp.clamped,
      sign: got,
      expectedSign: p.expectedSign ?? null,
      signCorrect: ok,
      reason: e.reason ?? null,
    });
  }
  return NextResponse.json({
    model: parsed.pairs.length ? "qwen" : null,
    signAccuracy: scored ? Number((correct / scored).toFixed(3)) : null,
    scored,
    correct,
    results,
  });
}
