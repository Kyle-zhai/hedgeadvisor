/**
 * lib/relate/tuningProfile.ts — turn settled outcomes into GENERAL RULES that tune the engine, not a
 * per-question answer table.
 *
 * The old path looked up ONE template's settled φ by its exact relation_key — so a never-seen template
 * always missed and stayed a pure LLM guess. Instead, we RE-BUCKET every observation across templates by
 * its coarse structure (relation ROLE, mechanism TYPE, bought SIDE) and fit each bucket's realized
 * conditional payoff. These buckets are the learned regularities: "same-event collateral pays ~X when the
 * anchor fails", "cross-domain links are ~noise". A brand-new pair inherits its bucket's prior by role +
 * mechanism, so the engine is TUNED globally and answers unseen questions without looking them up.
 *
 * Coarse buckets also learn from FAR fewer samples than per-template calibration (a handful of roles vs
 * thousands of templates), so the moat starts shaping the engine long before any single template matures.
 */
import { loadBucketBranchRows, calibrateConditionalPayoff, type BucketBranchRow } from "@/lib/association";
import type { ConditionalCounts } from "@/lib/association/types";

export interface BucketStat {
  /** realized P(bought side pays | anchor FAILS) — the fail-state cover rate for this structural bucket. */
  pGivenFails: number;
  /** realized P(bought side pays | anchor WINS). */
  pGivenWins: number;
  /** pGivenFails − pGivenWins: how much MORE this bucket pays on a fail than a win (the hedge signal). */
  specificity: number;
  samplesFail: number;
  samplesWin: number;
}
export type TuningProfile = Map<string, BucketStat>;

/** Parse the coarse structure out of a stable relation_key:
 *  anchorClass->candidateClass:predicate->ROLE[:m=mechSignature]->SIDE@vN */
export function parseRelationKey(key: string): { role: string; mechType: string; side: string } | null {
  const parts = key.split("->");
  if (parts.length < 4) return null;
  const roleSeg = parts[2];
  const role = roleSeg.split(":m=")[0];
  const mechType = roleSeg.includes(":m=") ? roleSeg.split(":m=")[1].split(".")[0] || "rule" : "rule";
  const side = parts[parts.length - 1].split("@")[0];
  if (!role || !side) return null;
  return { role, mechType, side };
}

export function bucketKeys(role: string, mechType: string, side: string): string[] {
  // most specific first: role+mechanism+side, then role+side (the always-available coarse fallback)
  return [`${role}|${mechType}|${side}`, `${role}|${side}`];
}

interface AggCells { app: number; apn: number; anp: number; ann: number }
type Cells = ConditionalCounts;

/** Re-bucket per (relation_key, cluster, anchor-branch) tallies into the coarse structural buckets
 *  (role|side AND role|mech|side), normalizing by CLUSTER **across** relation_keys: every independent
 *  episode contributes weight 1 per bucket-branch, allocated to pay / no-pay by its realized candidate-pay
 *  fraction. This is the generalization step AND the fix for the over-count where one episode that mapped to
 *  several relation_keys (e.g. a World Cup observed as both `tournament_winner→stage_advance` and
 *  `national_team_title→final_appearance`) was summed as several "independent" samples — inflating a
 *  bucket's effective N and letting it cross the CALIBRATED threshold on fewer real episodes than it claims. */
function aggregateBucketsByCluster(rows: BucketBranchRow[]): Map<string, AggCells> {
  // 1) pool an episode's observations across the relation_keys that land in the same (bucket, branch)
  const groups = new Map<string, { bk: string; anchorPays: boolean; pay: number; total: number }>();
  for (const r of rows) {
    const p = parseRelationKey(r.relationKey);
    if (!p) continue;
    for (const bk of bucketKeys(p.role, p.mechType, p.side)) {
      const gk = `${bk}\u0000${r.cluster}\u0000${r.anchorPays ? 1 : 0}`;
      const g = groups.get(gk);
      if (g) { g.pay += r.pay; g.total += r.total; }
      else groups.set(gk, { bk, anchorPays: r.anchorPays, pay: r.pay, total: r.total });
    }
  }
  // 2) each (bucket, cluster, branch) episode = weight 1, split by its pooled candidate-pay fraction
  const agg = new Map<string, AggCells>();
  for (const g of groups.values()) {
    const bk = g.bk;
    const anchorPays = g.anchorPays;
    const fracPay = g.total > 0 ? g.pay / g.total : 0;
    const b = agg.get(bk) ?? { app: 0, apn: 0, anp: 0, ann: 0 };
    if (anchorPays) { b.app += fracPay; b.apn += 1 - fracPay; }
    else { b.anp += fracPay; b.ann += 1 - fracPay; }
    agg.set(bk, b);
  }
  return agg;
}

const cellsOf = (b: AggCells): Cells => ({
  anchorPayCandidatePay: b.app, anchorPayCandidateNoPay: b.apn,
  anchorNoPayCandidatePay: b.anp, anchorNoPayCandidateNoPay: b.ann,
});

/** The generalizable bucket COUNTS (role×mechanism×side), pooled across all templates and
 *  cluster-deduplicated. The robust optimizer calibrates a candidate from its bucket (not a per-relation_key
 *  lookup), so a never-seen template still calibrates and buckets cross the sample threshold far sooner —
 *  but only on genuinely INDEPENDENT episodes. Empty without a DB. */
export async function loadBucketCounts(): Promise<Map<string, Cells>> {
  const rows = await loadBucketBranchRows().catch(() => [] as BucketBranchRow[]);
  const out = new Map<string, Cells>();
  for (const [k, b] of aggregateBucketsByCluster(rows)) out.set(k, cellsOf(b));
  return out;
}

function buildProfile(rows: BucketBranchRow[]): TuningProfile {
  const agg = aggregateBucketsByCluster(rows);
  const profile: TuningProfile = new Map();
  for (const [k, b] of agg) {
    const cal = calibrateConditionalPayoff(
      { anchorPayCandidatePay: b.app, anchorPayCandidateNoPay: b.apn, anchorNoPayCandidatePay: b.anp, anchorNoPayCandidateNoPay: b.ann },
      0.9, 0,
    );
    profile.set(k, {
      pGivenFails: Number(cal.payGivenAnchorFails.mean.toFixed(4)),
      pGivenWins: Number(cal.payGivenAnchorPays.mean.toFixed(4)),
      specificity: Number(cal.posteriorSpecificity.toFixed(4)),
      samplesFail: Math.round(cal.payGivenAnchorFails.samples),
      samplesWin: Math.round(cal.payGivenAnchorPays.samples),
    });
  }
  return profile;
}

let cache: { profile: TuningProfile; at: number } | null = null;

/** The learned tuning profile (cached in-process; recomputed every ttl). Empty without a DB. */
export async function loadTuningProfile(ttlMs = 300_000, nowMs = Date.now()): Promise<TuningProfile> {
  if (cache && nowMs - cache.at < ttlMs) return cache.profile;
  const rows = await loadBucketBranchRows().catch(() => [] as BucketBranchRow[]);
  const profile = buildProfile(rows);
  cache = { profile, at: nowMs };
  return profile;
}

/** Look up the most-specific learned bucket (role+mechanism+side, else role+side) with enough evidence. */
export function lookupBucket(profile: TuningProfile, role: string, mechType: string, side: string, minSamplesPerBranch: number): BucketStat | null {
  for (const k of bucketKeys(role, mechType, side)) {
    const b = profile.get(k);
    if (b && Math.min(b.samplesFail, b.samplesWin) >= minSamplesPerBranch) return b;
  }
  return null;
}

/** Test seam: build a profile from explicit per-(relation_key, cluster, branch) episode rows (no DB). */
export const __buildProfileForTest = buildProfile;

/** Test seam: the cluster-deduplicated bucket COUNTS the robust optimizer calibrates from (no DB). */
export const __bucketCountsForTest = (rows: BucketBranchRow[]): Map<string, Cells> => {
  const out = new Map<string, Cells>();
  for (const [k, b] of aggregateBucketsByCluster(rows)) out.set(k, cellsOf(b));
  return out;
};
