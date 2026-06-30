# Block C — Multi-Leg Joint Calibration Data Pipeline — Design

**Status:** spec → implement. Part of `2026-06-30-production-moat-master-plan.md` (block 2 of 3).

## Problem
The Phase 4-5 combo MACHINERY exists and is unit-tested — `backtestCombos()` (walk-forward combo scorer) and
`jointCalibratedGate()` (the JOINT-CALIBRATED promotion gate, correctly not-eligible on no data). But nothing
ever FREEZES the combos the engine recommends, so no settled combo evidence accrues and the machinery runs on
empty input forever. Block C builds the DATA pipeline that feeds it: freeze recommended combos → settle them →
assemble `BacktestComboRecord[]`.

## What already exists (reused, not rebuilt)
- `HedgeCombo` / `HedgeComboLeg` (discover.ts) — the recommended combo shape (legs carry marketId, venue,
  side, legPrice, costUsd, scenario, tier; combo carries coverage, totalCostUsd, tier).
- `backtestCombos(BacktestComboRecord[])` → `ComboBacktestReport` — pure, walk-forward (drops observedAt ≥
  resolvedAt), reports coverage calibration gap + fail-loss reduction + marginal contribution by rank.
- `jointCalibratedGate(ComboFamilyEvidence)` — pure; stays `{eligible:false}` until ≥100 clusters etc.
- Settlement primitives: `pmOutcome(midpointYes, resolved)` / `kalshiOutcome(result, status)` →
  `boolean|null`; the settle cron re-fetches markets by event_key/venue. `SettledOutcome { settledYes, resolvedAtMs }`.

## Architecture

### 1. Schema (db.ts) — two tables, resolution columns inline (no separate observation table)
```sql
CREATE TABLE combo_snapshot (
  combo_id text PRIMARY KEY,              -- deterministic: `${anchorMarketId}:${observedAt}:${legSig}`
  anchor_market_id text NOT NULL, anchor_venue text NOT NULL, anchor_event_key text NOT NULL,
  observed_at timestamptz NOT NULL,       -- FREEZE time (must precede anchor resolution: walk-forward)
  predicted_coverage_lower double precision NOT NULL,  -- combo.coverage, frozen
  premium_usd double precision NOT NULL,  -- combo.totalCostUsd, frozen
  tier text NOT NULL,                     -- 'CALIBRATED' | 'MODELED' at freeze
  cluster_key text NOT NULL,              -- episode cluster for dedup (anchor event family + resolution date)
  -- settlement (filled by settleComboSnapshots when anchor + ALL legs resolve):
  anchor_resolved_at timestamptz, anchor_pays boolean, combo_payoff_usd double precision, settled_at timestamptz
);
CREATE TABLE combo_leg_snapshot (
  combo_id text NOT NULL, rank int NOT NULL,
  market_id text NOT NULL, venue text NOT NULL, event_key text NOT NULL, side text NOT NULL,  -- 'YES'|'NO'
  leg_price double precision NOT NULL, cost_usd double precision NOT NULL, scenario_bucket text NOT NULL,
  paid boolean,                            -- filled at settle
  PRIMARY KEY (combo_id, rank)
);
```

### 2. `lib/relate/comboSnapshot.ts` (NEW)
**Pure (TDD core):**
- `legPaid(side: 'YES'|'NO', settledYes: boolean): boolean` — YES⇒settledYes, NO⇒!settledYes.
- `comboPayoffUsd(legs: {paid:boolean; costUsd:number; legPrice:number}[]): number` — Σ paid ? costUsd/legPrice : 0
  (you buy costUsd/legPrice shares at legPrice; each pays $1 if its side wins).
- `toBacktestRecord(snap, legs): BacktestComboRecord | null` — assemble; null if unsettled (anchor_pays null or
  any leg.paid null) so only fully-settled combos enter the backtest.

**DB:**
- `persistComboSnapshots(anchor, combos: HedgeCombo[], observedAt: Date): Promise<number>` — freeze each combo +
  its legs. combo_id deterministic ⇒ idempotent (ON CONFLICT DO NOTHING — never overwrite a frozen combo).
  cluster_key = `${anchorEventFamily}:${observedDay}` (coarse episode dedup; refined later). Only persists
  combos with ≥1 leg. **Open markets only — writes no settlement.**
- `settleComboSnapshots(limit=200): Promise<{settled:number; pending:number; dropped:number}>` — for combos with
  anchor_resolved_at IS NULL, re-fetch anchor + every leg by (venue, event_key, market_id) → SettledOutcome.
  When anchor AND all legs resolve: set per-leg paid, anchor_pays, combo_payoff_usd, anchor_resolved_at,
  settled_at. Legs that aged out of the venue API before resolving ⇒ combo can never complete ⇒ left pending
  (honestly uncounted). Leakage-safe (only settled outcomes; observed_at already frozen earlier).
- `loadComboBacktestRecords(limit=5000): Promise<BacktestComboRecord[]>` — settled combos → records via
  `toBacktestRecord`, cluster-deduped (one record per cluster_key, the earliest observed_at).

### 3. Hooks
- **Freeze** (discover.ts, where `persistCandidateSnapshots` is already called): after combos are built, call
  `persistComboSnapshots(anchor, combos, at)` (DB-gated, fail-safe). Additive — no effect on the returned result.
- **Settle** (`/api/cron/settle`): after the existing sweep, call `settleComboSnapshots()`, include counts in the
  response.

### 4. Route `/api/backtest/combo`
`backtestCombos(await loadComboBacktestRecords())` + the `jointCalibratedGate` verdict on the aggregate family
evidence (which will report not-eligible with reasons until data accrues). JSON report.

## Honesty invariants
- Combos frozen STRICTLY before anchor resolution (observed_at); `backtestCombos` re-asserts walk-forward and
  drops violators. LLM never writes a leg's settled outcome — only `pmOutcome`/`kalshiOutcome` do.
- `jointCalibratedGate` NEVER returns eligible without ≥100 cluster-deduped settled fail-episodes — the product
  cannot show JOINT-CALIBRATED before joint settlement evidence (non-negotiable).
- cluster-dedup in `loadComboBacktestRecords` prevents one episode counting many times.

## Verification
**Unit (`test/combo-snapshot.test.ts`, no DB):** legPaid (both sides), comboPayoffUsd (mixed paid/unpaid,
zero), toBacktestRecord (settled ⇒ record; unsettled ⇒ null).
**DB-gated (`test/combo-pipeline.test.ts`):** persist a combo + 2 legs → rows exist; simulate settlement (set
resolution columns) → loadComboBacktestRecords returns 1 record → backtestCombos scores it (combos:1) →
jointCalibratedGate on a tiny family ⇒ eligible:false with "only N clusters" reason. Self-cleaning (unique PFX).
**Empirical (manual):** a `/api/cron/settle` run returns combo settlement counts; `/api/backtest/combo` returns a
report (note: "no frozen combos yet" until discover has frozen some + they settle).

## Out of scope (explicit)
- Learned overlap penalty wired back into live combo selection (`learnedOverlapPenalty`) — stays dormant until
  pairwise evidence accrues; Block C only LOGS + MEASURES, never changes live sizing.
- Combo-leg cluster-disjointness refinement beyond the coarse `${family}:${day}` key — later.

## Self-review
- Placeholders: none. Consistency: combo_id/leg shapes match across schema, persist, settle, assemble. Types:
  `BacktestComboRecord` fields (observedAt, anchorResolvedAt, anchorPays, predictedCoverageLower, premiumSpent,
  comboPayoffUsd, legs[{rank,scenario,paid}]) are exactly what `toBacktestRecord` returns. Scope: one subsystem.
  Ambiguity: anchor position assumed YES-hold (the hedged side); anchor_pays = anchor.settledYes — stated.
