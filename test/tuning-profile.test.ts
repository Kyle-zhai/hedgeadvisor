import { describe, it, expect } from "vitest";
import { __buildProfileForTest, __bucketCountsForTest, parseRelationKey, lookupBucket } from "@/lib/relate/tuningProfile";
import type { BucketBranchRow } from "@/lib/association";

const V = "@v5";
const key = (role: string, mech: string, side: string) =>
  `competition_winner->broadcast_language:says_champion->${role}${mech ? `:m=${mech}` : ""}->${side}${V}`;

// Emit single-EPISODE rows for a relation_key. fp/fn = fail-branch pay/no-pay episodes, wp/wn = win-branch.
// Each row is one DISTINCT cluster (`prefix-i`), UNLESS two calls share a prefix on purpose (same episodes).
function rows(rk: string, spec: { fp: number; fn: number; wp: number; wn: number }, prefix: string): BucketBranchRow[] {
  const out: BucketBranchRow[] = []; let i = 0;
  const push = (anchorPays: boolean, pay: 0 | 1, n: number) => {
    for (let k = 0; k < n; k++) out.push({ relationKey: rk, cluster: `${prefix}-${i++}`, anchorPays, pay, total: 1 });
  };
  push(false, 1, spec.fp); push(false, 0, spec.fn); push(true, 1, spec.wp); push(true, 0, spec.wn);
  return out;
}
const hedge = { fp: 10, fn: 2, wp: 2, wn: 10 }; // pays on FAIL far more than on WIN

describe("tuning profile — learn general rules, cluster-deduplicated", () => {
  it("parses role / mechanism / side out of a relation key", () => {
    expect(parseRelationKey(key("entity_event", "narrative.entity_specific.before", "no"))).toEqual({
      role: "entity_event", mechType: "narrative", side: "no",
    });
    expect(parseRelationKey(key("cross_domain", "", "yes"))).toEqual({ role: "cross_domain", mechType: "rule", side: "yes" });
  });

  it("POOLS distinct templates of the same role into one coarse bucket", () => {
    const all = [
      ...rows(key("entity_event", "narrative.a.b", "no"), hedge, "tA"),
      ...rows(key("entity_event", "narrative.c.d", "no"), hedge, "tB"), // DISTINCT clusters
    ];
    const profile = __buildProfileForTest(all);
    const coarse = profile.get("entity_event|no");
    expect(coarse).toBeTruthy();
    expect(coarse!.samplesFail).toBeGreaterThanOrEqual(20); // 2×12 distinct fail-branch episodes
    expect(coarse!.specificity).toBeGreaterThan(0.3); // pays much more on fail than win
  });

  it("F1 FIX: one episode under MANY relation_keys counts ONCE, not N times", () => {
    // The SAME clusters (shared-*) observed under two different relation_keys that map to the same bucket.
    // The old per-relation_key normalization summed these as independent ⇒ doubled N; the fix dedups by cluster.
    const dup = (rk: string) => rows(rk, hedge, "shared"); // identical cluster ids ⇒ the same episodes
    const profile = __buildProfileForTest([
      ...dup(key("entity_event", "narrative.a.b", "no")),
      ...dup(key("entity_event", "narrative.c.d", "no")),
    ]);
    const coarse = profile.get("entity_event|no")!;
    expect(coarse.samplesFail).toBe(12); // 12 episodes, NOT 24 — duplicate relation_key cannot inflate N
    expect(coarse.samplesWin).toBe(12);
  });

  it("GENERALIZES: an unseen mechanism still inherits the role-level rule (lookup fallback)", () => {
    const profile = __buildProfileForTest([
      ...rows(key("entity_event", "narrative.a.b", "no"), hedge, "tA"),
      ...rows(key("entity_event", "narrative.c.d", "no"), hedge, "tB"),
    ]);
    // a brand-new pair with a mechanism never seen before → the fine bucket misses, but the coarse role
    // bucket applies. This is the whole point: the engine is tuned for structure, not for the exact question.
    const hit = lookupBucket(profile, "entity_event", "totally_new_mechanism", "no", 4);
    expect(hit).toBeTruthy();
    expect(hit!.pGivenFails).toBeGreaterThan(hit!.pGivenWins);
  });

  it("bucket COUNTS pool per-template into role|side AND role|mech|side (distinct clusters)", () => {
    const counts = __bucketCountsForTest([
      ...rows(key("cross_domain", "economic.a.b", "yes"), { fp: 3, fn: 4, wp: 1, wn: 2 }, "x"),
      ...rows(key("cross_domain", "economic.c.d", "yes"), { fp: 3, fn: 4, wp: 1, wn: 2 }, "y"), // distinct
    ]);
    // both buckets pool the TWO templates' distinct episodes (anp 3+3, ann 4+4, app 1+1, apn 2+2)
    expect(counts.get("cross_domain|yes")).toEqual({ anchorPayCandidatePay: 2, anchorPayCandidateNoPay: 4, anchorNoPayCandidatePay: 6, anchorNoPayCandidateNoPay: 8 });
    expect(counts.get("cross_domain|economic|yes")).toEqual({ anchorPayCandidatePay: 2, anchorPayCandidateNoPay: 4, anchorNoPayCandidatePay: 6, anchorNoPayCandidateNoPay: 8 });
  });

  it("withholds a rule when a bucket lacks evidence", () => {
    const profile = __buildProfileForTest(rows(key("cross_domain", "thematic.x.y", "yes"), { fp: 1, fn: 1, wp: 1, wn: 1 }, "z"));
    expect(lookupBucket(profile, "cross_domain", "thematic", "yes", 20)).toBeNull(); // 2 samples < 20
  });
});
