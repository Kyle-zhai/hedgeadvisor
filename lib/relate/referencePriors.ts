/**
 * lib/relate/referencePriors.ts — §19 item 3: the REFERENCE_CLASS prior LOADER.
 *
 * The WALL shipped first (optimizer: referencePrior lives in its own field, can never be CALIBRATED,
 * never touches the settlement gate). This is the supply side: curated EXTERNAL base rates keyed by the
 * LEAF bucket `role|mechType|direction|side`, from the versioned seed file plus an optional
 * HEDGE_REFERENCE_PRIORS_JSON env override (ops can ship curated priors without a deploy; env wins on
 * key collisions). Validation is fail-closed per entry: a malformed prior is SKIPPED, never coerced.
 *
 * LEAF-ONLY lookups by design (docs §5 guard 2): transportability is a per-bucket human judgment; a prior
 * must never be inherited from a coarser rung. Empty seed ⇒ the whole layer is a no-op.
 */
import seed from "@/lib/data/seed/reference-class-priors.json";

export interface ReferencePrior {
  payGivenFail: number;
  payGivenWin: number;
  pseudoSamples: number;
  source: string;
}

const SIDES = new Set(["yes", "no"]);

function validEntry(v: unknown): v is ReferencePrior {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const p = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
  return p(o.payGivenFail) && p(o.payGivenWin)
    && typeof o.pseudoSamples === "number" && Number.isFinite(o.pseudoSamples) && o.pseudoSamples > 0
    && typeof o.source === "string" && o.source.trim().length > 0;
}

function validLeafKey(k: string): boolean {
  const parts = k.split("|");
  return parts.length === 4 && parts.every((s) => s.length > 0) && SIDES.has(parts[3]);
}

/** Pure: parse+validate a raw priors object; `_`-prefixed keys are docs; invalid entries are skipped. */
export function validateReferencePriors(raw: unknown): Map<string, ReferencePrior> {
  const out = new Map<string, ReferencePrior>();
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.startsWith("_")) continue; // documentation keys
    if (!validLeafKey(k) || !validEntry(v)) continue;
    out.set(k, { payGivenFail: v.payGivenFail, payGivenWin: v.payGivenWin, pseudoSamples: v.pseudoSamples, source: v.source });
  }
  return out;
}

let cache: Map<string, ReferencePrior> | null = null;

/** Seed + env override, cached per process. Fail-safe: broken env JSON is ignored, seed still loads. */
export function loadReferencePriors(): Map<string, ReferencePrior> {
  if (cache) return cache;
  const priors = validateReferencePriors(seed);
  const env = process.env.HEDGE_REFERENCE_PRIORS_JSON;
  if (env) {
    try {
      for (const [k, v] of validateReferencePriors(JSON.parse(env))) priors.set(k, v);
    } catch {
      /* ignore malformed env JSON — the seed remains authoritative */
    }
  }
  cache = priors;
  return priors;
}

/** Test hook: clear the process cache (env-dependent tests). */
export function resetReferencePriorsCache(): void {
  cache = null;
}
