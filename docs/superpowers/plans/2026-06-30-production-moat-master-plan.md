# Production-Grade Moat — Master Orchestration Plan

> **For agentic workers:** This is the MASTER plan. Each block below gets its OWN spec
> (`docs/superpowers/specs/YYYY-MM-DD-<block>-design.md`) and OWN implementation plan
> (`docs/superpowers/plans/YYYY-MM-DD-<block>.md`) before coding, is implemented TDD task-by-task, and is
> TESTED + merged to main on completion. A GLOBAL test runs after all three blocks land.

**Goal:** Take the moat from "clean single-leg CALIBRATED pipeline" to "production-grade full-market radar +
multi-leg joint calibration", closing the three remaining next-phase gaps the audit identified.

**The three blocks (verified-open gaps):**
- **A — True full-market radar.** `/api/cron/relations` anchors are still config-based (8 jobs); recall reads
  the index but discovery is anchor-driven, not anchor-ENUMERATION from `market_index`. → enumerate anchors
  from the full index.
- **C — Multi-leg joint calibration.** `scenario_bucket` is frozen + Phase 4-5 machinery (comboBacktest,
  jointCalibration) exists, but there are NO `combo_snapshot`/`combo_observation` tables, no combo freezing at
  recommend time, no settled combo observations → joint calibration is dormant. → build the combo data pipeline.
- **B — Full historical order-book warehouse.** `captureFrozenBooks` is a 21-day frozen-candidate slice, not a
  continuous full-market price store. → continuous book capture over the indexed universe.

---

## Sequencing (which first, and why)

**A → C → B.**

1. **A first (supply foundation).** The binding moat constraint is INDEPENDENT settled episodes. A widens the
   anchor+candidate supply that EVERYTHING downstream (single-leg calibration, combos) feeds on. It also
   completes the half-built radar (recall-from-index already landed; anchor-enumeration is the missing half).
   Highest leverage per unit work.
2. **C second (the product).** Multi-leg joint calibration is the defining incomplete capability and the actual
   hedge product shape. Its Phase 4-5 MACHINERY already exists; C builds the DATA pipeline (freeze combos →
   settle → feed the backtest/gate). It benefits from A's wider candidate supply (better combos to freeze).
   Like single-leg, the CALIBRATION accrues over time — but the logging must start now to ever accrue.
3. **B last (enhancement, possibly already sufficient).** A full continuous order-book warehouse is the most
   infra-heavy and LEAST urgent: you only need execution-grade books for markets you actually hedge with = the
   frozen candidates, which the first slice already covers. B is a coverage/freshness upgrade, not a missing
   capability. Re-evaluate scope after A+C: B may be reducible to "raise captureFrozenBooks frequency/coverage".

**Honesty invariants every block preserves:** gold never promotes CALIBRATED; LLM never writes settlement
evidence; no post-resolution snapshot in calibration OR backtest; live calibration ⊆ backtest frozen evidence
(snapshot-exists + ≥24h lead); no current price replaces historical; no same-cluster leakage; no
JOINT-CALIBRATED label before joint settlement evidence; bounded LLM/API cost per cron run.

---

## Per-block process (applied to A, then C, then B)

For each block, in order:
1. **Spec** (brainstorming-style, grounded in code): `docs/superpowers/specs/YYYY-MM-DD-<block>-design.md` —
   problem, architecture, schema, interfaces, cost bounds, honesty invariants, verification strategy. Commit.
2. **Plan** (writing-plans): `docs/superpowers/plans/YYYY-MM-DD-<block>.md` — bite-sized TDD tasks with code +
   exact verification per task. Commit.
3. **Implement** task-by-task (TDD: failing test → minimal code → pass), each task tsc-clean + suite-green.
4. **Block test**: unit tests + a DATABASE_URL-gated/empirical end-to-end check proving the block works on real
   data; the existing credibility report (`/api/backtest/association?grain=bucket`) must not regress.
5. **Merge to main** (ff per block — the cron runs from main), update memory.

## Global test (after A + C + B)
- Full `npx tsc --noEmit && npx vitest run` green.
- One manual workflow_dispatch run on main exercising the full pipeline (index → relations w/ enumerated
  anchors → snapshot+books → settle → backtest grain=bucket + combo backtest), asserting: crons 200,
  leakageViolations=0, the 4 single-leg CALIBRATED buckets intact, combo snapshots written, no JOINT-CALIBRATED
  promoted without evidence.
- A short report: what's now production-grade vs what still accrues over time (settlement data).

---

## Block summaries (each expanded in its own spec)

### A — Full-market radar (do first)
- **New:** anchor enumeration from `market_index` — pick a rotated, diversified, bounded set of anchors (by
  volume/liquidity/category spread, deduped vs config jobs), feed them through the existing relations/discover
  path. Bounded per cron run (cost = anchors × discover LLM).
- **Touches:** a new `lib/relate/anchorEnumeration.ts` (pure selection) + `/api/cron/relations` (merge enumerated
  anchors with config jobs, `?indexAnchors=` knob) + cron wiring.
- **Verify:** enumeration returns a diverse anchor set from the index; a cron run discovers from index-sourced
  anchors not in the config; snapshots written; no leakage; cost bounded.

### C — Multi-leg joint calibration pipeline (do second)
- **New:** `combo_snapshot` + `combo_leg_snapshot` + `combo_observation` tables (doc Part II schema); freeze the
  combo the engine recommends at discover time (policy version, legs, scenarioBuckets, overlap penalties,
  coverage estimate); settle them (anchor + each leg outcome) in the settle cron; a combo walk-forward that
  feeds `comboBacktest` + `jointCalibratedGate` from REAL combo observations.
- **Touches:** schema (db.ts), a new `lib/relate/comboSnapshot.ts` (freeze/settle), discover persist hook,
  settle cron hook, `/api/backtest/association?grain=combo` (or a new route) wiring comboBacktest.
- **Verify:** a discover with a combo freezes a combo_snapshot + leg rows; a synthetic settle produces a
  combo_observation; comboBacktest runs on it; jointCalibratedGate stays not-eligible until ≥100 clusters
  (never promotes on no data).

### B — Order-book warehouse (do last; re-scope after A+C)
- **New (if still warranted):** continuous book capture over the `market_index` universe (rotated, bounded) into
  `book_snapshot`, not just frozen candidates; freshness/coverage telemetry.
- **Touches:** extend `/api/cron/snapshot` or a new `/api/cron/books` to sweep index tokens; resolve PM
  conditionId→token via bundles, Kalshi ticker direct.
- **Verify:** book_snapshot coverage of the indexed universe grows; the execution-grade backtest's book-hit rate
  rises; bounded cost.

---

## Self-review
- **Coverage:** A/C/B cover the three verified gaps (radar, joint combo, order-book). Sequenced foundation →
  product → enhancement.
- **Decomposition:** each block is an independent subsystem with its own spec+plan (scope-check satisfied).
- **Invariant check:** no block lets gold/LLM/post-resolution/<24h-lead data into calibration; C never promotes
  JOINT-CALIBRATED without settled joint evidence.
- **Realism:** A and B widen DATA; C builds MACHINERY+LOGGING. The CALIBRATION (single + joint) still accrues
  over real settlement time — the blocks make the pipeline production-grade, they don't manufacture the moat.
