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
import { loadAllConditionalCounts, calibrateConditionalPayoff } from "@/lib/association";

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

function buildProfile(all: Map<string, { anchorPayCandidatePay: number; anchorPayCandidateNoPay: number; anchorNoPayCandidatePay: number; anchorNoPayCandidateNoPay: number }>): TuningProfile {
  const agg = new Map<string, AggCells>();
  const add = (k: string, c: { anchorPayCandidatePay: number; anchorPayCandidateNoPay: number; anchorNoPayCandidatePay: number; anchorNoPayCandidateNoPay: number }) => {
    const b = agg.get(k) ?? { app: 0, apn: 0, anp: 0, ann: 0 };
    b.app += c.anchorPayCandidatePay; b.apn += c.anchorPayCandidateNoPay;
    b.anp += c.anchorNoPayCandidatePay; b.ann += c.anchorNoPayCandidateNoPay;
    agg.set(k, b);
  };
  for (const [key, counts] of all) {
    const p = parseRelationKey(key);
    if (!p) continue;
    add(`${p.role}|${p.side}`, counts);
    add(`${p.role}|${p.mechType}|${p.side}`, counts);
  }
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
  const all = await loadAllConditionalCounts().catch(() => new Map());
  const profile = buildProfile(all as never);
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

/** Test seam: build a profile from explicit per-template counts without a DB. */
export const __buildProfileForTest = buildProfile;
