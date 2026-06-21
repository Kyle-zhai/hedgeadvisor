import { ensureSchema, getSql } from "@/lib/data/db";
import type { ConditionalCounts, RelationHypothesis } from "./types";
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
        (relation_key, sample_key, cluster_key, anchor_pays, candidate_pays, weight, anchor_market_id, candidate_market_id, resolved_at)
      VALUES
        (${relationKey}, ${o.sampleKey}, ${o.clusterKey ?? null}, ${o.anchorPays}, ${o.candidatePays}, ${o.weight ?? 1},
         ${o.anchorMarketId ?? null}, ${o.candidateMarketId ?? null}, ${o.resolvedAt ?? null})
      ON CONFLICT (relation_key, sample_key) DO UPDATE SET
        cluster_key = EXCLUDED.cluster_key,
        anchor_pays = EXCLUDED.anchor_pays,
        candidate_pays = EXCLUDED.candidate_pays,
        weight = EXCLUDED.weight,
        anchor_market_id = EXCLUDED.anchor_market_id,
        candidate_market_id = EXCLUDED.candidate_market_id,
        resolved_at = EXCLUDED.resolved_at
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
         anchor_event_key, anchor_venue, candidate_event_key, candidate_venue)
      VALUES
        (${input.relationKey}, ${input.observedAt}, ${input.anchorMarketId}, ${input.candidateMarketId},
         ${input.candidateSide}, ${input.anchorProbYes}, ${input.candidatePrice},
         ${input.classificationMethod}, ${input.relationDirection ?? null},
         ${input.mechanismSignature ?? null},
         CAST(${input.hypothesis ? JSON.stringify(input.hypothesis) : null} AS jsonb),
         ${input.anchorEventKey ?? null}, ${input.anchorVenue ?? null},
         ${input.candidateEventKey ?? null}, ${input.candidateVenue ?? null})
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
        candidate_venue = COALESCE(EXCLUDED.candidate_venue, association_candidate_snapshot.candidate_venue)
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
          AND o.candidate_market_id = s.candidate_market_id)
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

export async function loadConditionalCounts(relationKey: string): Promise<ConditionalCounts | null> {
  const sql = await getSql();
  if (!sql) return null;
  await ensureSchema(sql);
  // Re-normalize at READ time over the complete stored cluster. This stays correct when a cron sees
  // a settlement incrementally: old rows do not retain stale 1/N weights after new rows arrive.
  const rows = await sql`
    WITH base AS (
      SELECT *,
        COALESCE(cluster_key, sample_key) AS effective_cluster,
        count(*) OVER (
          PARTITION BY relation_key, COALESCE(cluster_key, sample_key), anchor_pays
        )::float8 AS branch_size
      FROM association_observation
      WHERE relation_key = ${relationKey}
    ), normalized AS (
      SELECT *, CASE WHEN branch_size > 0 THEN 1.0 / branch_size ELSE 0 END AS normalized_weight
      FROM base
    )
    SELECT
      COALESCE(sum(normalized_weight) FILTER (WHERE anchor_pays AND candidate_pays), 0)::float8 AS app,
      COALESCE(sum(normalized_weight) FILTER (WHERE anchor_pays AND NOT candidate_pays), 0)::float8 AS apn,
      COALESCE(sum(normalized_weight) FILTER (WHERE NOT anchor_pays AND candidate_pays), 0)::float8 AS anp,
      COALESCE(sum(normalized_weight) FILTER (WHERE NOT anchor_pays AND NOT candidate_pays), 0)::float8 AS ann
    FROM normalized
  ` as Array<{ app: number; apn: number; anp: number; ann: number }>;
  const row = rows[0];
  if (!row) return null;
  return {
    anchorPayCandidatePay: Number(row.app),
    anchorPayCandidateNoPay: Number(row.apn),
    anchorNoPayCandidatePay: Number(row.anp),
    anchorNoPayCandidateNoPay: Number(row.ann),
  };
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
      s.candidate_price::float8
    FROM association_observation o
    JOIN association_candidate_snapshot s
      ON s.relation_key = o.relation_key
     AND s.anchor_market_id = o.anchor_market_id
     AND s.candidate_market_id = o.candidate_market_id
     AND s.observed_at <= o.resolved_at - (${lead} * interval '1 hour')
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
