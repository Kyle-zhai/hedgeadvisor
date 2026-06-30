import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { getSql } from "@/lib/data/db";
import { loadBucketBranchRows } from "@/lib/association/store";

// Load .env.local so DATABASE_URL is present locally (CI sets it directly). Gated test: no DB ⇒ skipped.
try {
  for (const l of readFileSync(".env.local", "utf8").split("\n")) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[2].trim() && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch { /* no .env.local */ }

const PFX = "TESTFREEZE-" + Math.floor(Date.now() % 1e7);
const KEY_FROZEN = `${PFX}-frozen`; // has a pre-resolution snapshot ⇒ MUST appear in the tuning profile
const KEY_NAKED = `${PFX}-naked`;   // observation only, no snapshot ⇒ MUST be excluded (the fix)

describe.skipIf(!process.env.DATABASE_URL)("tuning profile freeze-gate (#1)", () => {
  afterAll(async () => {
    const sql = await getSql();
    if (!sql) return;
    await sql`DELETE FROM association_observation WHERE relation_key LIKE ${PFX + "%"}`;
    await sql`DELETE FROM association_candidate_snapshot WHERE relation_key LIKE ${PFX + "%"}`;
    await sql`DELETE FROM association_relation WHERE relation_key LIKE ${PFX + "%"}`;
  });

  it("excludes observations with no pre-resolution snapshot from the live tuning profile", async () => {
    const sql = await getSql();
    if (!sql) return;
    for (const k of [KEY_FROZEN, KEY_NAKED]) {
      await sql`INSERT INTO association_relation (relation_key, anchor_template, candidate_template, candidate_side)
                VALUES (${k}, 'a', 'b', 'yes') ON CONFLICT (relation_key) DO NOTHING`;
      await sql`INSERT INTO association_observation (relation_key, sample_key, cluster_key, anchor_pays, candidate_pays, anchor_market_id, candidate_market_id, resolved_at)
                VALUES (${k}, ${k + "-s1"}, ${k + "-c1"}, false, true, 'AM', 'CM', '2026-03-01T00:00:00Z')
                ON CONFLICT (relation_key, sample_key) DO NOTHING`;
    }
    // Only the frozen key gets a snapshot, observed BEFORE resolution.
    await sql`INSERT INTO association_candidate_snapshot (relation_key, observed_at, anchor_market_id, candidate_market_id, candidate_side, anchor_prob_yes, candidate_price, classification_method)
              VALUES (${KEY_FROZEN}, '2026-02-01T00:00:00Z', 'AM', 'CM', 'yes', 0.5, 0.3, 'rule')
              ON CONFLICT (relation_key, observed_at, anchor_market_id, candidate_market_id, candidate_side) DO NOTHING`;

    const keys = new Set((await loadBucketBranchRows()).map((r) => r.relationKey));
    expect(keys.has(KEY_FROZEN)).toBe(true);  // frozen evidence ⇒ included
    expect(keys.has(KEY_NAKED)).toBe(false);  // no snapshot ⇒ excluded (the fix)
  });
});
