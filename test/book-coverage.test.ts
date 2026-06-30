import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { getSql } from "@/lib/data/db";
import { bookCoverageStats } from "@/lib/relate/frozenBooks";

try { for (const l of readFileSync(".env.local", "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && m[2].trim() && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); } } catch {}

const PFX = "TESTBOOKCOV-" + Math.floor(Date.now() % 1e7);
const tok = (n: number) => `${PFX}-TOK${n}`;

describe.skipIf(!process.env.DATABASE_URL)("bookCoverageStats (Block B)", () => {
  afterAll(async () => {
    const sql = await getSql(); if (!sql) return;
    await sql`DELETE FROM association_candidate_snapshot WHERE relation_key LIKE ${PFX + "%"}`;
    await sql`DELETE FROM association_relation WHERE relation_key LIKE ${PFX + "%"}`;
    await sql`DELETE FROM book_snapshot WHERE token_id LIKE ${PFX + "%"}`;
  });

  it("counts only books at/before observed_at as execution-grade coverage", async () => {
    const sql = await getSql(); if (!sql) return;
    const before = await bookCoverageStats(PFX); // scoped to this test's rows ⇒ isolated from concurrent test files

    const snap = async (n: number, tokenId: string) => {
      const rk = `${PFX}-r${n}`;
      await sql`INSERT INTO association_relation (relation_key, anchor_template, candidate_template, candidate_side) VALUES (${rk}, 'a', 'b', 'yes') ON CONFLICT (relation_key) DO NOTHING`;
      await sql`INSERT INTO association_candidate_snapshot (relation_key, observed_at, anchor_market_id, candidate_market_id, candidate_side, anchor_prob_yes, candidate_price, classification_method, candidate_token_id)
                VALUES (${rk}, '2026-02-10T00:00:00Z', 'AM', ${"CM" + n}, 'yes', 0.5, 0.3, 'rule', ${tokenId})
                ON CONFLICT (relation_key, observed_at, anchor_market_id, candidate_market_id, candidate_side) DO NOTHING`;
    };
    await snap(1, tok(1)); // book BEFORE observed_at ⇒ execution-grade
    await snap(2, tok(2)); // book AFTER observed_at ⇒ has-a-book but NOT execution-grade
    await snap(3, tok(3)); // no book at all
    await sql`INSERT INTO book_snapshot (token_id, ts, best_bid, best_ask, source) VALUES (${tok(1)}, '2026-02-05T00:00:00Z', 0.4, 0.45, 'test') ON CONFLICT (token_id, ts) DO NOTHING`;
    await sql`INSERT INTO book_snapshot (token_id, ts, best_bid, best_ask, source) VALUES (${tok(2)}, '2026-02-20T00:00:00Z', 0.4, 0.45, 'test') ON CONFLICT (token_id, ts) DO NOTHING`;

    const after = await bookCoverageStats(PFX);
    expect(after.eligibleSnapshots - before.eligibleSnapshots).toBe(3); // 3 token-bearing snapshots added
    expect(after.withBook - before.withBook).toBe(1);                   // only TOK1's book is ≤ observed_at
    expect(after.distinctTokens - before.distinctTokens).toBe(3);
    expect(after.tokensWithAnyBook - before.tokensWithAnyBook).toBe(2); // TOK1 + TOK2 have a book row
  });
});
