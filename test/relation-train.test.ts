// test/relation-train.test.ts
//
// REPRODUCIBLE, default-SKIP eval+train runner. This is the committed recipe that regenerates the
// published MODELED correction in lib/association/relationCorrection.json from code (replacing the old
// throwaway one-off scripts). It does NOT run in CI (describe.skip) and needs a live Qwen key.
//
//   To regenerate the snapshot:
//     1. ensure .env.local has DASHSCOPE_API_KEY / QWEN_API_KEY
//     2. change `describe.skip` -> `describe.only` (or `describe`)
//     3. npx vitest run test/relation-train.test.ts
//     4. revert the .only and commit the updated relationCorrection.json
//
// HONESTY: the output is a MODELED-tier elicitor nudge (per-mechanism mean(gold - Qwen) on the conditional
// payoffs, applied MODELED-leg-only, never CALIBRATED, never promotes a tier). NOT settlement calibration.
import { describe, it } from "vitest";
import { loadEnvConfig } from "@next/env";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RELATION_GOLD } from "@/lib/association/relationGold";
import { analyzeRelationWithQwen, elicitConditionalWithQwen } from "@/lib/association";
import { scoreRelation, aggregateScores, type PredictedRelation, type RelationScore } from "@/lib/association/relationEval";
import { buildCorrectionFromGold, type ScoredExample, type Correction } from "@/lib/association/relationCorrection";

const CONCURRENCY = 8;

// minimal parallel map with bounded concurrency (no extra deps)
async function pmap<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

describe.skip("LIVE relation train: rebuild the MODELED correction snapshot from gold", () => {
  it("parallel-evals Qwen vs RELATION_GOLD, builds the correction (incl. sd), writes relationCorrection.json", async () => {
    loadEnvConfig(process.cwd()); // populate process.env from .env.local for the live Qwen calls

    const evals = await pmap(RELATION_GOLD, CONCURRENCY, async (g) => {
      // analyzeRelationWithQwen takes MarketRuleInput (gold rows carry only a title); rules unknown ⇒ "".
      const rel = await analyzeRelationWithQwen(
        { title: g.anchor.title, rules: "" },
        { title: g.candidate.title, rules: "" },
      ).catch(() => null);
      const cond = await elicitConditionalWithQwen(g.anchor.title, g.candidate.title).catch(() => null);
      const pred: PredictedRelation = {
        relation: rel?.hypothesis?.relation,
        direction: rel?.hypothesis?.direction,
        mechanismType: rel?.hypothesis?.mechanismGraph?.mechanismType,
        pGivenAnchorWins: cond?.pGivenAnchorWins,
        pGivenAnchorFails: cond?.pGivenAnchorFails,
      };
      return { g, pred };
    });

    const rows: RelationScore[] = evals.map(({ g, pred }) => scoreRelation(g, pred));
    const agg = aggregateScores(rows);

    // Build the correction from rows that have BOTH a predicted mechanism and predicted conditionals.
    const examples: ScoredExample[] = evals
      .filter(({ pred }) =>
        typeof pred.mechanismType === "string" &&
        typeof pred.pGivenAnchorWins === "number" &&
        typeof pred.pGivenAnchorFails === "number")
      .map(({ g, pred }) => ({
        mechanismType: (pred.mechanismType as string).toUpperCase(),
        predFail: pred.pGivenAnchorFails as number,
        goldFail: g.label.pGivenAnchorFails,
        predWin: pred.pGivenAnchorWins as number,
        goldWin: g.label.pGivenAnchorWins,
      }));

    const map = buildCorrectionFromGold(examples); // default minSamples = 8
    const byMechanismType: Record<string, Correction> = {};
    for (const [mech, c] of map) {
      byMechanismType[mech] = {
        biasFail: round4(c.biasFail), biasWin: round4(c.biasWin), n: c.n,
        sdFail: round4(c.sdFail ?? 0), sdWin: round4(c.sdWin ?? 0),
      };
    }

    const out = {
      source: "gold",
      generatedAt: new Date().toISOString(),
      note: "MODELED-tier elicitor correction from the Opus gold eval (relationGold.ts). Per-mechanism mean(gold - Qwen) on the conditional payoffs, applied MODELED-leg-only (never CALIBRATED), shrink 0.5, reliability-shrunk by n/(n+8). sdFail/sdWin are the residual std per mechanism. NOT settlement calibration; never promotes a tier. Regenerate via test/relation-train.test.ts.",
      evalBaseline: {
        rows: agg.overall.n,
        signAccuracy: round4(agg.overall.signAccuracy),
        mechanismAccuracy: round4(agg.overall.mechanismAccuracy),
        condMAE: round4(agg.overall.condMAE),
      },
      byMechanismType,
    };

    const target = resolve(process.cwd(), "lib/association/relationCorrection.json");
    writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
    console.log(`wrote ${target}`);
    console.log(JSON.stringify(agg, null, 2));
  }, 600_000);
});

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
