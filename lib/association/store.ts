import { ensureSchema, getSql } from "@/lib/data/db";
import type { RelationHypothesis } from "./types";
import type { AssociationBacktestRow } from "./backtest";

export interface RelationRecordInput {
  relationKey: string;
  anchorTemplate: string;
  candidateTemplate: string;
  candidateSide: "yes" | "no";
  hypothesis?: RelationHypothesis;
  llmModel?: string;
}

export interface ObservationInput {
  sampleKey: string;
  /** Event-instance cluster used for branch-normalized effective sample weights. */
  clusterKey?: string;
  anchorPays: boolean;
  candidatePays: boolean;
  weight?: number;
  anchorMarketId?: string;
  candidateMarketId?: string;
  resolvedAt?: string;
}

export interface CandidateSnapshotInput {
  relationKey: string;
  observedAt: string;
  anchorMarketId: string;
  candidateMarketId: string;
  candidateSide: "yes" | "no";
  anchorProbYes: number;
  candidatePrice: number;
  classificationMethod: string;
  relationDirection?: string;
  mechanismSignature?: string;
  hypothesis?: RelationHypothesis;
  /** Event/venue refs so settlement can re-fetch this pair's markets by id (decoupled from job config). */
  anchorEventKey?: string;
  anchorVenue?: string;
  candidateEventKey?: string;
  candidateVenue?: string;
  /** Frozen LLM-elicited conditional prior for THIS bought side + the model and its confidence. Captured at
   *  freeze time (leakage-safe); enables later calibration of the elicitor against realized outcomes. */
  pGivenFails?: number;
  pGivenWins?: number;
  elicitorModel?: string;
  priorConfidence?: number;
  /** Frozen combo metadata: anchor-failure scenarioBucket this candidate covers + the orthogonal dimension. */
  scenarioBucket?: string;
  dimension?: string;
  /** Which path froze this row: 'cron-radar' (reproducible enrichment) vs 'live-api' (one-shot). */
  discoverySource?: string;
  /** Book key (PM yes-token id / Kalshi ticker) so the backtest can source the executable ask from book_snapshot. */
  candidateTokenId?: string;
}

/** A frozen pair awaiting settlement: enough to re-fetch both markets and resolve the outcome. */
export interface PendingFrozenPair {
  relationKey: string;
  candidateSide: "yes" | "no";
  anchorMarketId: string;
  anchorEventKey: string;
  anchorVenue: string;
  candidateMarketId: string;
  candidateEventKey: string;
  candidateVenue: string;
}

export interface StoredCandidateSnapshot {
  relationKey: string;
  candidateSide: "yes" | "no";
  observedAt: string;
  hypothesis?: RelationHypothesis;
}

export async function upsertAssociationRelation(input: RelationRecordInput): Promise<boolean> {
  const sql = await getSql();
  if (!sql) return false;
  await ensureSchema(sql);
  await sql`
    INSERT INTO association_relation
      (relation_key, anchor_template, candidate_template, candidate_side, llm_hypothesis, llm_model)
    VALUES
      (${input.relationKey}, ${input.anchorTemplate}, ${input.candidateTemplate}, ${input.candidateSide},
       CAST(${input.hypothesis ? JSON.stringify(input.hypothesis) : null} AS jsonb), ${input.llmModel ?? null})
    ON CONFLICT (relation_key) DO UPDATE SET
      anchor_template = EXCLUDED.anchor_template,
      candidate_template = EXCLUDED.candidate_template,
      candidate_side = EXCLUDED.candidate_side,
      llm_hypothesis = COALESCE(EXCLUDED.llm_hypothesis, association_relation.llm_hypothesis),
      llm_model = COALESCE(EXCLUDED.llm_model, association_relation.llm_model),
      updated_at = now()
  `;
  return true;
}

export async function upsertAssociationObservations(relationKey: string, observations: ObservationInput[]): Promise<number> {
  const sql = await getSql();
  if (!sql || observations.length === 0) return 0;
  await ensureSchema(sql);
  let written = 0;
  for (const o of observations) {
    const rows = await sql`
      INSERT INTO association_observation
        (relation_key, sample_key, cluster_key, anchor_pays, candidate_pays, weight, anchor_market_id, candidate_market_id, resolved_at, candidate_side)
      VALUES
        (${relationKey}, ${o.sampleKey}, ${o.clusterKey ?? null}, ${o.anchorPays}, ${o.candidatePays}, ${o.weight ?? 1},
         ${o.anchorMarketId ?? null}, ${o.candidateMarketId ?? null}, ${o.resolvedAt ?? null},
         (SELECT candidate_side FROM association_relation WHERE relation_key = ${relationKey}))
      ON CONFLICT (relation_key, sample_key) DO UPDATE SET
        cluster_key = EXCLUDED.cluster_key,
        anchor_pays = EXCLUDED.anchor_pays,
        candidate_pays = EXCLUDED.candidate_pays,
        weight = EXCLUDED.weight,
        anchor_market_id = EXCLUDED.anchor_market_id,
        candidate_market_id = EXCLUDED.candidate_market_id,
        resolved_at = EXCLUDED.resolved_at,
        candidate_side = EXCLUDED.candidate_side
      RETURNING sample_key
    `;
    if (rows.length) written++;
  }
  return written;
}

/** Persist the point-in-time candidate set used by discovery. Prices are contemporaneous mids;
 * execution backtests may later replace them with an earlier book_snapshot quote when available. */
export async function upsertAssociationCandidateSnapshots(inputs: CandidateSnapshotInput[]): Promise<number> {
  const sql = await getSql();
  if (!sql || inputs.length === 0) return 0;
  await ensureSchema(sql);
  let written = 0;
  for (const input of inputs) {
    const rows = await sql`
      INSERT INTO association_candidate_snapshot
        (relation_key, observed_at, anchor_market_id, candidate_market_id, candidate_side,
         anchor_prob_yes, candidate_price, classification_method, relation_direction,
         mechanism_signature, hypothesis,
         anchor_event_key, anchor_venue, candidate_event_key, candidate_venue,
         p_given_fails, p_given_wins, elicitor_model, prior_confidence,
         scenario_bucket, dimension, candidate_token_id, discovery_source)
      VALUES
        (${input.relationKey}, ${input.observedAt}, ${input.anchorMarketId}, ${input.candidateMarketId},
         ${input.candidateSide}, ${input.anchorProbYes}, ${input.candidatePrice},
         ${input.classificationMethod}, ${input.relationDirection ?? null},
         ${input.mechanismSignature ?? null},
         CAST(${input.hypothesis ? JSON.stringify(input.hypothesis) : null} AS jsonb),
         ${input.anchorEventKey ?? null}, ${input.anchorVenue ?? null},
         ${input.candidateEventKey ?? null}, ${input.candidateVenue ?? null},
         ${input.pGivenFails ?? null}, ${input.pGivenWins ?? null},
         ${input.elicitorModel ?? null}, ${input.priorConfidence ?? null},
         ${input.scenarioBucket ?? null}, ${input.dimension ?? null}, ${input.candidateTokenId ?? null}, ${input.discoverySource ?? null})
      ON CONFLICT (relation_key, observed_at, anchor_market_id, candidate_market_id, candidate_side)
      DO UPDATE SET
        anchor_prob_yes = EXCLUDED.anchor_prob_yes,
        candidate_price = EXCLUDED.candidate_price,
        classification_method = EXCLUDED.classification_method,
        relation_direction = EXCLUDED.relation_direction,
        mechanism_signature = EXCLUDED.mechanism_signature,
        hypothesis = COALESCE(EXCLUDED.hypothesis, association_candidate_snapshot.hypothesis),
        anchor_event_key = COALESCE(EXCLUDED.anchor_event_key, association_candidate_snapshot.anchor_event_key),
        anchor_venue = COALESCE(EXCLUDED.anchor_venue, association_candidate_snapshot.anchor_venue),
        candidate_event_key = COALESCE(EXCLUDED.candidate_event_key, association_candidate_snapshot.candidate_event_key),
        candidate_venue = COALESCE(EXCLUDED.candidate_venue, association_candidate_snapshot.candidate_venue),
        p_given_fails = COALESCE(EXCLUDED.p_given_fails, association_candidate_snapshot.p_given_fails),
        p_given_wins = COALESCE(EXCLUDED.p_given_wins, association_candidate_snapshot.p_given_wins),
        elicitor_model = COALESCE(EXCLUDED.elicitor_model, association_candidate_snapshot.elicitor_model),
        prior_confidence = COALESCE(EXCLUDED.prior_confidence, association_candidate_snapshot.prior_confidence),
        scenario_bucket = COALESCE(EXCLUDED.scenario_bucket, association_candidate_snapshot.scenario_bucket),
        dimension = COALESCE(EXCLUDED.dimension, association_candidate_snapshot.dimension),
        candidate_token_id = COALESCE(EXCLUDED.candidate_token_id, association_candidate_snapshot.candidate_token_id)
      RETURNING relation_key
    `;
    if (rows.length) written++;
  }
  return written;
}

/** Latest pre-settlement snapshot for each frozen relation/side of one concrete market pair. */
export async function loadCandidateSnapshotsForPair(
  anchorMarketId: string,
  candidateMarketId: string,
  before: string,
): Promise<StoredCandidateSnapshot[]> {
  const sql = await getSql();
  if (!sql) return [];
  await ensureSchema(sql);
  const rows = await sql`
    SELECT DISTINCT ON (relation_key, candidate_side)
      relation_key, candidate_side, observed_at::text, hypothesis
    FROM association_candidate_snapshot
    WHERE anchor_market_id = ${anchorMarketId}
      AND candidate_market_id = ${candidateMarketId}
      AND observed_at < ${before}
    ORDER BY relation_key, candidate_side, observed_at DESC
  ` as Array<{ relation_key: string; candidate_side: "yes" | "no"; observed_at: string; hypothesis: RelationHypothesis | string | null }>;
  return rows.map((row) => ({
    relationKey: row.relation_key,
    candidateSide: row.candidate_side,
    observedAt: row.observed_at,
    hypothesis: typeof row.hypothesis === "string" ? JSON.parse(row.hypothesis) as RelationHypothesis : row.hypothesis ?? undefined,
  }));
}

/**
 * Frozen candidate pairs that (a) carry event/venue refs so settlement can re-fetch them and (b) have
 * NOT yet produced an observation. This is what lets the settle cron drive itself from the snapshot
 * table — it no longer needs the job config to re-enumerate the same candidate universe.
 */
export async function loadPendingFrozenPairs(limit = 1000): Promise<PendingFrozenPair[]> {
  const sql = await getSql();
  if (!sql) return [];
  await ensureSchema(sql);
  const cap = Math.min(20_000, Math.max(1, Math.floor(limit)));
  const rows = await sql`
    SELECT DISTINCT ON (s.relation_key, s.candidate_side, s.anchor_market_id, s.candidate_market_id)
      s.relation_key, s.candidate_side, s.anchor_market_id, s.anchor_event_key, s.anchor_venue,
      s.candidate_market_id, s.candidate_event_key, s.candidate_venue
    FROM association_candidate_snapshot s
    WHERE s.anchor_event_key IS NOT NULL AND s.candidate_event_key IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM association_observation o
        WHERE o.relation_key = s.relation_key
          AND o.anchor_market_id = s.anchor_market_id
          AND o.candidate_market_id = s.candidate_market_id
          -- side-explicit so a future relation_key/side change can't drop one side; legacy NULL rows match either
          AND (o.candidate_side IS NULL OR o.candidate_side = s.candidate_side))
    ORDER BY s.relation_key, s.candidate_side, s.anchor_market_id, s.candidate_market_id, s.observed_at ASC
    LIMIT ${cap}
  ` as Array<{
    relation_key: string; candidate_side: "yes" | "no"; anchor_market_id: string; anchor_event_key: string;
    anchor_venue: string; candidate_market_id: string; candidate_event_key: string; candidate_venue: string;
  }>;
  return rows.map((r) => ({
    relationKey: r.relation_key,
    candidateSide: r.candidate_side,
    anchorMarketId: r.anchor_market_id,
    anchorEventKey: r.anchor_event_key,
    anchorVenue: r.anchor_venue,
    candidateMarketId: r.candidate_market_id,
    candidateEventKey: r.candidate_event_key,
    candidateVenue: r.candidate_venue,
  }));
}

/** One (relation_key, episode-cluster, anchor-branch) group with its candidate-pay tally. This is the raw
 *  material for CLUSTER-DEDUPLICATED bucket calibration: a 1/branch_size normalization INSIDE a single
 *  relation_key cannot dedup an episode that appears under SEVERAL relation_keys mapping to the same coarse
 *  bucket, so the cluster identity is preserved here and re-normalized by (bucket, cluster) downstream
 *  (lib/relate/tuningProfile.ts aggregateBucketsByCluster). */
export interface BucketBranchRow { relationKey: string; cluster: string; anchorPays: boolean; pay: number; total: number }

/** Per (relation_key, episode-cluster, anchor-branch) candidate-pay tallies. Empty without a DB. */
export async function loadBucketBranchRows(minLeadHours = 24): Promise<BucketBranchRow[]> {
  const sql = await getSql();
  if (!sql) return [];
  await ensureSchema(sql);
  const lead = Math.min(24 * 365, Math.max(0, Number(minLeadHours) || 0));
  // HONESTY GATE (mirror of loadAssociationBacktestRows): the LIVE tuning profile / CALIBRATED promotion may
  // only read observations that had a candidate snapshot FROZEN at least `minLeadHours` (default 24h) BEFORE
  // resolution — the SAME lead the backtest requires. Without it a settle-time-constructed pair (no snapshot)
  // OR one frozen minutes before settlement (near-zero look-ahead protection) could leak into served
  // calibration. Live is now a strict SUBSET of the backtest's frozen evidence. Same join keys + lead.
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
          AND s.observed_at <= o.resolved_at - (${lead} * interval '1 hour')
      )
    GROUP BY o.relation_key, COALESCE(o.cluster_key, o.sample_key), o.anchor_pays
  ` as Array<{ relationKey: string; cluster: string; anchorPays: boolean; pay: number; total: number }>;
  return rows.map((r) => ({ relationKey: r.relationKey, cluster: r.cluster, anchorPays: r.anchorPays, pay: Number(r.pay), total: Number(r.total) }));
}

/** Load only observations that had a matching candidate snapshot before resolution. */
export async function loadAssociationBacktestRows(
  minLeadHours = 24,
  maxRows = 10_000,
): Promise<AssociationBacktestRow[]> {
  const sql = await getSql();
  if (!sql) return [];
  await ensureSchema(sql);
  const lead = Math.min(24 * 365, Math.max(0, Number(minLeadHours) || 0));
  const limit = Math.min(100_000, Math.max(1, Math.floor(maxRows)));
  const rows = await sql`
    SELECT DISTINCT ON (o.relation_key, o.sample_key)
      o.relation_key,
      o.sample_key,
      COALESCE(o.cluster_key, o.sample_key) AS cluster_key,
      o.anchor_pays,
      o.candidate_pays,
      o.resolved_at::text,
      s.observed_at::text,
      -- EXECUTION-GRADE price (#3): the candidate's executable ASK from the frozen book at observed_at
      -- (side-adjusted: YES ask, or 1 − YES bid for the NO side), falling back to the de-vigged mid when no
      -- book exists or the ask is out of (0,1). Leakage-safe — the book row predates resolution by construction.
      COALESCE(
        CASE
          WHEN s.candidate_side = 'yes' AND b.best_ask > 0 AND b.best_ask < 1 THEN b.best_ask
          WHEN s.candidate_side = 'no'  AND (1 - b.best_bid) > 0 AND (1 - b.best_bid) < 1 THEN 1 - b.best_bid
          ELSE NULL
        END,
        s.candidate_price
      )::float8 AS candidate_price
    FROM association_observation o
    JOIN association_candidate_snapshot s
      ON s.relation_key = o.relation_key
     AND s.anchor_market_id = o.anchor_market_id
     AND s.candidate_market_id = o.candidate_market_id
     AND s.observed_at <= o.resolved_at - (${lead} * interval '1 hour')
    LEFT JOIN LATERAL (
      SELECT bs.best_bid, bs.best_ask FROM book_snapshot bs
      WHERE bs.token_id = s.candidate_token_id AND bs.ts <= s.observed_at
      ORDER BY bs.ts DESC LIMIT 1
    ) b ON true
    WHERE o.resolved_at IS NOT NULL
    ORDER BY o.relation_key, o.sample_key, s.observed_at DESC
    LIMIT ${limit}
  ` as Array<{
    relation_key: string; sample_key: string; cluster_key: string; anchor_pays: boolean;
    candidate_pays: boolean; resolved_at: string; observed_at: string; candidate_price: number;
  }>;
  return rows.map((row) => ({
    relationKey: row.relation_key,
    sampleKey: row.sample_key,
    clusterKey: row.cluster_key,
    anchorPays: Boolean(row.anchor_pays),
    candidatePays: Boolean(row.candidate_pays),
    resolvedAt: row.resolved_at,
    observedAt: row.observed_at,
    candidatePrice: Number(row.candidate_price),
  }));
}
