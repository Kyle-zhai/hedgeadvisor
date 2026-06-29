import { describe, it, expect } from "vitest";
import { __buildProfileForTest, __bucketCountsForTest, parseRelationKey, lookupBucket } from "@/lib/relate/tuningProfile";
import type { BucketBranchRow } from "@/lib/association";

const V = "@v5";
const key = (role: string, mech: string, side: string) =>
  `competition_winner->broadcast_language:says_champion->${role}${mech ? `:m=${mech}` : ""}->${side}${V}`;
// canonical 6-segment signature: mechType.scope.timeOrder.portability.DIRECTION.edges (ontology.ts)
const sig = (mechType: string, direction: "positive" | "negative" | "ambiguous") =>
  `${mechType}.cross_domain.before.event_class.${direction}.edges=x`;

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
const amplifier = { fp: 2, fn: 10, wp: 10, wn: 2 }; // co-moves: pays on WIN far more than on FAIL

describe("tuning profile — learn general rules, cluster-deduplicated, sign-separated", () => {
  it("parses role / mechanism / DIRECTION / side out of a relation key", () => {
    expect(parseRelationKey(key("entity_event", "narrative.entity_specific.before", "no"))).toEqual({
      role: "entity_event", mechType: "narrative", direction: "ambiguous", side: "no",
    });
    // a full canonical signature exposes the payoff direction (segment 4)
    expect(parseRelationKey(key("cross_domain", sig("causal", "negative"), "yes"))).toEqual({
      role: "cross_domain", mechType: "causal", direction: "negative", side: "yes",
    });
    expect(parseRelationKey(key("cross_domain", "", "yes"))).toEqual({ role: "cross_domain", mechType: "rule", direction: "ambiguous", side: "yes" });
  });

  it("POOLS distinct templates of the same role into one coarse bucket", () => {
    const all = [
      ...rows(key("entity_event", "narrative.a.b", "no"), hedge, "tA"),
      ...rows(key("entity_event", "narrative.c.d", "no"), hedge, "tB"), // DISTINCT clusters
    ];
    const profile = __buildProfileForTest(all);
    const coarse = profile.get("entity_event|ambiguous|no");
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
    const coarse = profile.get("entity_event|ambiguous|no")!;
    expect(coarse.samplesFail).toBe(12); // 12 episodes, NOT 24 — duplicate relation_key cannot inflate N
    expect(coarse.samplesWin).toBe(12);
  });

  it("F2 FIX: a hedge (negative) and an amplifier (positive) of the same role/mech/side NEVER pool", () => {
    // Same role=cross_domain, mechType=causal, side=no — opposite payoff DIRECTION. Without F2 these pooled
    // into one `cross_domain|causal|no` bucket and netted their specificity toward noise (a hedge could
    // inherit an amplifier's blended payoff and pass the optimizer's specificity gate on contamination).
    const profile = __buildProfileForTest([
      ...rows(key("cross_domain", sig("causal", "negative"), "no"), hedge, "h"),
      ...rows(key("cross_domain", sig("causal", "positive"), "no"), amplifier, "a"),
    ]);
    // separate, sign-pure buckets
    const h = profile.get("cross_domain|causal|negative|no")!;
    const a = profile.get("cross_domain|causal|positive|no")!;
    expect(h.specificity).toBeGreaterThan(0); // genuine hedge: pays more on fail
    expect(a.specificity).toBeLessThan(0); // amplifier: pays more on win
    // the old sign-blind keys must NOT exist (no contaminated merge)
    expect(profile.get("cross_domain|causal|no")).toBeUndefined();
    expect(profile.get("cross_domain|no")).toBeUndefined();
    // a lookup only ever sees the sign-matched cohort
    expect(lookupBucket(profile, "cross_domain", "causal", "negative", "no", 4)!.specificity).toBeGreaterThan(0);
    expect(lookupBucket(profile, "cross_domain", "causal", "positive", "no", 4)!.specificity).toBeLessThan(0);
  });

  it("GENERALIZES: an unseen mechanism still inherits the role-level rule (lookup fallback)", () => {
    const profile = __buildProfileForTest([
      ...rows(key("entity_event", "narrative.a.b", "no"), hedge, "tA"),
      ...rows(key("entity_event", "narrative.c.d", "no"), hedge, "tB"),
    ]);
    // a brand-new pair with a mechanism never seen before → the fine bucket misses, but the coarse role
    // bucket applies. This is the whole point: the engine is tuned for structure, not for the exact question.
    const hit = lookupBucket(profile, "entity_event", "totally_new_mechanism", "ambiguous", "no", 4);
    expect(hit).toBeTruthy();
    expect(hit!.pGivenFails).toBeGreaterThan(hit!.pGivenWins);
  });

  it("bucket COUNTS pool per-template into role|dir|side AND role|mech|dir|side (distinct clusters)", () => {
    const counts = __bucketCountsForTest([
      ...rows(key("cross_domain", "economic.a.b", "yes"), { fp: 3, fn: 4, wp: 1, wn: 2 }, "x"),
      ...rows(key("cross_domain", "economic.c.d", "yes"), { fp: 3, fn: 4, wp: 1, wn: 2 }, "y"), // distinct
    ]);
    // both buckets pool the TWO templates' distinct episodes (anp 3+3, ann 4+4, app 1+1, apn 2+2)
    expect(counts.get("cross_domain|ambiguous|yes")).toEqual({ anchorPayCandidatePay: 2, anchorPayCandidateNoPay: 4, anchorNoPayCandidatePay: 6, anchorNoPayCandidateNoPay: 8 });
    expect(counts.get("cross_domain|economic|ambiguous|yes")).toEqual({ anchorPayCandidatePay: 2, anchorPayCandidateNoPay: 4, anchorNoPayCandidatePay: 6, anchorNoPayCandidateNoPay: 8 });
  });

  it("withholds a rule when a bucket lacks evidence", () => {
    const profile = __buildProfileForTest(rows(key("cross_domain", "thematic.x.y", "yes"), { fp: 1, fn: 1, wp: 1, wn: 1 }, "z"));
    expect(lookupBucket(profile, "cross_domain", "thematic", "ambiguous", "yes", 20)).toBeNull(); // 2 samples < 20
  });

  // #1 sign-pure fallback rungs: when EVERY leaf rung (role|mech|dir|side, role|dir|side) is too thin, the
  // coarser SIGN-PURE rungs (mech|dir|side, dir|side) — which pool ACROSS roles but keep DIRECTION — supply
  // the shrink prior. The returned stat is flagged fallbackRung so it can NEVER promote to CALIBRATED.
  it("FALLBACK: a thin-leaf leg inherits a coarser SIGN-PURE rung (role dropped, direction kept)", () => {
    // two DIFFERENT roles, same mech+direction+side, each leaf too thin (6 fail / 6 win < 12) but the
    // mech|dir|side rung pools to 12 each across roles.
    const thin = { fp: 6, fn: 6, wp: 2, wn: 10 };
    const profile = __buildProfileForTest([
      ...rows(key("entity_event", sig("causal", "negative"), "yes"), thin, "r1"),
      ...rows(key("cross_domain", sig("causal", "negative"), "yes"), thin, "r2"),
    ]);
    // a brand-new role with the SAME sign-matched mechanism: leaf rungs miss, coarse mech|dir rung applies.
    const hit = lookupBucket(profile, "totally_new_role", "causal", "negative", "yes", 12);
    expect(hit).toBeTruthy();
    expect(hit!.fallbackRung).toBe(true); // SHRINK-only — never promotable to CALIBRATED
    expect(hit!.samplesFail).toBeGreaterThanOrEqual(12); // pooled across roles
  });

  it("FALLBACK keeps DIRECTION pure: an amplifier rung is never returned for a hedge lookup", () => {
    // mech=causal, side=yes — but only the POSITIVE (amplifier) coarse rung is populated. A NEGATIVE (hedge)
    // lookup must NOT borrow it (direction stays in every rung), so it finds nothing.
    const profile = __buildProfileForTest([
      ...rows(key("entity_event", sig("causal", "positive"), "yes"), amplifier, "p1"),
      ...rows(key("cross_domain", sig("causal", "positive"), "yes"), amplifier, "p2"),
    ]);
    expect(lookupBucket(profile, "new_role", "causal", "negative", "yes", 12)).toBeNull(); // no opposite-sign borrow
    const amp = lookupBucket(profile, "new_role", "causal", "positive", "yes", 12);
    expect(amp).toBeTruthy();
    expect(amp!.fallbackRung).toBe(true);
    expect(amp!.specificity).toBeLessThan(0); // sign-pure amplifier
  });

  it("FALLBACK is SUBORDINATE to a populated leaf rung (leaf wins, not flagged fallback)", () => {
    // a well-evidenced leaf rung (role|mech|dir|side) and a coarse rung both qualify ⇒ the leaf is preferred
    // and is NOT a fallback (it carries the leg's own samples, so it may promote).
    const profile = __buildProfileForTest([
      ...rows(key("entity_event", sig("causal", "negative"), "yes"), hedge, "leaf"),
      ...rows(key("cross_domain", sig("causal", "negative"), "yes"), hedge, "other"),
    ]);
    const hit = lookupBucket(profile, "entity_event", "causal", "negative", "yes", 4);
    expect(hit).toBeTruthy();
    expect(hit!.fallbackRung).toBeFalsy(); // leaf rung, promotion-eligible
  });
});
