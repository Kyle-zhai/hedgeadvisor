# Settlement-Moat Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the one active honesty hole in live calibration, then make the cron a clean evidence source for a production CALIBRATED moat (frozen-evidence-only calibration, elicited-prior capture, scenario persistence), and scope the two large subsystems (full-market indexer, execution-grade price snapshots).

**Architecture:** Five issues, all verified against the code in the prior audit. Fix in priority order: the honesty hole first (surgical, Task 1), then the cheap evidence-completeness fixes (Tasks 2–3), then the two large subsystems as their own sub-project specs (Tasks 4–5, design outlines only — they are NOT one-shot edits). Each task is independently shippable + verifiable; do them ONE AT A TIME and re-run the credibility report (`/api/backtest/association?grain=bucket`) after each evidence change.

**Tech Stack:** Next.js API routes (force-dynamic), Postgres (postgres.js via `lib/data/db.ts`), Vitest, GitHub-Actions cron. No Vercel.

**Non-negotiable invariants (every task must preserve):** gold never promotes CALIBRATED; LLM output never writes settlement evidence; no post-resolution snapshot enters calibration OR backtest; no current price replaces historical; no same-cluster leakage; direction stays in every bucket key.

---

## Verified problem ledger (from the 2026-06-30 audit)

| # | Issue | Evidence | Size |
|---|---|---|---|
| 1 | Live tuning profile reads observations with NO pre-settlement snapshot | `loadBucketBranchRows` ([store.ts:243](../../../lib/association/store.ts)) has no snapshot join; backtest does. 52/956 obs (5.5%) unfrozen. | Surgical |
| 2 | cron doesn't freeze elicited conditional priors | `strategyResult = req.withStrategies ? …` ([discover.ts:962](../../../lib/relate/discover.ts)); cron leaves it off → `p_given_*` empty | Small |
| 3 | scenarioBucket (+dimension, association_group) not persisted | `candidateSnapshot.ts` push has no scenario field; `association_candidate_snapshot` has no column | Medium (schema) |
| 4 | Not a full-market radar | 8 default anchors, `.max(20)`, topK≈4 ([relations/route.ts:20](../../../app/api/cron/relations/route.ts)); fixed PM-event universe | **Sub-project** |
| 5 | Price snapshot covers only the default PM event, PM-only, mid not order book | `DEFAULT_SLUG` ([snapshot/route.ts:20](../../../app/api/cron/snapshot/route.ts)) | **Sub-project** |

---

## Task 1: Freeze-gate live calibration (THE honesty fix)

**Files:**
- Modify: `lib/association/store.ts` — `loadBucketBranchRows()` SQL (add the snapshot-existence filter, mirroring `loadAssociationBacktestRows`)
- Test: `test/tuning-profile-freeze.test.ts` (new, DATABASE_URL-gated integration test, self-cleaning)

**Why:** `loadAssociationBacktestRows` already gates on a pre-resolution snapshot (`JOIN association_candidate_snapshot s ON s.relation_key=o.relation_key AND s.anchor_market_id=o.anchor_market_id AND s.candidate_market_id=o.candidate_market_id AND s.observed_at <= o.resolved_at - lead`). The LIVE calibration path (`loadBucketBranchRows` → `aggregateBucketsByCluster` → CALIBRATED gate) does NOT, so a settle-time-constructed observation with no frozen evidence can promote a bucket. We make live read the SAME frozen-evidence rows the backtest does.

- [ ] **Step 1: Write the failing integration test**

```ts
// test/tuning-profile-freeze.test.ts
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { getSql } from "@/lib/data/db";
import { loadBucketBranchRows } from "@/lib/association/store";
try { for (const l of readFileSync(".env.local","utf8").split("\n")) { const m=l.match(/^([A-Z0-9_]+)=(.*)$/); if(m&&m[2].trim()&&!process.env[m[1]])process.env[m[1]]=m[2].trim(); } } catch {}

const PFX = "TESTFREEZE-" + Math.floor(Date.now() % 1e7); // unique, cleaned up
const KEY_FROZEN = `${PFX}-frozen`;   // has a pre-resolution snapshot ⇒ MUST appear
const KEY_NAKED = `${PFX}-naked`;     // observation only, no snapshot ⇒ MUST be excluded

describe.skipIf(!process.env.DATABASE_URL)("tuning profile freeze-gate", () => {
  afterAll(async () => {
    const sql = await getSql(); if (!sql) return;
    await sql`DELETE FROM association_observation WHERE relation_key LIKE ${PFX + "%"}`;
    await sql`DELETE FROM association_candidate_snapshot WHERE relation_key LIKE ${PFX + "%"}`;
    await sql`DELETE FROM association_relation WHERE relation_key LIKE ${PFX + "%"}`;
  });
  it("excludes observations with no pre-resolution snapshot from the live tuning profile", async () => {
    const sql = await getSql(); if (!sql) return;
    for (const k of [KEY_FROZEN, KEY_NAKED]) {
      await sql`INSERT INTO association_relation (relation_key, anchor_template, candidate_template, candidate_side)
                VALUES (${k}, 'a', 'b', 'yes') ON CONFLICT (relation_key) DO NOTHING`;
      await sql`INSERT INTO association_observation (relation_key, sample_key, cluster_key, anchor_pays, candidate_pays, anchor_market_id, candidate_market_id, resolved_at)
                VALUES (${k}, ${k+"-s1"}, ${k+"-c1"}, false, true, 'AM', 'CM', '2026-03-01T00:00:00Z') ON CONFLICT (relation_key, sample_key) DO NOTHING`;
    }
    // only the frozen key gets a snapshot, observed BEFORE resolution
    await sql`INSERT INTO association_candidate_snapshot (relation_key, observed_at, anchor_market_id, candidate_market_id, candidate_side, candidate_price)
              VALUES (${KEY_FROZEN}, '2026-02-01T00:00:00Z', 'AM', 'CM', 'yes', 0.3) ON CONFLICT DO NOTHING`;
    const rows = await loadBucketBranchRows();
    const keys = new Set(rows.map((r) => r.relationKey));
    expect(keys.has(KEY_FROZEN)).toBe(true);   // frozen evidence ⇒ included
    expect(keys.has(KEY_NAKED)).toBe(false);   // no snapshot ⇒ excluded (the fix)
  });
});
```

- [ ] **Step 2: Run it, verify it FAILS** (KEY_NAKED currently appears)

Run: `npx vitest run test/tuning-profile-freeze.test.ts`
Expected: FAIL — `expect(keys.has(KEY_NAKED)).toBe(false)` receives `true` (current behavior reads all observations).

- [ ] **Step 3: Add the freeze filter to `loadBucketBranchRows`**

Replace the query body in `lib/association/store.ts` `loadBucketBranchRows`:

```ts
  const rows = await sql`
    SELECT o.relation_key AS "relationKey",
      COALESCE(o.cluster_key, o.sample_key) AS cluster,
      o.anchor_pays AS "anchorPays",
      count(*) FILTER (WHERE o.candidate_pays)::int AS pay,
      count(*)::int AS total
    FROM association_observation o
    WHERE o.relation_key IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM association_candidate_snapshot s
        WHERE s.relation_key = o.relation_key
          AND s.anchor_market_id = o.anchor_market_id
          AND s.candidate_market_id = o.candidate_market_id
          AND s.observed_at <= o.resolved_at
      )
    GROUP BY o.relation_key, COALESCE(o.cluster_key, o.sample_key), o.anchor_pays
  ` as Array<{ relationKey: string; cluster: string; anchorPays: boolean; pay: number; total: number }>;
```

Note: use `observed_at <= resolved_at` (frozen no later than resolution) — the strict ≥24h lead is a backtest-eval choice; for calibration evidence "frozen before/at resolution" is the honesty bar. Keep the COALESCE cluster logic unchanged so cluster-dedup still works.

- [ ] **Step 4: Run the test, verify it PASSES**

Run: `npx vitest run test/tuning-profile-freeze.test.ts`
Expected: PASS (KEY_FROZEN included, KEY_NAKED excluded).

- [ ] **Step 5: Empirical check on the real DB (no regression to real buckets)**

Throwaway runner: load `loadBucketBranchRows()` + `loadTuningProfile()` before/after is not possible post-merge, so just assert the post-fix invariant on real data:
```
distinct relation_keys in loadBucketBranchRows()  ==  distinct relation_keys that HAVE a snapshot
4 CALIBRATED leaf buckets still present (cross_entity|logical|negative|yes etc.) — they are snapshot-backed backfill, so they survive.
```
Run a one-off vitest that prints `loadBucketBranchRows().length` + the CALIBRATED bucket count via `loadTuningProfile`. Expected: the ~52 unfrozen observations no longer contribute; the 4 CALIBRATED buckets remain.

- [ ] **Step 6: Run full suite + typecheck + commit**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc 0, all pass (the new gated test runs only with DATABASE_URL).
```bash
git add lib/association/store.ts test/tuning-profile-freeze.test.ts
git commit -m "fix(moat): live calibration reads ONLY frozen-evidence observations (close leakage hole)"
```

---

## Task 2: Freeze elicited conditional priors from the cron (sampled)

**Files:**
- Modify: `app/api/cron/relations/route.ts` — pass a sampled `withStrategies`/elicit flag so a fraction of runs freeze priors
- Modify: `lib/relate/discover.ts` — already supports `withStrategies` elicitation + `persistCandidateSnapshots(..., elicitedPriors)`; no change beyond confirming the prior reaches the snapshot
- Test: `test/cron-relations-elicit.test.ts` (DATABASE_URL-gated) — after a `withStrategies` discover, the snapshot row has non-null `p_given_fails`/`p_given_wins`

**Why:** `p_given_*` are NULL in cron snapshots because `/api/cron/relations` never sets `withStrategies`. Single-leg settlement calibration still works WITHOUT the prior, but you cannot later score "was the model's pre-settlement prediction accurate" (Brier/ECE of the MODELED prior vs realized) without it. Sample it (e.g. 1-in-N anchors per run) to bound LLM cost.

- [ ] **Step 1: Write the failing test** — call `discoverRelations({ query, withStrategies: true })` against a resolvable anchor, then query `association_candidate_snapshot` for that relation and assert `p_given_fails IS NOT NULL`. (Gated on DATABASE_URL + an LLM key; skip otherwise.)

```ts
// test/cron-relations-elicit.test.ts — sketch (full code at implementation time)
// expect at least one snapshot row for the run's anchor to carry a non-null p_given_fails.
```

- [ ] **Step 2: Run, verify FAIL** (cron path writes null priors).

- [ ] **Step 3: Add a sampled elicit flag to `/api/cron/relations`**

In `app/api/cron/relations/route.ts`, accept `?elicitSample=0.25` (default 0 = off, preserving cheap cron). For each anchor job, with probability `elicitSample` (or a deterministic `index % k === dayOfYear % k`), call `discoverRelations({ ...job, withStrategies: true })` instead of the default; otherwise unchanged. Use a deterministic rotation (NOT Math.random — keep runs reproducible): `withStrategies: (jobIndex + dayOfYear) % Math.round(1/elicitSample) === 0`.

- [ ] **Step 4: Run, verify PASS** (sampled snapshots now carry priors).

- [ ] **Step 5: Verify on real DB** — `SELECT count(*) FILTER (WHERE p_given_fails IS NOT NULL) FROM association_candidate_snapshot` rises after a cron run with `elicitSample>0`.

- [ ] **Step 6: tsc + suite + commit**
```bash
git commit -m "feat(cron): sampled withStrategies so elicited priors get frozen for prediction-accuracy eval"
```

---

## Task 3: Persist scenarioBucket (+ dimension, association_group) in candidate snapshots

**Files:**
- Modify: `lib/data/db.ts` — `ALTER TABLE association_candidate_snapshot ADD COLUMN IF NOT EXISTS scenario_bucket text` (+ `dimension text`, `association_group text`)
- Modify: `lib/association/store.ts` — `upsertAssociationCandidateSnapshots` INSERT + the snapshot input type (add `scenarioBucket?/dimension?/associationGroup?`)
- Modify: `lib/relate/candidateSnapshot.ts` — compute `classifyScenarioBucket(...)` per snapshot row and pass it through
- Test: `test/candidate-snapshot-scenario.test.ts` — `persistCandidateSnapshots` produces rows whose `scenarioBucket` matches `classifyScenarioBucket` for the pair

**Why:** Phase 4/5 (pairwise overlap, joint-combo calibration) need the scenario dimension on the FROZEN evidence, not just at recommend-time. Without it, historical combo evidence can never be bucketed by failure path. `classifyScenarioBucket` already exists (`lib/relate/scenarioBucket.ts`); this just threads + freezes it.

- [ ] **Step 1: Write the failing test** — build a fake `classified` pair (rival/mutex), call `persistCandidateSnapshots` with a stubbed DB writer, assert the captured snapshot input has `scenarioBucket === "rival_wins"`. (Refactor `persistCandidateSnapshots` to accept an injectable writer for unit-testability, or assert via the DATABASE_URL-gated path.)

- [ ] **Step 2: Run, verify FAIL** (no scenarioBucket field today).

- [ ] **Step 3: Schema migration** — add the columns in `db.ts` `SCHEMA_SQL` (idempotent `ADD COLUMN IF NOT EXISTS`).

- [ ] **Step 4: Thread the value** — in `candidateSnapshot.ts`, for each snapshot row compute
```ts
scenarioBucket: classifyScenarioBucket({ anchorTitle: anchor.title, candidateTitle: candidate.title, candidateMarketTitle: candidate.marketTitle, relation: cls.hypothesis?.relation, scope: graph?.scope, direction: cls.hypothesis?.direction, reason: cls.hypothesis?.mechanism }),
```
and add it (plus `dimension`, `associationGroup`) to the snapshot input + the `upsertAssociationCandidateSnapshots` INSERT/ON CONFLICT.

- [ ] **Step 5: Run, verify PASS.**

- [ ] **Step 6: Verify on real DB** — after a cron run, `SELECT scenario_bucket, count(*) FROM association_candidate_snapshot WHERE scenario_bucket IS NOT NULL GROUP BY 1`.

- [ ] **Step 7: tsc + suite + commit**
```bash
git commit -m "feat(snapshot): freeze scenarioBucket/dimension/associationGroup in candidate snapshots (combo evidence)"
```

---

## Task 4 (SUB-PROJECT — needs its own spec before coding): Full-market indexer

**This is NOT a one-shot edit.** Per the writing-plans scope check, write a dedicated spec (`docs/superpowers/specs/YYYY-MM-DD-market-indexer-design.md`) before implementation. Design outline:

- **New table** `market_index` (venue, event_key, market_id, title, rules, category, status, last_seen, closed_at, settled) — a continuously-refreshed catalog of OPEN markets across BOTH venues.
- **New cron** `/api/cron/index` — paginates ALL open Polymarket events (`/events?closed=false` deep) + Kalshi (`listKalshiEvents` across the series catalog), upserting into `market_index`. Bounded per run; rotate offset/series like the backfill `startPage`.
- **Recall change**: `discoverRelations` recall reads candidates from `market_index` (not the fixed top-N PM-event fetch in `lib/relate/discover.ts`), so coverage is the whole indexed universe, not a sample.
- **Verification**: `market_index` row count grows to the real open-market total (thousands); a relation-discovery run surfaces candidates absent from the old fixed universe; no increase in leakage (index is open markets only, frozen via the existing snapshot path).
- **Risk**: cost/latency of classifying a large universe — keep the anchor-driven recall + φ gate; the index widens the POOL, not the per-anchor classify count.

---

## Task 5 (SUB-PROJECT — needs its own spec before coding): Execution-grade price/book snapshots, all venues

**This is NOT a one-shot edit.** Write `docs/superpowers/specs/YYYY-MM-DD-book-snapshot-design.md` first. Design outline:

- **Extend** `book_snapshot` to every FROZEN anchor/candidate token (both sides), Polymarket AND Kalshi, storing `bid/ask/mid/depth/spread` + `observed_at` (not just the default PM event YES token in `/api/cron/snapshot`).
- **`/api/cron/snapshot`** iterates the live frozen candidate set (from `association_candidate_snapshot` where the market is still open) instead of only `HEDGE_DEFAULT_EVENT_SLUG`.
- **Backtest upgrade**: `candidate_price` in the walk-forward sources from the historical book at `observed_at` (executable ask, not normalized mid) → execution-grade fail-loss-reduction numbers.
- **Verification**: book rows exist for frozen Kalshi + PM candidate tokens; `/api/backtest/association?grain=bucket` fail-loss-reduction computed on real executable prices; spread/depth present for sizing realism.

---

## Self-review

- **Spec coverage:** Tasks 1–3 fully implement issues #1, #2, #3 with code + tests + verification. Issues #4 (radar) and #5 (book) are correctly scoped as sub-projects (Tasks 4–5) needing their own design specs — they are independent subsystems, per the scope check.
- **Sequencing:** Task 1 first (closes the active honesty hole; everything downstream trusts it). Tasks 2–3 enrich frozen evidence cheaply. Tasks 4–5 are the big lifts, deferred to their own specs.
- **Invariant check:** Task 1 makes live calibration strictly a SUBSET of frozen evidence (never looser than the backtest). No task lets gold/LLM/post-resolution data into calibration.
- **Type consistency:** `classifyScenarioBucket` signature in Task 3 matches `lib/relate/scenarioBucket.ts`; `loadBucketBranchRows` return shape unchanged in Task 1 (only the WHERE changes).
