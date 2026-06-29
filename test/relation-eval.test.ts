// test/relation-eval.test.ts
import { describe, it } from "vitest";
import { RELATION_GOLD } from "@/lib/association/relationGold";
import { analyzeRelationWithQwen, elicitConditionalWithQwen } from "@/lib/association";
import { scoreRelation, aggregateScores, type PredictedRelation, type RelationScore } from "@/lib/association/relationEval";

// LIVE: needs DASHSCOPE_API_KEY/QWEN_API_KEY. Un-skip to produce the baseline. Never runs in CI.
describe.skip("LIVE relation judgment eval vs gold", () => {
  it("scores Qwen against the gold set", async () => {
    const rows: RelationScore[] = [];
    for (const g of RELATION_GOLD) {
      // analyzeRelationWithQwen takes MarketRuleInput (the gold rows carry only a title); rules unknown ⇒ "".
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
      rows.push(scoreRelation(g, pred));
    }
    console.log(JSON.stringify(aggregateScores(rows), null, 2));
  }, 600_000);
});
