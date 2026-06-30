import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { getSql } from "@/lib/data/db";
import { loadAssociationBacktestRows } from "@/lib/association";

try { for (const l of readFileSync(".env.local", "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && m[2].trim() && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); } } catch {}

const PFX = "TESTEXEC-" + Math.floor(Date.now() % 1e7);
const KEY = `${PFX}-k`;
const TOKEN = `${PFX}-TOK`;

describe.skipIf(!process.env.DATABASE_URL)("backtest execution-grade price (#3)", () => {
  afterAll(async () => {
    const sql = await getSql(); if (!sql) return;
    await sql`DELETE FROM association_observation WHERE relation_key LIKE ${PFX + "%"}`;
    await sql`DELETE FROM association_candidate_snapshot WHERE relation_key LIKE ${PFX + "%"}`;
    await sql`DELETE FROM association_relation WHERE relation_key LIKE ${PFX + "%"}`;
    await sql`DELETE FROM book_snapshot WHERE token_id = ${TOKEN}`;
  });

  it("uses the executable ASK from the frozen book at observed_at, not the de-vigged mid", async () => {
    const sql = await getSql(); if (!sql) return;
    await sql`INSERT INTO association_relation (relation_key, anchor_template, candidate_template, candidate_side)
              VALUES (${KEY}, 'a', 'b', 'yes') ON CONFLICT (relation_key) DO NOTHING`;
    await sql`INSERT INTO association_observation (relation_key, sample_key, cluster_key, anchor_pays, candidate_pays, anchor_market_id, candidate_market_id, resolved_at)
              VALUES (${KEY}, ${KEY + "-s1"}, ${KEY + "-c1"}, false, true, 'AM', 'CM', '2026-03-01T00:00:00Z')
              ON CONFLICT (relation_key, sample_key) DO NOTHING`;
    // snapshot: frozen MID = 0.30, but it carries the book token; observed 28d before resolution (lead ok)
    await sql`INSERT INTO association_candidate_snapshot (relation_key, observed_at, anchor_market_id, candidate_market_id, candidate_side, anchor_prob_yes, candidate_price, classification_method, candidate_token_id)
              VALUES (${KEY}, '2026-02-01T00:00:00Z', 'AM', 'CM', 'yes', 0.5, 0.30, 'rule', ${TOKEN})
              ON CONFLICT (relation_key, observed_at, anchor_market_id, candidate_market_id, candidate_side) DO NOTHING`;
    // frozen book BEFORE observed_at: executable YES ask = 0.45 (> the 0.30 mid — the spread/vig you really pay)
    await sql`INSERT INTO book_snapshot (token_id, ts, best_bid, best_ask, midpoint, spread, source)
              VALUES (${TOKEN}, '2026-01-15T00:00:00Z', 0.40, 0.45, 0.425, 0.05, 'test')
              ON CONFLICT (token_id, ts) DO NOTHING`;

    const rows = await loadAssociationBacktestRows(24, 100_000);
    const row = rows.find((r) => r.relationKey === KEY);
    expect(row).toBeDefined();
    expect(row!.candidatePrice).toBeCloseTo(0.45, 5); // executable ASK, NOT the 0.30 mid
  });
});
