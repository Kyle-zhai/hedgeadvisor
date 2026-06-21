/**
 * lib/explain/llm.ts — OPTIONAL natural-language polish over the deterministic facts.
 *
 * Hard rules (per spec honesty invariant):
 *  - The LLM only EXPLAINS Decision.facts; it never computes or invents numbers.
 *  - Number guardrail: every numeric token in the output must appear in `facts`.
 *    If any doesn't, we discard the LLM output and use the template.
 *  - Comparative-quantity words ("double", "triple", "two-thirds") are banned in the
 *    prompt to stop hallucinated magnitudes that dodge the digit check.
 *  - No key configured / any error → silently fall back to the template.
 */
import type { Decision } from "@/lib/types";
import { explainTemplate } from "./template";

const MODEL = process.env.HEDGE_EXPLAIN_MODEL ?? "anthropic/claude-haiku-4.5";

/** Numbers the model is allowed to use = every number appearing in facts. */
function allowedNumbers(facts: Record<string, string>): Set<string> {
  const set = new Set<string>();
  for (const v of Object.values(facts)) {
    for (const m of v.matchAll(/\d[\d,]*\.?\d*/g)) set.add(m[0].replace(/,/g, ""));
  }
  return set;
}

function passesNumberGuardrail(text: string, facts: Record<string, string>): boolean {
  const allowed = allowedNumbers(facts);
  for (const m of text.matchAll(/\d[\d,]*\.?\d*/g)) {
    const n = m[0].replace(/,/g, "");
    if (!allowed.has(n)) return false;
  }
  return true;
}

export async function explain(d: Decision): Promise<{ text: string; source: "llm" | "template" }> {
  const template = explainTemplate(d);
  if (!process.env.AI_GATEWAY_API_KEY) {
    return { text: template, source: "template" };
  }
  try {
    const { generateText } = await import("ai");
    const factLines = Object.entries(d.facts)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join("\n");
    const { text } = await generateText({
      model: MODEL,
      system:
        "You explain a prediction-market hedge recommendation to a retail user. " +
        "Use ONLY the facts provided. Never state a number that is not in the facts. " +
        "Never use comparative-quantity words like 'double', 'triple', 'half', 'two-thirds', 'roughly X times'. " +
        "Be honest that within-book hedging is EV-negative. 3-5 short sentences. No markdown headers.",
      prompt: `Facts:\n${factLines}\n\nWrite the explanation.`,
      maxRetries: 1,
    });
    const clean = text.trim();
    if (clean && passesNumberGuardrail(clean, d.facts)) {
      return { text: clean, source: "llm" };
    }
    return { text: template, source: "template" };
  } catch {
    return { text: template, source: "template" };
  }
}
