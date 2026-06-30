import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { getSql } from "@/lib/data/db";
import { loadPendingFrozenPairs, upsertAssociationObservations } from "@/lib/association";

try { for (const l of readFileSync(".env.local", "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && m[2].trim() && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); } } catch {}

const PFX = "TESTSIDE-" + Math.floor(Date.now() % 1e7);
const RK = `${PFX}-rk`;

describe.skipIf(!process.env.DATABASE_URL)("loadPendingFrozenPairs side discipline", () => {
  afterAll(async () => {
    const sql = await getSql(); if (!sql) return;
    await sql`DELETE FROM association_observation WHERE relation_key LIKE ${PFX + "%"}`;
    await sql`DELETE FROM association_candidate_snapshot WHERE relation_key LIKE ${PFX + "%"}`;
    await sql`DELETE FROM association_relation WHERE relation_key LIKE ${PFX + "%"}`;
  });

  it("a side with no matching observation stays pending even when the SAME relation_key settled the other side", async () => {
    const sql = await getSql(); if (!sql) return;
    await sql`INSERT INTO association_relation (relation_key, anchor_template, candidate_template, candidate_side) VALUES (${RK}, 'a', 'b', 'yes') ON CONFLICT (relation_key) DO NOTHING`;

    // Observation for RK — candidate_side is populated from the relation ('yes')
    await upsertAssociationObservations(RK, [{ sampleKey: `${RK}-s1`, anchorPays: false, candidatePays: true, anchorMarketId: "AM", candidateMarketId: "CM", resolvedAt: "2026-03-01T00:00:00Z" }]);
    const [obs] = await sql`SELECT candidate_side FROM association_observation WHERE relation_key = ${RK}` as Array<{ candidate_side: string | null }>;
    expect(obs.candidate_side).toBe("yes"); // write-path populates the explicit side

    // Two frozen snapshots on the SAME relation_key + markets but different sides (simulates a future structure
    // where relation_key no longer uniquely encodes side). Only 'yes' has a settled observation.
    for (const side of ["yes", "no"] as const) {
      await sql`INSERT INTO association_candidate_snapshot
        (relation_key, observed_at, anchor_market_id, candidate_market_id, candidate_side, anchor_prob_yes, candidate_price, classification_method, anchor_event_key, anchor_venue, candidate_event_key, candidate_venue)
        VALUES (${RK}, '2026-02-01T00:00:00Z', 'AM', 'CM', ${side}, 0.5, 0.3, 'rule', 'aev', 'polymarket', 'cev', 'polymarket')
        ON CONFLICT (relation_key, observed_at, anchor_market_id, candidate_market_id, candidate_side) DO NOTHING`;
    }

    const mine = (await loadPendingFrozenPairs(20000)).filter((p) => p.relationKey === RK);
    const sides = new Set(mine.map((p) => p.candidateSide));
    expect(sides.has("no")).toBe(true);   // 'no' side has no matching observation ⇒ still pending (the fix)
    expect(sides.has("yes")).toBe(false); // 'yes' side settled ⇒ not pending
  });
});
