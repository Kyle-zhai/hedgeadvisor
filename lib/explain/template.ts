/**
 * lib/explain/template.ts — deterministic explanation built ONLY from Decision.facts.
 * This is the source of truth the LLM layer must not contradict, and the fallback
 * whenever the LLM is unavailable or fails the number-guardrail.
 */
import type { Decision } from "@/lib/types";

export function explainTemplate(d: Decision): string {
  const f = d.facts;
  const lines: string[] = [];

  if (d.verdict === "GO") {
    lines.push(`✅ ${f.headline}`);
    lines.push(
      `Hedging ${f.hedgeShares} shares (${f.hedgeDesc}) cuts your worst-case loss from ${f.maxLossBefore} to ${f.maxLossAfter} (that's ${f.maxLossReduction} of downside removed) and lowers your P&L swing by ${f.stdDevReductionPct}.`,
    );
    lines.push(
      `Out-of-pocket execution cost: ${f.execCostUsd} (slippage vs mid, which already includes the half-spread, plus the taker fee). Expected cost including the market's vig: ${f.expectedCostUsd}. That's ${f.eta}× risk removed per dollar.`,
    );
  } else if (d.verdict === "PARTIAL") {
    lines.push(`🟡 ${f.headline}`);
    lines.push(
      `At full size the book is too thin or the cost/benefit is marginal. A smaller hedge of ${f.hedgeShares} shares (${f.hedgeDesc}) removes ${f.maxLossReduction} of worst-case loss for ${f.execCostUsd}.`,
    );
  } else {
    lines.push(`🔴 ${f.headline}`);
    lines.push(f.detail ?? `It would cost ${f.expectedCostUsd ?? "more"} but remove too little risk. Holding is rational.`);
  }

  if (f.sizeNote) lines.push(`⚠️ ${f.sizeNote}`);
  if (f.corrWhy) lines.push(`Why: ${f.corrWhy}`);
  if (f.vigNote) lines.push(f.vigNote);
  if (d.verdict !== "NO_GO" && f.makerTip) lines.push(`💡 ${f.makerTip}`);

  return lines.filter(Boolean).join("\n\n");
}
