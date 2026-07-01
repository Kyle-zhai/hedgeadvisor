/**
 * lib/data/db.ts — OPTIONAL Postgres layer (the proprietary-history moat).
 *
 * The app runs fully WITHOUT a database (everything is on-demand). If DATABASE_URL
 * is set, the cron snapshotter persists fine-grained price/depth series that decay
 * to 12h granularity once a market resolves — capture-or-lose-it, hence the moat.
 *
 * `postgres` is an optionalDependency and imported lazily so the build never fails
 * when it's absent.
 */

/** Minimal structural type for the `postgres` tagged-template client we actually use. */
export type Sql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  /** Parameterized raw query (postgres.js): values are bound as $1..$n, never string-interpolated. */
  unsafe: (query: string, params?: unknown[]) => Promise<unknown[]>;
};

let _sql: Sql | null = null;
let _sqlPromise: Promise<Sql | null> | null = null;
let _schemaEnsured = false;
let _schemaPromise: Promise<void> | null = null;

export function dbEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/** Returns a tagged-template sql client, or null if no DB configured/available. */
export async function getSql(): Promise<Sql | null> {
  if (!dbEnabled()) return null;
  if (_sql) return _sql;
  if (_sqlPromise) return _sqlPromise;
  _sqlPromise = (async () => {
    try {
      const mod = await import("postgres");
      const postgres = (mod as { default: (url: string, opts?: unknown) => unknown }).default;
      // `postgres` ships loose types; cast once here at the boundary to our minimal Sql shape.
      _sql = postgres(process.env.DATABASE_URL as string, { max: 3, idle_timeout: 20 }) as unknown as Sql;
      return _sql;
    } catch {
      return null;
    }
  })();
  return _sqlPromise;
}

/** Run the schema DDL at most once per process (idempotent + avoids per-minute churn). */
export async function ensureSchema(sql: Sql): Promise<void> {
  if (_schemaEnsured) return;
  if (_schemaPromise) return _schemaPromise;
  _schemaPromise = (async () => {
    await sql.unsafe(SCHEMA_SQL);
    // Trigram GIN indexes make queryMarketIndex's `ILIKE '%tok%'` / `~*` recall index-backed instead of a
    // full seq scan of the whole open-market catalog (the catalog is DESIGNED to grow, so the scan cost is
    // unbounded without this). Separate fail-safe block: CREATE EXTENSION needs owner rights on some hosts,
    // and a locked-down DB must not break the rest of the schema — recall then just stays a seq scan.
    await sql.unsafe(TRGM_SQL).catch(() => {});
    _schemaEnsured = true;
  })().finally(() => {
    if (!_schemaEnsured) _schemaPromise = null;
  });
  return _schemaPromise;
}

export const TRGM_SQL = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS market_index_title_trgm_idx ON market_index USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS market_index_mtitle_trgm_idx ON market_index USING GIN (market_title gin_trgm_ops);
`;

export const SCHEMA_SQL = `
-- Catalog (working index keyed to Polymarket ids; refreshed on demand, not mirrored).
CREATE TABLE IF NOT EXISTS event (
  event_id text PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  title text NOT NULL,
  neg_risk boolean NOT NULL DEFAULT false,
  neg_risk_market_id text,
  tags text[],
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS market (
  condition_id text PRIMARY KEY,
  event_id text REFERENCES event(event_id),
  question text NOT NULL,
  group_item_title text,
  yes_token_id text NOT NULL,
  no_token_id text NOT NULL,
  neg_risk_market_id text,
  fee_rate numeric, fee_exponent numeric, fee_taker_only boolean,
  resolved boolean DEFAULT false,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_negrisk_idx ON market (neg_risk_market_id);

-- The proprietary time series (the moat).
CREATE TABLE IF NOT EXISTS book_snapshot (
  token_id text NOT NULL,
  ts timestamptz NOT NULL,
  best_bid numeric, best_ask numeric, midpoint numeric, spread numeric,
  ask_depth_1pct numeric, bid_depth_1pct numeric,
  source text NOT NULL,
  PRIMARY KEY (token_id, ts)
);

-- Cross-market soft-association calibration. A relation_key groups comparable historical pairs
-- (for example champion-result -> broadcast-word-NO); sample_key prevents repeated ingestion.
-- LLM hypotheses are stored for audit, never as probabilities or trade authorization.
CREATE TABLE IF NOT EXISTS association_relation (
  relation_key text PRIMARY KEY,
  anchor_template text NOT NULL,
  candidate_template text NOT NULL,
  candidate_side text NOT NULL CHECK (candidate_side IN ('yes', 'no')),
  llm_hypothesis jsonb,
  llm_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS association_observation (
  relation_key text NOT NULL REFERENCES association_relation(relation_key) ON DELETE CASCADE,
  sample_key text NOT NULL,
  cluster_key text,
  anchor_pays boolean NOT NULL,
  candidate_pays boolean NOT NULL,
  weight numeric NOT NULL DEFAULT 1 CHECK (weight > 0),
  anchor_market_id text,
  candidate_market_id text,
  resolved_at timestamptz,
  PRIMARY KEY (relation_key, sample_key)
);
ALTER TABLE association_observation ADD COLUMN IF NOT EXISTS cluster_key text;
-- Explicit settled SIDE (yes/no) of the candidate. Today the side is already encoded in relation_key (YES and
-- NO are distinct keys), so this is belt-and-suspenders: it lets the pending-pairs dedup match on side directly,
-- so a future relation_key/side structure change can never silently drop one side's settlement. Nullable —
-- legacy rows (written before this column) stay NULL and are matched leniently.
ALTER TABLE association_observation ADD COLUMN IF NOT EXISTS candidate_side text;
CREATE INDEX IF NOT EXISTS association_observation_relation_idx
  ON association_observation (relation_key);
CREATE INDEX IF NOT EXISTS association_observation_cluster_idx
  ON association_observation (relation_key, cluster_key, anchor_pays);

-- Point-in-time candidate set. A row proves that this relation was discovered BEFORE settlement;
-- backtests must join through this table rather than retrospectively cherry-picking resolved pairs.
CREATE TABLE IF NOT EXISTS association_candidate_snapshot (
  relation_key text NOT NULL,
  observed_at timestamptz NOT NULL,
  anchor_market_id text NOT NULL,
  candidate_market_id text NOT NULL,
  candidate_side text NOT NULL CHECK (candidate_side IN ('yes', 'no')),
  anchor_prob_yes numeric NOT NULL CHECK (anchor_prob_yes >= 0 AND anchor_prob_yes <= 1),
  candidate_price numeric NOT NULL CHECK (candidate_price > 0 AND candidate_price < 1),
  classification_method text NOT NULL,
  relation_direction text,
  mechanism_signature text,
  hypothesis jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (relation_key, observed_at, anchor_market_id, candidate_market_id, candidate_side)
);
CREATE INDEX IF NOT EXISTS association_candidate_snapshot_lookup_idx
  ON association_candidate_snapshot (relation_key, anchor_market_id, candidate_market_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS association_observation_resolved_idx
  ON association_observation (resolved_at, relation_key);
-- Event/venue refs let the settle cron re-fetch a frozen pair's markets by id WITHOUT the job config
-- having to re-enumerate the same candidate universe (decouples discovery from settlement sweep).
ALTER TABLE association_candidate_snapshot ADD COLUMN IF NOT EXISTS anchor_event_key text;
ALTER TABLE association_candidate_snapshot ADD COLUMN IF NOT EXISTS anchor_venue text;
ALTER TABLE association_candidate_snapshot ADD COLUMN IF NOT EXISTS candidate_event_key text;
ALTER TABLE association_candidate_snapshot ADD COLUMN IF NOT EXISTS candidate_venue text;
-- Frozen LLM-elicited conditional prior for the bought side (P(side pays | anchor fails/wins)) + the
-- model and its self-reported confidence. Captured at FREEZE time so it predates settlement (leakage-safe);
-- joining it to the realized association_observation later yields a calibration of the ELICITOR itself
-- (how well its MODELED prior predicts outcomes), which accrues per-pair every freeze. Nullable: pre-existing
-- rows and non-elicited (structural/auto-backfill) pairs have none.
ALTER TABLE association_candidate_snapshot ADD COLUMN IF NOT EXISTS p_given_fails double precision;
ALTER TABLE association_candidate_snapshot ADD COLUMN IF NOT EXISTS p_given_wins double precision;
-- §19 whole-anchor enrichment provenance: which path produced this frozen row — the reproducible
-- cron radar ('cron-radar') or a one-shot interactive query ('live-api') — so the moat can distinguish
-- replayable evidence from live rows (the §18 auditability gap).
ALTER TABLE association_candidate_snapshot ADD COLUMN IF NOT EXISTS discovery_source text;
ALTER TABLE association_candidate_snapshot ADD COLUMN IF NOT EXISTS elicitor_model text;
ALTER TABLE association_candidate_snapshot ADD COLUMN IF NOT EXISTS prior_confidence double precision;
-- Frozen combo metadata: scenario_bucket = which anchor-FAILURE PATH this candidate covers (the overlap key
-- for Phase 2/3 joint-combo calibration); dimension = the orthogonal facet. Frozen here so future pairwise-
-- overlap / joint-combo backtests have the failure-path dimension on HISTORICAL evidence. Nullable (pre-existing
-- + structural auto-backfill rows have none). association_group is a combo-LEG concept → added with the
-- combo-snapshot tables later, not here.
ALTER TABLE association_candidate_snapshot ADD COLUMN IF NOT EXISTS scenario_bucket text;
ALTER TABLE association_candidate_snapshot ADD COLUMN IF NOT EXISTS dimension text;
-- The candidate's BOOK KEY (PM yes-token id / Kalshi ticker) so the walk-forward backtest can source the
-- EXECUTABLE ask from book_snapshot at observed_at instead of the frozen de-vigged mid. Nullable (pre-existing
-- rows have none ⇒ those fall back to the mid). Frozen at capture time, leakage-safe.
ALTER TABLE association_candidate_snapshot ADD COLUMN IF NOT EXISTS candidate_token_id text;

-- Persistent LLM cache survives stateless GitHub Action/server restarts. Inputs are SHA-256 keys;
-- prompts and API credentials are never stored. The run table measures latency/fallback/cache health.
CREATE TABLE IF NOT EXISTS llm_relation_cache (
  cache_key text PRIMARY KEY,
  operation text NOT NULL,
  payload jsonb NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  last_hit_at timestamptz
);
CREATE INDEX IF NOT EXISTS llm_relation_cache_expiry_idx ON llm_relation_cache (expires_at);
CREATE TABLE IF NOT EXISTS llm_relation_run (
  id bigserial PRIMARY KEY,
  operation text NOT NULL,
  cache_hit boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('ok', 'error', 'disabled')),
  model text,
  attempts jsonb,
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llm_relation_run_created_idx ON llm_relation_run (created_at DESC);

-- Full-market index (#2 first slice): a continuously-refreshed catalog of OPEN markets across both venues,
-- so relation discovery can later recall candidates from the WHOLE universe instead of a fixed top-N sample.
-- Open markets only — this never holds settlement evidence; PK (venue, market_id), last_seen tracks freshness.
CREATE TABLE IF NOT EXISTS market_index (
  venue text NOT NULL,
  market_id text NOT NULL,
  event_key text NOT NULL,
  title text,
  market_title text,
  category text,
  status text,
  last_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue, market_id)
);
CREATE INDEX IF NOT EXISTS market_index_event_idx ON market_index (venue, event_key);
CREATE INDEX IF NOT EXISTS market_index_seen_idx ON market_index (last_seen DESC);

-- Block C joint-combo pipeline: FROZEN multi-leg combos the engine recommends, settled later against real
-- outcomes to feed backtestCombos + the JOINT-CALIBRATED gate. observed_at is the freeze time (must precede
-- anchor resolution = walk-forward); resolution columns are filled by settleComboSnapshots only when the anchor
-- AND every leg have settled. cluster_key (= anchor market) dedups re-freezes of the same episode. Open markets
-- only at freeze; LLM never writes a settled outcome.
CREATE TABLE IF NOT EXISTS combo_snapshot (
  combo_id text PRIMARY KEY,
  anchor_market_id text NOT NULL,
  anchor_venue text NOT NULL,
  anchor_event_key text NOT NULL,
  observed_at timestamptz NOT NULL,
  predicted_coverage_lower double precision NOT NULL,
  premium_usd double precision NOT NULL,
  tier text NOT NULL,
  cluster_key text NOT NULL,
  anchor_resolved_at timestamptz,
  anchor_pays boolean,
  combo_payoff_usd double precision,
  settled_at timestamptz
);
CREATE INDEX IF NOT EXISTS combo_snapshot_pending_idx ON combo_snapshot (anchor_resolved_at) WHERE anchor_resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS combo_snapshot_cluster_idx ON combo_snapshot (cluster_key);
CREATE TABLE IF NOT EXISTS combo_leg_snapshot (
  combo_id text NOT NULL,
  rank int NOT NULL,
  market_id text NOT NULL,
  venue text NOT NULL,
  event_key text NOT NULL,
  side text NOT NULL,
  leg_price double precision NOT NULL,
  cost_usd double precision NOT NULL,
  scenario_bucket text NOT NULL,
  paid boolean,
  PRIMARY KEY (combo_id, rank)
);
`;
