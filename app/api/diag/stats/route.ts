/**
 * app/api/diag/stats/route.ts — secret-gated read-only view of accumulated data across the moat tables.
 * Shows the closed-loop's progress: price snapshots, frozen candidate pairs (pre-settlement),
 * settled observations, and how many are backtest-eligible (leakage-safe).
 */
import { NextResponse } from "next/server";
import { getSql, dbEnabled, ensureSchema } from "@/lib/data/db";

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
           count(*) FILTER (WHERE jsonb_array_length(COALESCE(attempts, '[]'::jsonb)) > 1)::int AS fallback_runs
    FROM llm_relation_run
    WHERE created_at >= now() - interval '24 hours'
    GROUP BY operation, model, status, cache_hit
    ORDER BY operation, runs DESC
  `;
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
  const calibrationReadiness = {
    independentClusters: n,
    phase: n >= 500 ? "stable_optimization" : n >= 300 ? "strong_calibration" : n >= 100 ? "initial_recalibration" : "collecting",
    nextMilestone: n < 100 ? 100 : n < 300 ? 300 : n < 500 ? 500 : n < 1000 ? 1000 : null,
    remaining: n < 100 ? 100 - n : n < 300 ? 300 - n : n < 500 ? 500 - n : n < 1000 ? 1000 - n : 0,
    relationKeysAt20: readinessRows.filter((row) => row.independent_clusters >= 20).length,
    relationKeysAt100: readinessRows.filter((row) => row.independent_clusters >= 100).length,
    relationKeysAt300: readinessRows.filter((row) => row.independent_clusters >= 300).length,
    relationKeysAt500: readinessRows.filter((row) => row.independent_clusters >= 500).length,
  };

  return NextResponse.json({ overview, backtestEligible, pendingFrozenPairs: pendingFrozen, calibrationReadiness, llm: { cache: llmCache, runs24h: llmRuns24h }, topFrozenRelations });
}
