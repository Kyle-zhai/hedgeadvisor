# Block A — Full-Market Radar (anchor enumeration from market_index) — Design

**Status:** spec → implement. Part of `2026-06-30-production-moat-master-plan.md` (block 1 of 3).

## Problem
`/api/cron/relations` only ever discovers from **8 hardcoded config anchors** (`DEFAULT_SNAPSHOT_JOBS`). The
recall-from-index slice already lets each discover pull CANDIDATES from the full `market_index`, but the set of
ANCHORS is still a fixed sample. The index holds the full open universe (~9.8k markets). To make discovery a
true full-market radar, the cron must also **enumerate anchors from the index** — so over time every open event
gets a turn as an anchor, not just the 8 configured domains.

## Constraint that shapes the design
`discoverRelations` always resolves the anchor to a **Polymarket** market
(`resolvePosition(query, eventSlug)` / `resolveAnyPosition(query)` → `polymarket:${conditionId}`). Kalshi cannot
currently be an ANCHOR (only a candidate). So Block A enumerates **PM anchors only**; Kalshi-anchor support is an
explicit out-of-scope follow-on (would need a Kalshi resolve path in discover).

## Architecture (3 pieces, additive — never breaks the config path)

### 1. `lib/relate/anchorEnumeration.ts` (NEW, pure — the testable core)
```ts
export interface AnchorJob { query: string; eventSlug: string; topK: number }
export interface IndexAnchorRow { venue: string; eventKey: string; title: string; marketTitle: string; category: string }

/** Pure: pick a rotated, diversified, deduped, bounded anchor set from index rows.
 *  - PM-only (venue==='polymarket'); Kalshi rows dropped (can't anchor today).
 *  - One anchor per EVENT (dedupe by eventKey) — the event's representative market.
 *  - Diversified: round-robin across category buckets so no single domain dominates a run.
 *  - Rotated: `offset` (a daily cursor) selects a different slice each run → full sweep over time.
 *  - Bounded: at most `limit` jobs. query = marketTitle||title, eventSlug = eventKey, topK = 4. */
export function selectIndexAnchors(rows: IndexAnchorRow[], opts: { limit: number; offset?: number }): AnchorJob[]
```
Selection algorithm: filter PM + non-empty eventKey/title → dedupe by eventKey (first wins) → group by category
→ rotate each group by `offset` → round-robin pull across category groups until `limit` reached. Deterministic
(no Date/random inside; offset passed in).

### 2. `lib/relate/marketIndex.ts` (extend)
```ts
/** PM open rows for anchor enumeration, deterministic order (event_key) for stable rotation. Fail-safe []. */
export async function loadIndexAnchorRows(limit = 2000): Promise<IndexAnchorRow[]>
```
SQL: `SELECT venue, event_key, title, market_title, category FROM market_index WHERE venue='polymarket' AND
status='open' ORDER BY event_key LIMIT n`. (DISTINCT-ish handled in the pure selector by eventKey dedupe.)

### 3. `/api/cron/relations` (extend)
- New query param `?indexAnchors=N` (default 0, clamped 0..40). When N>0: `loadIndexAnchorRows()` →
  `selectIndexAnchors(rows, {limit: N, offset: dayOfYearUTC})` → dedupe vs configured jobs by eventSlug → append
  to the job list. The existing `runJob` path runs them unchanged (an enumerated job is a normal `{query,
  eventSlug, topK}`).
- Response gains `indexAnchors: <count actually appended>` for observability.

### Cron wiring (`.github/workflows/hedge-cron.yml`)
Hourly relations call gains `&indexAnchors=12` (bounded). `dayOfYearUTC` rotation means consecutive days sweep
different index slices; a full sweep of ~N_events/12 days. Cost = (8 config + ≤12 index) discovers/run, within
the existing bounded-concurrency budget + 600s maxDuration.

## Honesty invariants (unchanged, re-verified)
- Enumerated anchors flow through the SAME freeze path (`persistCandidateSnapshots`): snapshots are frozen
  pre-resolution, LLM only classifies, settlement evidence still comes only from the settle cron. No new leakage
  surface.
- Bounded LLM/API cost per run (hard clamp on `indexAnchors`).
- Pure selector has no side effects, no Date/random (rotation cursor injected) → fully testable + resumable.

## Verification
**Unit (`test/anchor-enumeration.test.ts`, no DB):**
1. PM-only — Kalshi rows dropped.
2. Dedupe by eventKey — two rows same event ⇒ one job.
3. Diversification — with 3 categories × many events and limit 6, the 6 jobs span all 3 categories (round-robin),
   not 6 from one category.
4. Rotation — different `offset` yields a different leading slice (coverage moves).
5. Bounded — never more than `limit`; empty input ⇒ [].

**Empirical (DB-gated, manual):** a relations run with `?indexAnchors=8` returns `indexAnchors>0`, the results
include eventSlugs NOT in `DEFAULT_SNAPSHOT_JOBS`, snapshots written, every result `status!=='error'`. The
bucket-backtest credibility report does not regress (no leakage introduced).

## Out of scope (explicit)
- Kalshi-as-anchor (needs a Kalshi resolve path) — follow-on.
- Volume/liquidity ranking of anchors — v1 uses category round-robin for breadth; ranking is a later refinement.

## Self-review
- Placeholder scan: none. Internal consistency: the `IndexAnchorRow`/`AnchorJob` shapes match across the three
  pieces. Scope: single subsystem (anchor enumeration), one plan. Ambiguity: rotation offset = `dayOfYearUTC`
  (explicit). Decision: PM-only is a stated constraint, not a gap.
