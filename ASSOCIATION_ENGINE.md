# Hybrid association engine

The association engine extends the existing structural hedge path without weakening it. It is not
limited to win/loss, team/player, or broadcast-word patterns: those are examples of a general
mechanism-classification and settlement-calibration pipeline.

## General mechanism layer

For every recalled pair Qwen must return an auditable directed `mechanismGraph` with:

- entity/date-free anchor and candidate event classes;
- mechanism type (`CAUSAL`, `BEHAVIORAL`, `ECONOMIC`, `INFORMATION`, `COMMON_CAUSE`, etc.);
- scope (`SAME_ENTITY`, `ENTITY_SPECIFIC`, `EVENT_GLOBAL`, `CROSS_ENTITY`, or `CROSS_DOMAIN`);
- time order and portability; and
- nodes, directed edges, shared drivers, and counterexamples.

The graph may describe relationships such as an election outcome and regulation, a product launch
and supplier demand, a team result and media language, or a policy decision and an economic
threshold. Free-form labels never become evidence. Stable enum fields plus the two event classes
form the calibration cohort key, and `INSTANCE_ONLY` graphs are never pooled.

Calibration keys use the controlled v5 ontology. Known synonyms map to one canonical event class;
unknown classes are quarantined under a stable hashed `other_event_*` key instead of sharing a giant
catch-all cohort. The key also includes payoff direction, mechanism edge kinds, the actual settlement
predicate, scope, time order, and candidate side. Existing v4 rows stay stored but cannot mix into v5.

Discovery indexes configured events plus broad open-event pools from both venues. Qwen embeddings
are recall-only: they surface pairs with little lexical overlap, while the relation model explains
the possible mechanism. Neither output can make a trade actionable.

## Trust boundary

1. Qwen reads full resolution rules and returns a structured relationship hypothesis plus
   counterexamples. It cannot set a correlation, probability, position size, or analytic flag.
2. Settled paired observations are calibrated with independent Jeffreys beta-binomial posteriors for
   `P(candidate pays | anchor pays)` and `P(candidate pays | anchor fails)`.
3. The optimizer moves from posterior means toward credible-interval worst bounds as conservatism
   rises. Uncalibrated hypotheses are rejected. The strictest posture accepts structural coverage only.
4. Model-based conditional loss and strict adversarial max loss are always separate outputs. A soft
   leg may reduce calibrated expected loss while increasing strict worst-case loss by its premium.

## Configuration

Qwen is optional and disabled safely when the key is empty:

```env
DASHSCOPE_API_KEY=
QWEN_RELATION_MODEL=qwen-plus
QWEN_EMBED_MODEL=text-embedding-v4
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
HEDGE_RELATE_PM_TOP_EVENTS=24
HEDGE_RELATE_KALSHI_TOP_EVENTS=24
```

Historical mechanism calibration is enabled per settlement job. `anchorEntities` can restrict an
expensive Qwen backfill to selected anchor outcomes; omit it to process all resolved outcomes.

```env
HEDGE_SETTLE_JOBS_JSON=[{"cluster":"event-2026","category":"sports","anchorSlug":"anchor-event","anchorEntities":["Entity A"],"candidateSlugs":["candidate-event"],"kalshiSeries":["KXSERIES"],"kalshiEventTickers":[],"llmMechanisms":true,"maxLlmPairs":40}]
```

## Point-in-time collection and walk-forward backtest

`association_candidate_snapshot` records the candidate, mechanism graph, side, and contemporaneous
price when discovery runs. This is the anti-leakage gate: a resolved observation is eligible for
backtesting only when the exact relation and market pair had a snapshot before resolution. Normal
`/api/discover` requests save these rows automatically when `DATABASE_URL` is configured.

For continuous collection, configure a small list of anchor jobs. `/api/cron/relations` runs them
four times per hour through `vercel.json`; an empty list is a safe no-op.

```env
DATABASE_URL=postgres://user:pass@host/db
CRON_SECRET=replace-with-a-long-random-secret
HEDGE_RELATION_SNAPSHOT_JOBS_JSON=[{"query":"selected outcome","eventSlug":"event-slug","topK":4}]
```

The protected read-only endpoint `/api/backtest/association` performs a strict walk-forward test.
For each test settlement, training rows must have resolved earlier and belong to different event
clusters. By default, the candidate snapshot must lead settlement by at least 24 hours and each
anchor branch needs 20 effective independent samples before a hedge is actionable.

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "http://localhost:3000/api/backtest/association?minLeadHours=24&minSamplesPerBranch=20"
```

The report includes Brier score, log loss, ECE, actionable coverage, average loss reduction when the
anchor fails, hedge drag when it wins, and an explicit leakage-violation count. Candidate prices are
currently point-in-time mids; execution-grade backtests should next join the nearest earlier order
book snapshot for spread, fees, depth, and slippage.

### Historical backfill

`POST /api/association/historical` accepts CRON-secret-gated archived pairs. Every row must carry a
real pre-resolution `observedAt`, actual `resolvedAt`, historical anchor probability, and historical
candidate price. Rows inside the configured lead window (24h by default), rows without stable market
ids, and duplicates are rejected. The endpoint writes both the archived snapshot and settlement, so
the normal walk-forward join remains the only evaluation path. It also reports a chronological,
cluster-disjoint train/holdout split. Missing historical timestamps or prices must never be replaced
with today's values.

The automated provider adapter is `GET /api/cron/historical`. It reads a predeclared job manifest,
fetches settled outcomes plus historical YES prices from Polymarket or Kalshi, selects the last price
at or before the lead-time cutoff, and writes the v5 snapshot and observation idempotently. It is
manual-only in GitHub Actions because archived data does not change.

```env
HEDGE_HISTORICAL_BACKFILL_JOBS_JSON=[{"id":"event-a-pair-1","clusterKey":"event-a","anchor":{"venue":"polymarket","eventKey":"resolved-anchor-event","label":"Anchor outcome"},"candidate":{"venue":"kalshi","eventKey":"KXRESOLVED-EVENT","marketId":"KXRESOLVED-EVENT-MARKET"},"relation":{"anchorFamily":"election_outcome","candidateFamily":"policy_decision","predicate":"policy_passes","role":"cross_domain","side":"yes","mechanismSignature":"institutional.cross_domain.anchor_before_candidate.event_class.positive.edges=causes","relationDirection":"POSITIVE"},"leadHours":168}]
```

Prefer native `marketId` values over labels. Each `clusterKey` must identify one independent real-world
event. Configure the manifest before running the manual GitHub Action; do not generate it from winners.

## API

Production recommendations use `POST /api/discover`: structural coverage is created only by
deterministic code, while calibrated counts are loaded from the secret-gated settlement store. Qwen
hypotheses remain unsized. Resolved samples enter through `/api/cron/settle`, the protected
`/api/association/observe` endpoint, or the stricter archived-data endpoint above.

```json
{
  "anchor": { "title": "Spain wins the World Cup", "rules": "Pays if Spain is champion." },
  "stakeUsd": 20,
  "primaryPrice": 0.25,
  "keepFraction": 0.5,
  "conservatism": 0.8,
  "candidates": [{
    "id": "broadcast-champion-no",
    "label": "Announcer does not say champion",
    "venue": "kalshi",
    "side": "no",
    "price": 0.45,
    "market": { "title": "Will the announcer say champion?", "rules": "Official Kalshi rules..." }
  }]
}
```

Trusted counts are accumulated in `association_observation`, keyed by a reusable mechanism cohort.
Duplicate historical samples are rejected by the `(relation_key, sample_key)` primary key; each
event-instance/anchor-branch is normalized at read time so incremental cron ingestion cannot leave
stale weights. Both candidate YES and NO are calibrated independently. A soft hedge becomes
actionable only after both anchor branches meet the minimum effective sample requirement and the
credible intervals show conservative hedge specificity.
