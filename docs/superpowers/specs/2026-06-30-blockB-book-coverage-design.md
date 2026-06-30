# Block B — Execution-Price Coverage + Telemetry — Design

**Status:** spec → implement. Part of `2026-06-30-production-moat-master-plan.md` (block 3 of 3). RE-SCOPED after
A+C per the master plan.

## Re-scoping decision (honest)
A full continuous order-book warehouse for ALL ~9.8k indexed markets is over-engineering: you only need
execution-grade books for markets you actually hedge with = the FROZEN candidates. `captureFrozenBooks` (the #3
first slice) already captures those. The real remaining gaps are **coverage, freshness, and visibility**:
1. `captureFrozenBooks` is unprioritized (`DISTINCT` with no order) + capped at 400 → it can miss freshly-frozen
   candidates, which are exactly the ones a re-freeze will need a book for next hour.
2. There is **no telemetry** on execution-grade coverage — we cannot see what fraction of backtest-eligible
   frozen candidates actually have a usable book (`book_snapshot.ts ≤ observed_at`), so we're blind to whether
   the warehouse is working.

**Explicitly NOT done (honesty over completeness):** we do NOT relax the backtest's strict `ts ≤ observed_at`
join — that would admit a tiny post-decision look-ahead. The re-freeze mechanism (hourly re-snapshot + the
backtest's `DISTINCT ON … ORDER BY observed_at DESC` picking the latest snapshot, which has a prior-hour book)
already delivers zero-look-ahead execution-grade coverage; Block B raises its hit-rate and makes it visible.

## Architecture

### 1. `bookCoverageStats(minLeadHours = 24)` (NEW, in frozenBooks.ts) — the telemetry centerpiece
Reports execution-grade coverage over the SAME population the execution-grade backtest scores: frozen candidate
snapshots with a `candidate_token_id`, eligible by the ≥24h lead. For each, is there a `book_snapshot` with
`ts ≤ observed_at`?
```ts
export interface BookCoverageStats {
  eligibleSnapshots: number;   // frozen candidate snapshots with candidate_token_id (lead-eligible)
  withBook: number;            // … that have a book_snapshot at/before observed_at (execution-grade)
  coverage: number;            // withBook / eligibleSnapshots
  distinctTokens: number;      // distinct candidate tokens in the eligible set
  tokensWithAnyBook: number;   // … with ANY book_snapshot row (freshness proxy)
}
export async function bookCoverageStats(minLeadHours?: number): Promise<BookCoverageStats>
```
Pure SQL aggregate (no fetches). This is the number that tells us the moat's execution-grade health.

### 2. `captureFrozenBooks` improvements
- Prioritize **freshest** frozen candidates: `ORDER BY max(observed_at) DESC` (so this hour's freezes get a book
  this hour → next hour's re-freeze can join it). Raise the default `limit` to 800.
- Return `coverage` (call `bookCoverageStats` at the end) so the cron response shows the live hit-rate.

### 3. Cron wiring
`/api/cron/snapshot` already calls `captureFrozenBooks`; surface the returned `coverage` in its response. No new
cron needed (book capture stays in the hourly snapshot pass).

## Honesty invariants
- `book_snapshot.ts` is the true capture time (no back-stamping); the strict `ts ≤ observed_at` join is
  unchanged ⇒ zero look-ahead. Open markets only; no settlement evidence written.
- Coverage telemetry is descriptive — it never sizes, calibrates, or promotes.

## Verification
**DB-gated (`test/book-coverage.test.ts`):** insert a lead-eligible candidate snapshot with a token + a
`book_snapshot` at ts ≤ observed_at ⇒ counted in `withBook`; a second snapshot whose only book is AFTER
observed_at ⇒ eligible but NOT in `withBook`. Asserts the coverage fraction reflects exactly the execution-grade
(≤ observed_at) books. Self-cleaning (unique PFX).
**Empirical (manual):** `bookCoverageStats()` on the real DB returns a baseline hit-rate; after a snapshot-cron
run the freshest-frozen candidates are covered; coverage appears in the cron response.

## Out of scope (explicit, with rationale)
- Threading `priceSide`'s already-fetched book into a freeze-time (ts=observed_at) warehouse write — would
  eliminate the one-cron first-freeze lag but needs a refactor of the hot pricing path; the re-freeze mechanism
  already covers it. Noted as a future refinement.
- Books for combo legs / anchors — combo settlement uses the frozen `leg_price`, and the candidate-price
  backtest needs only candidate books; neither needs extra book coverage.

## Self-review
- Placeholders: none. Consistency: `bookCoverageStats` reads the same `candidate_token_id` + lead gate the
  execution-grade backtest uses. Scope: focused (telemetry + freshness), matching the master plan's re-scope.
  Ambiguity: "usable book" = `ts ≤ observed_at` (the exact backtest join) — stated.
