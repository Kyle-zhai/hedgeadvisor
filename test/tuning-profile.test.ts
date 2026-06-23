import { describe, it, expect } from "vitest";
import { __buildProfileForTest, parseRelationKey, lookupBucket } from "@/lib/relate/tuningProfile";

const V = "@v5";
const key = (role: string, mech: string, side: string) =>
  `competition_winner->broadcast_language:says_champion->${role}${mech ? `:m=${mech}` : ""}->${side}${V}`;

// A hedge bucket: when the anchor FAILS the candidate's NO side pays; when the anchor WINS it does not.
const hedgeCounts = { anchorPayCandidatePay: 2, anchorPayCandidateNoPay: 10, anchorNoPayCandidatePay: 10, anchorNoPayCandidateNoPay: 2 };

describe("tuning profile — learn general rules, not per-template lookup", () => {
  it("parses role / mechanism / side out of a relation key", () => {
    expect(parseRelationKey(key("entity_event", "narrative.entity_specific.before", "no"))).toEqual({
      role: "entity_event", mechType: "narrative", side: "no",
    });
    expect(parseRelationKey(key("cross_domain", "", "yes"))).toEqual({ role: "cross_domain", mechType: "rule", side: "yes" });
  });

  it("POOLS distinct templates of the same role into one coarse bucket", () => {
    // two DIFFERENT templates (different mechanism detail), same role+side → pool into `entity_event|no`
    const all = new Map([
      [key("entity_event", "narrative.a.b", "no"), hedgeCounts],
      [key("entity_event", "narrative.c.d", "no"), hedgeCounts],
    ]);
    const profile = __buildProfileForTest(all);
    const coarse = profile.get("entity_event|no");
    expect(coarse).toBeTruthy();
    // pooled fail-branch samples ≈ 2 templates × (10+2) = 24, so it crosses the calibration threshold
    expect(coarse!.samplesFail).toBeGreaterThanOrEqual(20);
    expect(coarse!.specificity).toBeGreaterThan(0.3); // pays much more on fail than win
  });

  it("GENERALIZES: an unseen mechanism still inherits the role-level rule (lookup fallback)", () => {
    const all = new Map([
      [key("entity_event", "narrative.a.b", "no"), hedgeCounts],
      [key("entity_event", "narrative.c.d", "no"), hedgeCounts],
    ]);
    const profile = __buildProfileForTest(all);
    // a brand-new pair with a mechanism never seen before → the fine bucket misses, but the coarse role
    // bucket applies. This is the whole point: the engine is tuned for structure, not for the exact question.
    const hit = lookupBucket(profile, "entity_event", "totally_new_mechanism", "no", 4);
    expect(hit).toBeTruthy();
    expect(hit!.pGivenFails).toBeGreaterThan(hit!.pGivenWins);
  });

  it("withholds a rule when a bucket lacks evidence", () => {
    const all = new Map([[key("cross_domain", "thematic.x.y", "yes"), { anchorPayCandidatePay: 1, anchorPayCandidateNoPay: 1, anchorNoPayCandidatePay: 1, anchorNoPayCandidateNoPay: 1 }]]);
    const profile = __buildProfileForTest(all);
    expect(lookupBucket(profile, "cross_domain", "thematic", "yes", 20)).toBeNull(); // 2 samples < 20
  });
});
