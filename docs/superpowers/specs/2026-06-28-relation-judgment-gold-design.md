# Relationship-Judgment Gold Dataset + Eval + Calibration (MODELED layer)

- **Date:** 2026-06-28
- **Status:** Approved design (brainstorming → spec)
- **Branch:** `moat-f2-direction-bucket` (continues the moat-improvement line)
- **Owner decision recorded:** target the MODELED judgment layer (not CALIBRATED); Opus authors AND labels the seed; fold Phases 2–3 into this plan.

## 1. Motivation

The data the moat currently accrues (same-entity threshold ladders, reach-final ⊆ win subsets, exclusive rivals) is structural/tautological — it barely teaches the engine to *judge* a logical/causal relationship. The capability the product actually needs ("Spain's star injured ↔ Spain can't win" are negatively linked) lives in the **MODELED** layer: Qwen elicits a `RelationHypothesis` (relation/direction/mechanism) via `analyzeRelationWithQwen` and conditional probabilities via `elicitConditionalWithQwen`. That judgment's measured quality is poor and unvalidated (the repo's own ~36% sign-accuracy figure is a one-off, not a repeatable benchmark). We need a labeled relationship dataset to **measure**, then **improve**, then **calibrate** that judgment.

## 2. Goals / Non-goals

**Goals**
- Produce a labeled relationship **gold dataset** spanning a relationship-type taxonomy.
- A repeatable **eval** that scores the engine's LLM judgment (sign, mechanism-type, conditional calibration) per relationType.
- **Improve** the judgment with few-shot anchors and a **meta-calibration** correction — all MODELED-only.

**Non-goals**
- No new CALIBRATED rules from this data. The gold set never becomes settlement evidence.
- Not a human gold standard. Labels are Opus-authored reasoned references (see §3).
- No change to the optimizer's admission gates, the CALIBRATED math, or the cron freeze behavior.

## 3. Honesty constraints (non-negotiable)

1. **MODELED-only.** Gold-derived few-shot and meta-calibration adjust the MODELED tier (`OptimizerCandidate.modeledPayoff`) only. They NEVER set `provenance: "CALIBRATED"`, never satisfy `sufficientEvidence`, never write `association_observation`.
2. **No fabricated settlement.** The gold set is not ingested as observations. It is a static fixture used by eval/prompt/correction code paths only.
3. **Labeler independence + circularity caveat.** Labels come from Opus 4.8; the model being evaluated is Qwen (MiniMax-M2.1 et al.) — "stronger labels, weaker evaluated," a valid distillation/eval setup, NOT a human gold standard. Logical/structural pairs are labeled with objective certainty; causal pairs get sign + mechanism + counterexamples + an explicit confidence and a coarse strength band. Each record is human-auditable; the owner can spot-check or override.
4. **The correction is alignment, not proof.** A gold-derived meta-correction aligns Qwen toward better judgment; it is tagged `source: "gold"` and is explicitly distinct from settlement calibration.

## 4. Relationship taxonomy (coverage targets)

Breadth over depth — the goal is general judgment. Target ~40–60 examples spread across:

| Type | Example anchor → candidate | Expected label |
|---|---|---|
| Logical / implication | BTC > $100k → BTC > $90k | direction POSITIVE, mechanismType IMPLICATION, objective |
| Logical / mutual-exclusivity | France wins WC → Spain wins WC | direction NEGATIVE (MUTEX), objective |
| Same-entity causal | Spain star ruled out injured → Spain wins WC | direction NEGATIVE, CAUSAL/BEHAVIORAL |
| Same-entity collateral | Favorite loses a match → announcer says "upset" | direction NEGATIVE (pays on fail) |
| Cross-entity | Team A wins group → Team B (same group) wins group | direction NEGATIVE |
| Macro chain | Fed holds rates → CPI stays high | direction POSITIVE, ECONOMIC |
| Geopolitics → commodity | Middle-East conflict escalates → oil > $X | direction POSITIVE, COMMON_CAUSE/CAUSAL |
| Politics → sector | Candidate X wins → sector Y regulation tightens | direction (labeled per case), INSTITUTIONAL |
| Genuine non-relation (negative control) | Unrelated A → unrelated B | direction AMBIGUOUS / relation UNRELATED |

Negative controls matter: the eval must reward Qwen for correctly saying "no relation," not only for finding ones.

## 5. Data schema (`GoldRelation`)

Mirrors `RelationHypothesis` + `MechanismGraph` (`lib/association/types.ts`) + the conditional probabilities so it plugs straight into scoring:

```ts
export interface GoldRelation {
  id: string;                       // stable slug, e.g. "sports-injury-spain-wc"
  domain: string;                   // "sports" | "macro" | "geopolitics" | "politics" | "crypto" | ...
  relationType: string;            // taxonomy bucket from §4
  anchor: { title: string; eventClass: string };
  candidate: { title: string; eventClass: string };
  label: {
    relation: AssociationRelation;            // EQUIVALENT|MUTEX|IMPLICATION|CAUSAL|THEMATIC|UNRELATED|AMBIGUOUS
    direction: "POSITIVE" | "NEGATIVE" | "AMBIGUOUS";
    mechanismType: MechanismType;             // IDENTITY|LOGICAL|CAUSAL|ECONOMIC|...
    scope: MechanismScope;                    // SAME_ENTITY|CROSS_ENTITY|CROSS_DOMAIN|...
    pGivenAnchorWins: number;                 // P(candidate pays | anchor happens)
    pGivenAnchorFails: number;                // P(candidate pays | anchor does NOT happen)
    strengthBand: "strong" | "moderate" | "weak" | "none"; // coarse, honest about magnitude uncertainty
    counterexamples: string[];
    confidence: number;                        // labeler confidence 0..1
  };
  basis: "logical" | "causal" | "historical"; // logical = objective; causal/historical = reasoned
  labeledBy: "opus-4.8";
  rationale: string;                            // one-line why, for audit
}
```

For logical/structural rows the conditionals are exact (e.g. implication: `pGivenAnchorWins ≈ 1`); for causal rows they are honest estimates with `strengthBand` carrying the magnitude uncertainty and `pGivenAnchorWins`/`pGivenAnchorFails` set to plausible bands the sign is robust to.

## 6. Phase 1 — gold dataset + scoring + eval harness

**6.1 Dataset** — `lib/association/relationGold.ts`: `export const RELATION_GOLD: GoldRelation[]` (~40–60 rows, §4 coverage). Pure data; no imports beyond the types. This is the artifact the owner asked to produce.

**6.2 Pure scoring** — `lib/association/relationEval.ts`:
- `scoreRelation(gold: GoldRelation, predicted: PredictedRelation): RelationScore` where `PredictedRelation` is the normalized union of `RelationHypothesis` (relation/direction/mechanismType) + elicited `{pGivenAnchorWins, pGivenAnchorFails, confidence}`.
- `RelationScore`: `{ signCorrect: boolean; mechanismMatch: boolean; relationMatch: boolean; condAbsErrFail: number; condAbsErrWin: number; predictedSign: ...; goldSign: ... }`.
- `aggregateScores(scores): { n, signAccuracy, mechanismAccuracy, relationAccuracy, condMAE, brierFail }` — reuse `lib/estimate/calibration.ts` (Brier/ECE) for the conditional numbers, bucketed by `relationType` and overall.
- `signOf(pWins, pFails)` helper: NEGATIVE if pFails > pWins + ε, POSITIVE if pWins > pFails + ε, else AMBIGUOUS — the same ε convention the engine uses.
- All pure, deterministic, no I/O. Unit-tested with synthetic gold+predicted fixtures.

**6.3 Live eval harness** — `test/relation-eval.test.ts`, **`describe.skip` by default** (matches `live-verify`/`backtest-calibration` convention): for each `RELATION_GOLD` row, call `analyzeRelationWithQwen` + `elicitConditionalWithQwen`, normalize to `PredictedRelation`, `scoreRelation`, then print `aggregateScores` per relationType + overall. Un-skip + run with `QWEN_API_KEY` to produce the baseline number. No key → skipped, never fails CI.

**Phase 1 deliverable = the baseline measurement.**

## 7. Phase 2 — few-shot prompt anchors

- `lib/association/relationFewShot.ts`: `selectFewShot(taxonomyDiverse, k): GoldRelation[]` — pick K diverse, high-confidence exemplars (one per relationType, never the row being scored — leave-one-out in eval).
- Render them as worked examples appended to the elicitation/relation **system prompts** in `elicit.ts` and `qwen.ts` (anchor→candidate → correct relation/direction/mechanism + one counterexample).
- **Flag-gated:** `HEDGE_RELATION_FEWSHOT` (default OFF). The Phase-1 eval is run with the flag OFF (baseline) and ON (improved) to prove lift before flipping the default. Leave-one-out in the eval so an exemplar never grades itself.

## 8. Phase 3 — meta-calibration (MODELED-only)

- From the Phase-1 eval, compute a per-`mechanismType` (fallback per-`scope`) correction of the elicitor's systematic error: a `signFlipRate` and a mean conditional bias `(predicted − gold)` for `pGivenAnchorWins`/`pGivenAnchorFails`.
- `lib/association/relationCorrection.ts`: `buildCorrectionFromGold(scores): Map<mechBucket, {biasFail, biasWin, minConfidence}>` (pure) + `applyCorrection(elicited, mechBucket, correction)` that shrinks/offsets the elicited conditionals toward gold-consistent values.
- Wire `applyCorrection` into the MODELED path where `modeledPayoff` is built (the `elicitConditionalWithQwen` consumers in `discover.ts`/`toOptimizerCandidates.ts`), **after** the existing Fréchet clamp and gated so it only ever adjusts `modeledPayoff` (never `calibration`, never `provenance`).
- Persist the correction as a committed JSON snapshot (`relationCorrection.json`) tagged `source: "gold"`, regenerated when the gold set or eval changes. Surfaced in `/api/diag/stats` alongside `learnedRules` but clearly labeled MODELED-correction, not settlement.
- **Guardrails:** require a minimum number of gold rows per mechBucket before a correction applies; below it, pass the raw elicitation through untouched. A correction can only move a MODELED leg's conditionals; it can never promote a tier or relax `hedgeSpecificityLower>0` / conservatism gates.

## 9. File layout

```
lib/association/relationGold.ts        # the labeled dataset (Phase 1)
lib/association/relationEval.ts        # pure scoring + aggregate metrics (Phase 1)
lib/association/relationFewShot.ts     # exemplar selection (Phase 2)
lib/association/relationCorrection.ts  # gold-derived MODELED correction (Phase 3)
test/relation-eval.test.ts             # unit tests (pure) + default-skip live harness
docs/superpowers/specs/2026-06-28-relation-judgment-gold-design.md
```

## 10. Testing

- Pure scoring (`relationEval`, `relationFewShot`, `relationCorrection`) unit-tested with synthetic fixtures — deterministic, no API. Cover: sign scoring incl. AMBIGUOUS, mechanism match, conditional MAE/Brier, leave-one-out few-shot selection, correction bias math, and the minimum-bucket guardrail.
- A schema/integrity test over `RELATION_GOLD`: every row valid against the schema, ids unique, taxonomy coverage present, ≥N negative-control rows, conditionals in (0,1).
- Live Qwen eval default-skip; runnable manually for the baseline.
- Every change passes `npx vitest run` + `npx tsc --noEmit`.

## 11. Error handling / edge cases

- No `QWEN_API_KEY` / `DATABASE_URL` → live eval skips; pure tests still run.
- Qwen returns `status !== "ok"` or null conditionals → the harness records a "no-judgment" row (counts against coverage, not as a wrong sign).
- AMBIGUOUS labels: scored as correct only when Qwen also returns AMBIGUOUS/UNRELATED (negative controls protect against a model that calls everything correlated).
- Correction with too few gold rows in a bucket → no-op (raw elicitation passes through).

## 12. Sequencing & success criteria

1. **Phase 1**: dataset + pure scoring + unit tests + skip-live harness. Success: a reproducible baseline (sign accuracy %, mechanism accuracy %, conditional MAE per relationType).
2. **Phase 2**: few-shot, flag-gated. Success: eval with flag ON beats OFF on sign/mechanism accuracy (leave-one-out), no regression on negative controls.
3. **Phase 3**: meta-calibration, MODELED-only. Success: corrected conditionals reduce conditional MAE vs gold without ever changing tier/provenance; guardrail verified by test.

## 13. Risks & open questions

- **Circularity** — Opus labels, Qwen is evaluated. Mitigation: objective labels for logical rows; sign+counterexample focus for causal; owner spot-check; the eval headline is *sign/mechanism* accuracy (robust) more than exact magnitude.
- **Breadth vs per-bucket sample size** — ~40–60 rows spread thin per relationType; correction guardrail (min rows/bucket) prevents over-correcting from a sparse bucket. Grow the set over time.
- **Same-regime-different-market residual** (from C3) is unrelated to this MODELED work and stays as a separately-tracked item.
