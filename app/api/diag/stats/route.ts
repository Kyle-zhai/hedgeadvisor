/**
 * app/api/diag/stats/route.ts — secret-gated read-only view of accumulated data across the moat tables.
 * Shows the closed-loop's progress: price snapshots, frozen candidate pairs (pre-settlement),
 * settled observations, and how many are backtest-eligible (leakage-safe).
 */
import { NextResponse } from "next/server";
import { getSql, dbEnabled, ensureSchema } from "@/lib/data/db";
import { loadTuningProfile } from "@/lib/relate/tuningProfile";
import relationCorrectionSnapshot from "@/lib/association/relationCorrection.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!dbEnabled()) return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  const sql = await getSql();
  if (!sql) return NextResponse.json({ error: "postgres unavailable" }, { status: 503 });
  await ensureSchema(sql);

  const overview = (await sql`
    SELECT
      (SELECT count(*) FROM book_snapshot)::int AS book_snapshots,
      (SELECT count(DISTINCT token_id) FROM book_snapshot)::int AS book_tokens,
      (SELECT max(ts)::text FROM book_snapshot) AS book_newest,
      (SELECT count(*) FROM association_relation)::int AS relations,
      (SELECT count(*) FROM association_candidate_snapshot)::int AS candidate_snapshots,
      (SELECT count(DISTINCT relation_key) FROM association_candidate_snapshot)::int AS frozen_relation_keys,
      (SELECT count(DISTINCT (anchor_market_id, candidate_market_id)) FROM association_candidate_snapshot)::int AS frozen_pairs,
      (SELECT min(observed_at)::text FROM association_candidate_snapshot) AS frozen_oldest,
      (SELECT max(observed_at)::text FROM association_candidate_snapshot) AS frozen_newest,
      (SELECT count(*) FROM association_observation)::int AS observations,
      (SELECT count(*) FROM association_observation WHERE resolved_at IS NOT NULL)::int AS observations_resolved
  `)[0];

  // Leakage-safe backtest rows: settled observation that JOINs a snapshot frozen before resolution.
  const backtestEligible = (await sql`
    SELECT count(*)::int AS rows, count(DISTINCT relation_key)::int AS relation_keys
    FROM (
      SELECT DISTINCT o.relation_key, o.sample_key
      FROM association_observation o
      JOIN association_candidate_snapshot s
        ON s.relation_key = o.relation_key AND s.anchor_market_id = o.anchor_market_id
       AND s.candidate_market_id = o.candidate_market_id AND s.observed_at <= o.resolved_at
      WHERE o.resolved_at IS NOT NULL
    ) eligible
  `)[0];

  // Frozen pairs still waiting for their markets to settle.
  const pendingRows = (await sql`
    SELECT count(*)::int AS pending FROM (
      SELECT DISTINCT s.relation_key, s.anchor_market_id, s.candidate_market_id
      FROM association_candidate_snapshot s
      WHERE s.anchor_event_key IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM association_observation o
        WHERE o.relation_key = s.relation_key AND o.anchor_market_id = s.anchor_market_id
          AND o.candidate_market_id = s.candidate_market_id)
    ) x
  `) as Array<{ pending: number }>;
  const pendingFrozen = pendingRows[0]?.pending ?? 0;

  const topFrozenRelations = await sql`
    SELECT relation_key,
           count(*)::int AS snapshots,
           count(DISTINCT (anchor_market_id, candidate_market_id))::int AS pairs,
           max(observed_at)::text AS last_seen
    FROM association_candidate_snapshot
    GROUP BY relation_key ORDER BY pairs DESC, snapshots DESC LIMIT 15
  `;

  const llmCache = (await sql`
    SELECT count(*) FILTER (WHERE expires_at > now())::int AS active_entries,
           COALESCE(sum(hits) FILTER (WHERE expires_at > now()), 0)::int AS hits,
           max(last_hit_at)::text AS last_hit_at
    FROM llm_relation_cache
  `)[0];
  const llmRuns24h = await sql`
    SELECT operation, model, status, cache_hit,
           count(*)::int AS runs,
           round(avg(latency_ms))::int AS avg_latency_ms,
           count(*) FILTER (WHERE jsonb_array_length(CASE WHEN jsonb_typeof(attempts) = 'array' THEN attempts WHEN jsonb_typeof(attempts) = 'string' THEN (attempts #>> '{}')::jsonb ELSE '[]'::jsonb END) > 1)::int AS fallback_runs
    FROM llm_relation_run
    WHERE created_at >= now() - interval '24 hours'
    GROUP BY operation, model, status, cache_hit
    ORDER BY operation, runs DESC
  `;
  // Per-model success / timeout / fallback telemetry, unnested from every attempt (not just the final
  // model). A timeout is an aborted attempt (the model's per-call deadline). The fallback ratio is the
  // share of runs whose first model failed (>1 attempt). This is the MiniMax health view requested.
  const modelAttempts = await sql`
    SELECT a->>'model' AS model,
           count(*)::int AS attempts,
           count(*) FILTER (WHERE a->>'status' = 'ok')::int AS successes,
           count(*) FILTER (WHERE a->>'status' = 'error' AND (a->>'reason') ILIKE '%abort%')::int AS timeouts,
           round(avg(NULLIF((a->>'durationMs'), '')::numeric))::int AS avg_ms
    FROM llm_relation_run, jsonb_array_elements(CASE WHEN jsonb_typeof(attempts) = 'array' THEN attempts WHEN jsonb_typeof(attempts) = 'string' THEN (attempts #>> '{}')::jsonb ELSE '[]'::jsonb END) AS a
    WHERE created_at >= now() - interval '24 hours' AND a->>'model' IS NOT NULL
    GROUP BY a->>'model' ORDER BY attempts DESC
  ` as Array<{ model: string; attempts: number; successes: number; timeouts: number; avg_ms: number }>;
  const fallbackAgg = (await sql`
    SELECT count(*)::int AS total_runs,
           count(*) FILTER (WHERE jsonb_array_length(CASE WHEN jsonb_typeof(attempts) = 'array' THEN attempts WHEN jsonb_typeof(attempts) = 'string' THEN (attempts #>> '{}')::jsonb ELSE '[]'::jsonb END) > 1)::int AS fallback_runs,
           count(*) FILTER (WHERE status = 'ok')::int AS ok_runs
    FROM llm_relation_run WHERE created_at >= now() - interval '24 hours'
  `)[0] as { total_runs: number; fallback_runs: number; ok_runs: number };
  const modelTelemetry = {
    windowHours: 24,
    perModel: modelAttempts.map((m) => ({
      model: m.model,
      attempts: m.attempts,
      successes: m.successes,
      errors: m.attempts - m.successes,
      timeouts: m.timeouts,
      successRate: m.attempts ? Number((m.successes / m.attempts).toFixed(3)) : null,
      timeoutRate: m.attempts ? Number((m.timeouts / m.attempts).toFixed(3)) : null,
      avgMs: m.avg_ms,
    })),
    fallbackRatio: fallbackAgg.total_runs ? Number((fallbackAgg.fallback_runs / fallbackAgg.total_runs).toFixed(3)) : null,
    runOkRate: fallbackAgg.total_runs ? Number((fallbackAgg.ok_runs / fallbackAgg.total_runs).toFixed(3)) : null,
    totalRuns: fallbackAgg.total_runs,
  };
  const readinessRows = await sql`
    SELECT relation_key,
           count(DISTINCT COALESCE(cluster_key, sample_key))::int AS independent_clusters
    FROM association_observation
    WHERE resolved_at IS NOT NULL
    GROUP BY relation_key
  ` as Array<{ relation_key: string; independent_clusters: number }>;
  const clusterRows = await sql`
    SELECT DISTINCT COALESCE(cluster_key, sample_key) AS cluster
    FROM association_observation WHERE resolved_at IS NOT NULL
  ` as Array<{ cluster: string }>;
  const n = new Set(clusterRows.map((row) => row.cluster)).size;
  // The LEARNED RULES the engine extracts from settlement data (role × mechType × direction × side buckets),
  // pooled across all templates and cluster-deduplicated — what tunes the engine for unseen questions.
  const profile = await loadTuningProfile(0).catch(() => new Map());
  // EXCLUDE coarse SIGN-PURE fallback rungs (fallbackRung): they pool samples ACROSS roles for a MODELED
  // shrink nudge only — their pooled N must NEVER be reported or counted as CALIBRATED (honesty backbone:
  // CALIBRATED = a leaf rung's OWN settlement-proven samples). Only LEAF rungs are promotion-eligible.
  const buckets = [...profile.values()].filter((b) => !(b as { fallbackRung?: boolean }).fallbackRung) as Array<{ samplesFail: number; samplesWin: number; specificity: number; hedgeSpecificityLower: number }>;
  const isCalibrated = (b: { samplesFail: number; samplesWin: number }) => Math.min(b.samplesFail, b.samplesWin) >= 20;
  // A CALIBRATED bucket is a HEDGE only when its conservative cross-bound proves it pays more on a fail
  // (hedgeSpecificityLower > 0); a settlement-proven co-mover (specificity < 0) is an AMPLIFIER the optimizer
  // never admits as a hedge. Split so a reader never mistakes amplifier maturity for hedge readiness.
  const calibratedHedgeBuckets = buckets.filter((b) => isCalibrated(b) && b.hedgeSpecificityLower > 0).length;
  const calibratedAmplifierBuckets = buckets.filter((b) => isCalibrated(b) && b.specificity < 0).length;
  const calibrationReadiness = {
    independentClusters: n,
    // `phase` is GLOBAL settlement-collection progress (all independent episode clusters), NOT hedge-bucket
    // calibration: a high phase does NOT imply any usable hedge exists — see calibratedHedgeBuckets.
    phase: n >= 500 ? "stable_optimization" : n >= 300 ? "strong_calibration" : n >= 100 ? "initial_recalibration" : "collecting",
    phaseScope: "global_collection",
    nextMilestone: n < 100 ? 100 : n < 300 ? 300 : n < 500 ? 500 : n < 1000 ? 1000 : null,
    remaining: n < 100 ? 100 - n : n < 300 ? 300 - n : n < 500 ? 500 - n : n < 1000 ? 1000 - n : 0,
    calibratedHedgeBuckets,
    calibratedAmplifierBuckets,
    // bucketsAt20PerBranch is the unit the CALIBRATED gate ACTUALLY uses: pooled across relation_keys within
    // a coarse bucket, cluster-deduplicated (≥20 independent episodes in BOTH branches). The relationKeysAt*
    // counts below are per-relation_key independent clusters — a stricter, DIFFERENT readout that does not
    // correspond to the gate (kept for drill-down; do not read them as "buckets ready").
    bucketsAt20PerBranch: buckets.filter((b) => Math.min(b.samplesFail, b.samplesWin) >= 20).length,
    relationKeysAt20: readinessRows.filter((row) => row.independent_clusters >= 20).length,
    relationKeysAt100: readinessRows.filter((row) => row.independent_clusters >= 100).length,
    relationKeysAt300: readinessRows.filter((row) => row.independent_clusters >= 300).length,
    relationKeysAt500: readinessRows.filter((row) => row.independent_clusters >= 500).length,
  };
  const learnedRules = [...profile.entries()]
    .map(([bucket, s]) => ({
      bucket, pGivenFails: s.pGivenFails, pGivenWins: s.pGivenWins,
      specificity: s.specificity, hedgeSpecificityLower: s.hedgeSpecificityLower,
      samplesFail: s.samplesFail, samplesWin: s.samplesWin,
      // calibrated = the optimizer would actually act on it (≥20 independent episodes per branch); kind labels
      // hedge vs amplifier vs unproven so a sub-gate or amplifier row is never read as an actionable hedge.
      // A coarse fallback rung is NEVER calibrated (pooled-across-roles MODELED shrink prior only); flag it so
      // a reader can't mistake its pooled N for settlement-proven evidence.
      fallbackRung: Boolean(s.fallbackRung),
      calibrated: !s.fallbackRung && Math.min(s.samplesFail, s.samplesWin) >= 20,
      kind: s.hedgeSpecificityLower > 0 ? "hedge" : s.specificity < 0 ? "amplifier" : "unproven",
    }))
    .sort((a, b) => Math.min(b.samplesFail, b.samplesWin) - Math.min(a.samplesFail, a.samplesWin))
    .slice(0, 30);

  // Gold-derived elicitor correction — a MODELED-tier prior adjustment, explicitly NOT settlement
  // calibration and never promotes a tier (empty byMechanismType until the live gold eval populates it).
  const relationCorrection = { ...relationCorrectionSnapshot, tier: "MODELED", isSettlementCalibration: false };

  return NextResponse.json({ overview, backtestEligible, pendingFrozenPairs: pendingFrozen, calibrationReadiness, learnedRules, relationCorrection, llm: { cache: llmCache, runs24h: llmRuns24h, modelTelemetry }, topFrozenRelations });
}
