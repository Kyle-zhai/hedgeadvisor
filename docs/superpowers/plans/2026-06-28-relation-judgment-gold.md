# Relationship-Judgment Gold Dataset + Eval + Calibration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a labeled relationship gold dataset, a repeatable eval of the engine's LLM relationship judgment, and gold-derived improvements (few-shot + meta-calibration) — all MODELED-only, never feeding CALIBRATED.

**Architecture:** Pure data + pure scoring + a default-skip live harness (Phase 1); flag-gated few-shot prompt anchors (Phase 2); a gold-derived per-mechanism correction applied only to the MODELED `modeledPayoff` path (Phase 3). Mirrors existing types in `lib/association/types.ts`; the two judgment entry points are `analyzeRelationWithQwen` (relation/mechanism) and `elicitConditionalWithQwen` (conditional probabilities).

**Tech Stack:** TypeScript, Vitest, the existing `lib/association` engine. Tests run `npx vitest run`; types `npx tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-06-28-relation-judgment-gold-design.md`

**Branch:** continue on `moat-f2-direction-bucket`.

---

## Phase 1 — gold dataset + scoring + baseline eval

### Task 1: `GoldRelation` type + seed dataset with integrity test

**Files:**
- Create: `lib/association/relationGold.ts`
- Test: `test/relation-gold.test.ts`

- [ ] **Step 1: Write the failing integrity test**

```ts
// test/relation-gold.test.ts
import { describe, it, expect } from "vitest";
import { RELATION_GOLD, type GoldRelation } from "@/lib/association/relationGold";

const DIRECTIONS = new Set(["POSITIVE", "NEGATIVE", "AMBIGUOUS"]);
describe("relation gold dataset integrity", () => {
  it("has unique ids and valid, in-range fields", () => {
    const ids = new Set<string>();
    for (const g of RELATION_GOLD as GoldRelation[]) {
      expect(ids.has(g.id), `dup id ${g.id}`).toBe(false); ids.add(g.id);
      expect(DIRECTIONS.has(g.label.direction)).toBe(true);
      expect(g.label.pGivenAnchorWins).toBeGreaterThanOrEqual(0);
      expect(g.label.pGivenAnchorWins).toBeLessThanOrEqual(1);
      expect(g.label.pGivenAnchorFails).toBeGreaterThanOrEqual(0);
      expect(g.label.pGivenAnchorFails).toBeLessThanOrEqual(1);
      expect(g.anchor.title.length).toBeGreaterThan(0);
      expect(g.candidate.title.length).toBeGreaterThan(0);
    }
  });
  it("includes negative controls (UNRELATED/AMBIGUOUS)", () => {
    const negs = RELATION_GOLD.filter((g) => g.label.relation === "UNRELATED" || g.label.direction === "AMBIGUOUS");
    expect(negs.length).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/relation-gold.test.ts`
Expected: FAIL — cannot resolve `@/lib/association/relationGold`.

- [ ] **Step 3: Create the type + a seed of fully-worked rows**

```ts
// lib/association/relationGold.ts
import type { AssociationRelation, AssociationDirection, MechanismType, MechanismScope } from "./types";

export interface GoldRelation {
  id: string;
  domain: string;
  relationType: string;
  anchor: { title: string; eventClass: string };
  candidate: { title: string; eventClass: string };
  label: {
    relation: AssociationRelation;
    direction: Extract<AssociationDirection, "POSITIVE" | "NEGATIVE" | "AMBIGUOUS">;
    mechanismType: MechanismType;
    scope: MechanismScope;
    pGivenAnchorWins: number;
    pGivenAnchorFails: number;
    strengthBand: "strong" | "moderate" | "weak" | "none";
    counterexamples: string[];
    confidence: number;
  };
  basis: "logical" | "causal" | "historical";
  labeledBy: "opus-4.8";
  rationale: string;
}

export const RELATION_GOLD: GoldRelation[] = [
  {
    id: "logic-btc-threshold-implication",
    domain: "crypto", relationType: "logical-implication",
    anchor: { title: "Bitcoin above $100,000 in 2026", eventClass: "asset_price_threshold" },
    candidate: { title: "Bitcoin above $90,000 in 2026", eventClass: "asset_price_threshold" },
    label: { relation: "IMPLICATION", direction: "POSITIVE", mechanismType: "IMPLICATION", scope: "SAME_ENTITY",
      pGivenAnchorWins: 1.0, pGivenAnchorFails: 0.25, strengthBand: "strong",
      counterexamples: ["price gaps from $80k to $110k without printing $90k"], confidence: 0.97 },
    basis: "logical", labeledBy: "opus-4.8",
    rationale: "Monotonic price: hitting $100k entails having hit $90k.",
  },
  {
    id: "logic-wc-mutex-france-spain",
    domain: "sports", relationType: "logical-mutex",
    anchor: { title: "France win the 2026 World Cup", eventClass: "tournament_winner" },
    candidate: { title: "Spain win the 2026 World Cup", eventClass: "tournament_winner" },
    label: { relation: "MUTEX", direction: "NEGATIVE", mechanismType: "LOGICAL", scope: "CROSS_ENTITY",
      pGivenAnchorWins: 0.0, pGivenAnchorFails: 0.18, strengthBand: "strong",
      counterexamples: ["tournament cancelled / shared title (effectively impossible)"], confidence: 0.99 },
    basis: "logical", labeledBy: "opus-4.8",
    rationale: "Only one nation wins; if France wins, Spain cannot.",
  },
  {
    id: "causal-spain-star-injury",
    domain: "sports", relationType: "same-entity-causal",
    anchor: { title: "Spain win the 2026 World Cup", eventClass: "tournament_winner" },
    candidate: { title: "Spain's first-choice striker ruled out injured before the final", eventClass: "player_injury" },
    label: { relation: "CAUSAL", direction: "NEGATIVE", mechanismType: "CAUSAL", scope: "ENTITY_SPECIFIC",
      pGivenAnchorWins: 0.05, pGivenAnchorFails: 0.18, strengthBand: "moderate",
      counterexamples: ["a deep squad wins despite the injury"], confidence: 0.7 },
    basis: "causal", labeledBy: "opus-4.8",
    rationale: "Losing a key player lowers win probability, so the injury is more likely in the fail branch.",
  },
  {
    id: "neg-control-btc-vs-oscars",
    domain: "cross", relationType: "negative-control",
    anchor: { title: "Bitcoin above $100,000 in 2026", eventClass: "asset_price_threshold" },
    candidate: { title: "Oppenheimer sequel wins Best Picture 2026", eventClass: "award_winner" },
    label: { relation: "UNRELATED", direction: "AMBIGUOUS", mechanismType: "OTHER", scope: "CROSS_DOMAIN",
      pGivenAnchorWins: 0.1, pGivenAnchorFails: 0.1, strengthBand: "none",
      counterexamples: ["no shared driver"], confidence: 0.9 },
    basis: "logical", labeledBy: "opus-4.8",
    rationale: "Crypto price and an awards outcome share no mechanism; independent.",
  },
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/relation-gold.test.ts`
Expected: PASS (4 rows, ≥3 negative/ambiguous... note only 1 here → the negative-control test needs ≥3; add two more AMBIGUOUS/UNRELATED rows now to satisfy it, following the same shape).

- [ ] **Step 5: Add two more negative-control rows, re-run, then commit**

Add two more rows with `relation: "UNRELATED"` / `direction: "AMBIGUOUS"` (e.g. "Fed cuts rates" → "Lakers win NBA", and "Trump approval >45%" → "Bitcoin > $90k"), re-run the test to PASS, then:

```bash
git add lib/association/relationGold.ts test/relation-gold.test.ts
git commit -m "feat(relation-gold): GoldRelation schema + seed dataset with integrity test"
```

---

### Task 2: pure scoring module `relationEval.ts`

**Files:**
- Create: `lib/association/relationEval.ts`
- Test: `test/relation-eval-scoring.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/relation-eval-scoring.test.ts
import { describe, it, expect } from "vitest";
import { signOf, scoreRelation, aggregateScores, type PredictedRelation } from "@/lib/association/relationEval";
import type { GoldRelation } from "@/lib/association/relationGold";

const gold: GoldRelation = {
  id: "t", domain: "sports", relationType: "same-entity-causal",
  anchor: { title: "A", eventClass: "x" }, candidate: { title: "B", eventClass: "y" },
  label: { relation: "CAUSAL", direction: "NEGATIVE", mechanismType: "CAUSAL", scope: "ENTITY_SPECIFIC",
    pGivenAnchorWins: 0.05, pGivenAnchorFails: 0.25, strengthBand: "moderate", counterexamples: [], confidence: 0.7 },
  basis: "causal", labeledBy: "opus-4.8", rationale: "",
};

describe("relationEval scoring", () => {
  it("signOf classifies by conditional gap", () => {
    expect(signOf(0.1, 0.4)).toBe("NEGATIVE"); // pays more on fail
    expect(signOf(0.4, 0.1)).toBe("POSITIVE");
    expect(signOf(0.2, 0.21)).toBe("AMBIGUOUS"); // within epsilon
  });
  it("scores a correct-sign prediction", () => {
    const pred: PredictedRelation = { relation: "CAUSAL", direction: "NEGATIVE", mechanismType: "CAUSAL", pGivenAnchorWins: 0.08, pGivenAnchorFails: 0.22 };
    const s = scoreRelation(gold, pred);
    expect(s.signCorrect).toBe(true);
    expect(s.mechanismMatch).toBe(true);
    expect(s.condAbsErrFail).toBeCloseTo(0.03, 5);
  });
  it("aggregates accuracy", () => {
    const a = aggregateScores([
      { relationType: "x", signCorrect: true, mechanismMatch: true, relationMatch: true, condAbsErrFail: 0.1, condAbsErrWin: 0.1, judged: true },
      { relationType: "x", signCorrect: false, mechanismMatch: false, relationMatch: false, condAbsErrFail: 0.2, condAbsErrWin: 0.2, judged: true },
    ]);
    expect(a.overall.signAccuracy).toBeCloseTo(0.5, 5);
    expect(a.overall.condMAE).toBeCloseTo(0.15, 5);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/relation-eval-scoring.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure scorer**

```ts
// lib/association/relationEval.ts
import type { GoldRelation } from "./relationGold";

export type Sign = "POSITIVE" | "NEGATIVE" | "AMBIGUOUS";
export interface PredictedRelation {
  relation?: string;
  direction?: string;            // model's stated direction (may disagree with its own conditionals)
  mechanismType?: string;
  pGivenAnchorWins?: number;
  pGivenAnchorFails?: number;
}
export interface RelationScore {
  relationType: string;
  signCorrect: boolean;
  mechanismMatch: boolean;
  relationMatch: boolean;
  condAbsErrFail: number;
  condAbsErrWin: number;
  judged: boolean;               // false when the model returned no usable conditionals
}

const EPS = 0.02;
export function signOf(pWins?: number, pFails?: number): Sign {
  if (pWins == null || pFails == null) return "AMBIGUOUS";
  if (pFails > pWins + EPS) return "NEGATIVE";
  if (pWins > pFails + EPS) return "POSITIVE";
  return "AMBIGUOUS";
}

export function scoreRelation(gold: GoldRelation, pred: PredictedRelation): RelationScore {
  const judged = pred.pGivenAnchorWins != null && pred.pGivenAnchorFails != null;
  const predSign = signOf(pred.pGivenAnchorWins, pred.pGivenAnchorFails);
  return {
    relationType: gold.relationType,
    signCorrect: judged && predSign === gold.label.direction,
    mechanismMatch: (pred.mechanismType ?? "").toUpperCase() === gold.label.mechanismType,
    relationMatch: (pred.relation ?? "").toUpperCase() === gold.label.relation,
    condAbsErrFail: judged ? Math.abs((pred.pGivenAnchorFails as number) - gold.label.pGivenAnchorFails) : 1,
    condAbsErrWin: judged ? Math.abs((pred.pGivenAnchorWins as number) - gold.label.pGivenAnchorWins) : 1,
    judged,
  };
}

export interface AggMetrics { n: number; judged: number; signAccuracy: number; mechanismAccuracy: number; relationAccuracy: number; condMAE: number }
function agg(rows: RelationScore[]): AggMetrics {
  const n = rows.length, judged = rows.filter((r) => r.judged).length || 1;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
  return {
    n, judged: rows.filter((r) => r.judged).length,
    signAccuracy: mean(rows.map((r) => (r.signCorrect ? 1 : 0))),
    mechanismAccuracy: mean(rows.map((r) => (r.mechanismMatch ? 1 : 0))),
    relationAccuracy: mean(rows.map((r) => (r.relationMatch ? 1 : 0))),
    condMAE: mean(rows.filter((r) => r.judged).flatMap((r) => [r.condAbsErrFail, r.condAbsErrWin])),
  };
}
export function aggregateScores(rows: RelationScore[]): { overall: AggMetrics; byType: Record<string, AggMetrics> } {
  const byType: Record<string, AggMetrics> = {};
  const types = [...new Set(rows.map((r) => r.relationType))];
  for (const t of types) byType[t] = agg(rows.filter((r) => r.relationType === t));
  return { overall: agg(rows), byType };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/relation-eval-scoring.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add lib/association/relationEval.ts test/relation-eval-scoring.test.ts
git commit -m "feat(relation-eval): pure scoring (sign/mechanism/conditional) + aggregate metrics"
```

---

### Task 3: default-skip live eval harness

**Files:**
- Create: `test/relation-eval.test.ts`

- [ ] **Step 1: Write the harness (skipped by default)**

```ts
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
      const rel = await analyzeRelationWithQwen(g.anchor.title, g.candidate.title).catch(() => null);
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
```

- [ ] **Step 2: Run the suite to verify it is skipped (and nothing breaks)**

Run: `npx vitest run test/relation-eval.test.ts`
Expected: PASS with the describe reported as skipped (0 failures).

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add test/relation-eval.test.ts
git commit -m "test(relation-eval): default-skip live harness scoring Qwen vs gold"
```

---

### Task 4: expand the gold set to full taxonomy coverage

**Files:**
- Modify: `lib/association/relationGold.ts`
- Modify: `test/relation-gold.test.ts`

- [ ] **Step 1: Add a coverage test**

Add to `test/relation-gold.test.ts`:

```ts
it("covers the taxonomy and has enough rows", () => {
  expect(RELATION_GOLD.length).toBeGreaterThanOrEqual(40);
  const types = new Set(RELATION_GOLD.map((g) => g.relationType));
  for (const t of ["logical-implication","logical-mutex","same-entity-causal","cross-entity","macro-chain","geopolitics-commodity","politics-sector","negative-control"]) {
    expect(types.has(t), `missing relationType ${t}`).toBe(true);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/relation-gold.test.ts`
Expected: FAIL — fewer than 40 rows / missing types.

- [ ] **Step 3: Author the remaining rows**

Expand `RELATION_GOLD` to ~40–60 rows, ≥3 per taxonomy bucket in the test, following the exact shape of the Task-1 seed rows. Each row: real anchor/candidate titles, objective conditionals for logical/structural pairs (implication ≈1 / mutex ≈0 on the win branch), sign+band+counterexamples for causal pairs, AMBIGUOUS independents as negative controls. (This authoring is the data-production deliverable; the labeler is Opus per the spec.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/relation-gold.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/association/relationGold.ts test/relation-gold.test.ts
git commit -m "feat(relation-gold): full taxonomy coverage (~40-60 labeled relations)"
```

---

## Phase 2 — few-shot prompt anchors (flag-gated)

### Task 5: exemplar selection `relationFewShot.ts`

**Files:**
- Create: `lib/association/relationFewShot.ts`
- Test: `test/relation-fewshot.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/relation-fewshot.test.ts
import { describe, it, expect } from "vitest";
import { selectFewShot, renderFewShot } from "@/lib/association/relationFewShot";
import { RELATION_GOLD } from "@/lib/association/relationGold";

describe("few-shot selection", () => {
  it("picks diverse exemplars and excludes a held-out id (leave-one-out)", () => {
    const holdout = RELATION_GOLD[0].id;
    const picks = selectFewShot(RELATION_GOLD, 5, holdout);
    expect(picks.length).toBeLessThanOrEqual(5);
    expect(picks.some((p) => p.id === holdout)).toBe(false);
    expect(new Set(picks.map((p) => p.relationType)).size).toBe(picks.length); // one per type
  });
  it("renders exemplars as text", () => {
    const txt = renderFewShot(selectFewShot(RELATION_GOLD, 3));
    expect(txt).toContain("->");
    expect(txt.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/relation-fewshot.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement selection + rendering**

```ts
// lib/association/relationFewShot.ts
import { RELATION_GOLD, type GoldRelation } from "./relationGold";

/** One high-confidence exemplar per relationType (diverse), excluding an optional held-out id. */
export function selectFewShot(pool: GoldRelation[] = RELATION_GOLD, k = 6, excludeId?: string): GoldRelation[] {
  const eligible = pool.filter((g) => g.id !== excludeId).sort((a, b) => b.label.confidence - a.label.confidence);
  const seen = new Set<string>(); const out: GoldRelation[] = [];
  for (const g of eligible) {
    if (out.length >= k) break;
    if (seen.has(g.relationType)) continue;
    seen.add(g.relationType); out.push(g);
  }
  return out;
}

export function renderFewShot(picks: GoldRelation[]): string {
  return picks.map((g) =>
    `- "${g.anchor.title}" -> "${g.candidate.title}": ${g.label.relation}/${g.label.direction} (${g.label.mechanismType}); ` +
    `pGivenAnchorWins=${g.label.pGivenAnchorWins}, pGivenAnchorFails=${g.label.pGivenAnchorFails}. ` +
    `counterexample: ${g.label.counterexamples[0] ?? "none"}`,
  ).join("\n");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/relation-fewshot.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add lib/association/relationFewShot.ts test/relation-fewshot.test.ts
git commit -m "feat(relation-fewshot): leave-one-out diverse exemplar selection + rendering"
```

---

### Task 6: inject few-shot into the elicitation prompt (flag-gated)

**Files:**
- Modify: `lib/association/elicit.ts` (the prompt string + call site)
- Test: `test/relation-fewshot-inject.test.ts`

- [ ] **Step 1: Write the failing test for a pure prompt-builder**

```ts
// test/relation-fewshot-inject.test.ts
import { describe, it, expect } from "vitest";
import { withFewShot } from "@/lib/association/relationFewShot";

describe("few-shot injection", () => {
  it("appends exemplars only when enabled", () => {
    const base = "SYSTEM PROMPT";
    expect(withFewShot(base, false)).toBe(base);
    const on = withFewShot(base, true);
    expect(on.startsWith(base)).toBe(true);
    expect(on).toContain("Worked examples");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/relation-fewshot-inject.test.ts`
Expected: FAIL — `withFewShot` not exported.

- [ ] **Step 3: Add `withFewShot` to `relationFewShot.ts`**

```ts
// append to lib/association/relationFewShot.ts
export function withFewShot(basePrompt: string, enabled = process.env.HEDGE_RELATION_FEWSHOT === "1", excludeId?: string): string {
  if (!enabled) return basePrompt;
  const examples = renderFewShot(selectFewShot(RELATION_GOLD, 6, excludeId));
  return `${basePrompt}\n\nWorked examples (anchor -> candidate => relation/direction/mechanism + conditionals):\n${examples}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/relation-fewshot-inject.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into `elicit.ts` (default OFF)**

In `lib/association/elicit.ts`, import `withFewShot` and wrap the system prompt passed to the model with `withFewShot(SYSTEM_PROMPT)`. Because the env flag defaults unset, behavior is unchanged unless `HEDGE_RELATION_FEWSHOT=1`.

- [ ] **Step 6: Verify whole suite green, commit**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass.

```bash
git add lib/association/relationFewShot.ts lib/association/elicit.ts test/relation-fewshot-inject.test.ts
git commit -m "feat(relation-fewshot): flag-gated few-shot anchors in elicitation prompt (default off)"
```

- [ ] **Step 7 (manual, not CI): measure lift**

Un-skip `test/relation-eval.test.ts`, run once with `HEDGE_RELATION_FEWSHOT` unset (baseline) and once with `=1` (leave-one-out is automatic via `excludeId` only in eval — pass each gold row's id as `excludeId` when building its prompt). Record sign/mechanism accuracy delta in the spec's results section. Flip the default ON only if it beats baseline without hurting negative controls.

---

## Phase 3 — gold-derived meta-calibration (MODELED-only)

### Task 7: correction builder + apply (pure)

**Files:**
- Create: `lib/association/relationCorrection.ts`
- Test: `test/relation-correction.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/relation-correction.test.ts
import { describe, it, expect } from "vitest";
import { buildCorrectionFromGold, applyCorrection, type ScoredExample } from "@/lib/association/relationCorrection";

const ex = (mech: string, predFail: number, goldFail: number): ScoredExample => ({ mechanismType: mech, predFail, goldFail, predWin: 0.1, goldWin: 0.1 });

describe("relation correction (MODELED-only)", () => {
  it("learns a per-mechanism fail-branch bias above the min-sample floor", () => {
    const c = buildCorrectionFromGold([ex("CAUSAL",0.1,0.3), ex("CAUSAL",0.15,0.3), ex("CAUSAL",0.2,0.4), ex("CAUSAL",0.1,0.25)], 4);
    expect(c.get("CAUSAL")?.biasFail).toBeLessThan(0); // model under-predicts fail-branch
  });
  it("no correction below the min-sample floor", () => {
    const c = buildCorrectionFromGold([ex("ECONOMIC",0.1,0.3)], 4);
    expect(c.has("ECONOMIC")).toBe(false);
  });
  it("applyCorrection nudges toward gold and stays in [0,1], no-op for unknown bucket", () => {
    const c = buildCorrectionFromGold([ex("CAUSAL",0.1,0.3), ex("CAUSAL",0.15,0.3), ex("CAUSAL",0.2,0.4), ex("CAUSAL",0.1,0.25)], 4);
    const adj = applyCorrection({ pGivenAnchorWins: 0.1, pGivenAnchorFails: 0.1 }, "CAUSAL", c);
    expect(adj.pGivenAnchorFails).toBeGreaterThan(0.1);
    expect(adj.pGivenAnchorFails).toBeLessThanOrEqual(1);
    expect(applyCorrection({ pGivenAnchorWins: 0.1, pGivenAnchorFails: 0.1 }, "OTHER", c)).toEqual({ pGivenAnchorWins: 0.1, pGivenAnchorFails: 0.1 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/relation-correction.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure correction**

```ts
// lib/association/relationCorrection.ts
export interface ScoredExample { mechanismType: string; predFail: number; goldFail: number; predWin: number; goldWin: number }
export interface Correction { biasFail: number; biasWin: number; n: number }
export type CorrectionMap = Map<string, Correction>;

/** Mean (gold - predicted) per mechanismType, only for buckets with >= minSamples. source: "gold". */
export function buildCorrectionFromGold(examples: ScoredExample[], minSamples = 8): CorrectionMap {
  const groups = new Map<string, ScoredExample[]>();
  for (const e of examples) groups.set(e.mechanismType, [...(groups.get(e.mechanismType) ?? []), e]);
  const out: CorrectionMap = new Map();
  for (const [mech, rows] of groups) {
    if (rows.length < minSamples) continue;
    const mean = (f: (e: ScoredExample) => number) => rows.reduce((s, e) => s + f(e), 0) / rows.length;
    out.set(mech, { biasFail: mean((e) => e.goldFail - e.predFail), biasWin: mean((e) => e.goldWin - e.predWin), n: rows.length });
  }
  return out;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** MODELED-only nudge of elicited conditionals toward gold-consistent values. Never sets a tier/provenance. */
export function applyCorrection(
  elicited: { pGivenAnchorWins: number; pGivenAnchorFails: number },
  mechanismType: string,
  corrections: CorrectionMap,
  shrink = 0.5,
): { pGivenAnchorWins: number; pGivenAnchorFails: number } {
  const c = corrections.get(mechanismType);
  if (!c) return elicited;
  return {
    pGivenAnchorWins: clamp01(elicited.pGivenAnchorWins + shrink * c.biasWin),
    pGivenAnchorFails: clamp01(elicited.pGivenAnchorFails + shrink * c.biasFail),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/relation-correction.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add lib/association/relationCorrection.ts test/relation-correction.test.ts
git commit -m "feat(relation-correction): pure gold-derived per-mechanism MODELED correction + min-sample guardrail"
```

---

### Task 8: persist a correction snapshot + wire it into the MODELED path

**Files:**
- Create: `lib/association/relationCorrection.json` (committed snapshot, `{}` until the eval is run)
- Modify: `lib/relate/discover.ts` (where `modeledPayoff`/elicited conditionals are built)
- Test: `test/relation-correction-wiring.test.ts`

- [ ] **Step 1: Create an empty snapshot**

```json
// lib/association/relationCorrection.json
{ "source": "gold", "generatedAt": null, "byMechanismType": {} }
```

- [ ] **Step 2: Write a wiring guard test (correction is MODELED-only + Fréchet-respecting)**

```ts
// test/relation-correction-wiring.test.ts
import { describe, it, expect } from "vitest";
import { applyCorrection, buildCorrectionFromGold } from "@/lib/association/relationCorrection";

describe("correction wiring invariants", () => {
  it("never pushes a conditional outside [0,1] and is a no-op with empty map", () => {
    const empty = new Map();
    expect(applyCorrection({ pGivenAnchorWins: 0.9, pGivenAnchorFails: 0.9 }, "CAUSAL", empty))
      .toEqual({ pGivenAnchorWins: 0.9, pGivenAnchorFails: 0.9 });
    const c = buildCorrectionFromGold(Array.from({ length: 8 }, () => ({ mechanismType: "CAUSAL", predFail: 0.9, goldFail: 1.2, predWin: 0.1, goldWin: 0.1 })), 8);
    const adj = applyCorrection({ pGivenAnchorWins: 0.95, pGivenAnchorFails: 0.95 }, "CAUSAL", c);
    expect(adj.pGivenAnchorFails).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 3: Run to verify it passes (pure, no wiring yet)**

Run: `npx vitest run test/relation-correction-wiring.test.ts`
Expected: PASS.

- [ ] **Step 4: Wire `applyCorrection` into `discover.ts`**

In `lib/relate/discover.ts`, after the elicited `pW`/`pF` are computed (the `elicited` mapPool callback) and BEFORE they become the leg's `modeledPayoff`, load the committed `relationCorrection.json` into a `CorrectionMap` once and apply `applyCorrection({pGivenAnchorWins:pW, pGivenAnchorFails:pF}, mechType, corr)`. Apply it strictly on the MODELED branch — do not touch any `calibration`/CALIBRATED candidate, and keep the existing Fréchet clamp AFTER the correction so feasibility is still enforced. With `byMechanismType: {}` this is a no-op, so behavior is unchanged until the eval populates the snapshot.

- [ ] **Step 5: Verify whole suite + types green, commit**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass (no behavior change with empty snapshot).

```bash
git add lib/association/relationCorrection.json lib/relate/discover.ts test/relation-correction-wiring.test.ts
git commit -m "feat(relation-correction): MODELED-only correction wired into discover (no-op until eval populates snapshot)"
```

---

### Task 9: surface the correction in diag (labeled MODELED, not settlement)

**Files:**
- Modify: `app/api/diag/stats/route.ts`

- [ ] **Step 1: Add the correction snapshot to the diag JSON**

In `app/api/diag/stats/route.ts`, import the committed `relationCorrection.json` and add it to the response as `relationCorrection`, with an inline comment that it is a MODELED-tier elicitor correction derived from the Opus gold set (`source: "gold"`), explicitly NOT settlement calibration and never promoting a tier.

- [ ] **Step 2: Verify build/types + commit**

Run: `npx tsc --noEmit && npx vitest run`
Expected: pass.

```bash
git add app/api/diag/stats/route.ts
git commit -m "feat(diag): surface gold-derived MODELED relation correction (clearly not settlement calibration)"
```

---

## Self-review checklist (run after writing, fix inline)

- Spec coverage: Phase 1 (Tasks 1–4), Phase 2 (Tasks 5–6 + manual measure step), Phase 3 (Tasks 7–9). Honesty constraints enforced: correction is MODELED-only (Tasks 7–9), no settlement writes, default-off flag (Task 6), Opus-labeled gold (Task 1/4). ✔
- Type consistency: `GoldRelation` (Task 1) used by `relationEval`/`relationFewShot`/eval harness; `PredictedRelation`/`RelationScore` (Task 2) used by the harness (Task 3); `ScoredExample`/`CorrectionMap` (Task 7) used by wiring (Task 8). ✔
- No placeholders in code steps; the only authoring-heavy step (Task 4 gold rows) is the deliverable itself, bounded by the coverage test. ✔
