/**
 * lib/relate/elicitSampling.ts — deterministic sampling for cron-side elicited-prior capture (#5).
 *
 * /api/cron/relations freezes the candidate SET cheaply (no LLM elicitation) by default, so the snapshot's
 * p_given_fails/p_given_wins are null and you can't later score "was the MODELED prior accurate" against the
 * realized outcome. This decides, for a given anchor index on a given day, whether to run the (more expensive)
 * withStrategies elicitation so a SAMPLE of snapshots freeze their priors. Deterministic (NOT random) so runs
 * are reproducible and, by rotating with day-of-year, every anchor gets sampled over time.
 */

/** dayOfYear: 1-366 UTC. Pass in (callers compute once) so this stays pure + unit-testable. */
export function shouldElicit(elicitSample: number, index: number, dayOfYear: number): boolean {
  if (!(elicitSample > 0)) return false;     // default off ⇒ cheap cron, unchanged behavior
  if (elicitSample >= 1) return true;        // 1.0 ⇒ elicit every anchor
  const step = Math.max(1, Math.round(1 / elicitSample)); // e.g. 0.25 ⇒ every 4th (index+day) slot
  return (index + dayOfYear) % step === 0;
}

/** UTC day-of-year (1-366) for a timestamp; the rotation offset so different anchors elicit on different days. */
export function dayOfYearUTC(nowMs: number): number {
  const d = new Date(nowMs);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86_400_000);
}
