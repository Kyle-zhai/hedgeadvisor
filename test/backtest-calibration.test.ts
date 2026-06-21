/**
 * CALIBRATION BACKTEST (manual; hits the real Polymarket API). Answers the honest gate:
 * are our de-vigged probabilities actually calibrated against RESOLVED outcomes, and does
 * Shin/power beat proportional? SKIPPED by default (network + minutes). To run:
 *   change `describe.skip` → `describe`, then
 *   npx vitest run test/backtest-calibration.test.ts --reporter=basic
 */
import { describe, expect, test } from "vitest";
import { gammaGet, parseJsonArray } from "@/lib/polymarket/client";
import { fetchPricesHistory } from "@/lib/polymarket";
import { devig, devigPower, devigShin } from "@/lib/correlation";
import { calibration, type Sample } from "@/lib/estimate/calibration";

const LONG = 240_000;
const LEAD = 7 * 86400; // forecast horizon: read the price ~7 days before resolution

interface RawMarket { question?: string; outcomePrices?: string | string[]; clobTokenIds?: string | string[] }
interface RawEvent { slug?: string; markets?: RawMarket[] }

/** Last history point at or before `targetT` (falls back to the earliest point). */
function priceAt(hist: Array<{ t: number; p: number }>, targetT: number): number | null {
  let best: number | null = null;
  for (const h of hist) if (h.t <= targetT) best = h.p;
  return best ?? (hist[0]?.p ?? null);
}
const cleanBinaryOutcome = (m: RawMarket): 0 | 1 | null => {
  const op = parseJsonArray(m.outcomePrices).map(Number);
  if (op.length === 2 && (op[0] === 0 || op[0] === 1)) return op[0] === 1 ? 1 : 0;
  return null;
};
async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

describe.skip("CALIBRATION backtest (manual — un-skip to run; hits real API)", () => {
  test("marginal: are de-vigged YES prices ~7d out calibrated vs resolution?", async () => {
    const events = await gammaGet<RawEvent[]>("/events?closed=true&limit=80&order=volume&ascending=false");
    const cands: { tokenYes: string; outcome: 0 | 1 }[] = [];
    for (const e of Array.isArray(events) ? events : []) {
      for (const m of e.markets ?? []) {
        const o = cleanBinaryOutcome(m);
        const toks = parseJsonArray(m.clobTokenIds);
        if (o === null || toks.length < 1) continue;
        cands.push({ tokenYes: toks[0], outcome: o });
        if (cands.length >= 120) break;
      }
      if (cands.length >= 120) break;
    }
    const samples: Sample[] = (
      await pool(cands, 8, async (c) => {
        const h = await fetchPricesHistory(c.tokenYes);
        if (h.length < 2) return null;
        const target = h[h.length - 1].t - LEAD;
        const p = priceAt(h, target);
        return p !== null && p > 0 && p < 1 ? { p, outcome: c.outcome } : null;
      })
    ).filter((x): x is Sample => x !== null);

    const r = calibration(samples);
    console.log(`\n=== MARGINAL calibration (n=${r.n}, ~7d lead) ===`);
    console.log(`Brier ${r.brier} | logLoss ${r.logLoss} | bias ${r.bias} | ECE ${r.ece} | BrierSkill ${r.brierSkill} | baseRate ${r.baseRate}`);
    console.table(r.buckets.map((b) => ({ bucket: `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}`, n: b.n, pred: b.meanPred.toFixed(3), actual: b.meanOutcome.toFixed(3) })));
    expect(r.n).toBeGreaterThan(20);
    expect(r.ece).toBeLessThan(0.2); // prediction markets should be roughly calibrated
  }, LONG);

  test("de-vig method comparison: proportional vs power vs Shin (multi-outcome events)", async () => {
    const events = await gammaGet<RawEvent[]>("/events?closed=true&limit=120&order=volume&ascending=false");
    const propS: Sample[] = [];
    const powS: Sample[] = [];
    const shinS: Sample[] = [];
    let used = 0;
    for (const e of Array.isArray(events) ? events : []) {
      const ms = (e.markets ?? []).filter((m) => cleanBinaryOutcome(m) !== null && parseJsonArray(m.clobTokenIds).length >= 1);
      const winners = ms.filter((m) => cleanBinaryOutcome(m) === 1).length;
      if (ms.length < 3 || winners !== 1) continue; // a clean "exactly one winner" partition
      const hists = await pool(ms, 8, (m) => fetchPricesHistory(parseJsonArray(m.clobTokenIds)[0]));
      if (hists.some((h) => h.length < 2)) continue;
      const target = Math.min(...hists.map((h) => h[h.length - 1].t)) - LEAD;
      const prices = hists.map((h) => priceAt(h, target));
      if (prices.some((p) => p === null || p <= 0 || p >= 1)) continue;
      const yes = prices as number[];
      const qProp = devig(yes);
      const qPow = devigPower(yes).q;
      const qShin = devigShin(yes).q;
      ms.forEach((m, i) => {
        const o = cleanBinaryOutcome(m) as 0 | 1;
        propS.push({ p: qProp[i], outcome: o });
        powS.push({ p: qPow[i], outcome: o });
        shinS.push({ p: qShin[i], outcome: o });
      });
      if (++used >= 8) break;
    }
    const cp = calibration(propS);
    const cw = calibration(powS);
    const cs = calibration(shinS);
    console.log(`\n=== DE-VIG method calibration (${used} events, n=${cp.n} outcomes) ===`);
    for (const [name, c] of [["proportional", cp], ["power", cw], ["shin", cs]] as const) {
      console.log(`${name.padEnd(13)} Brier ${c.brier} | logLoss ${c.logLoss} | bias ${c.bias} | ECE ${c.ece}`);
    }
    expect(cp.n).toBeGreaterThan(15);
  }, LONG);

  test("cross-market independence sanity: random cross-event pairs ≈ independent", async () => {
    const events = await gammaGet<RawEvent[]>("/events?closed=true&limit=120&order=volume&ascending=false");
    const legs: { p: number; o: 0 | 1; ev: string }[] = [];
    for (const e of Array.isArray(events) ? events : []) {
      for (const m of e.markets ?? []) {
        const o = cleanBinaryOutcome(m);
        const toks = parseJsonArray(m.clobTokenIds);
        if (o === null || toks.length < 1) continue;
        const h = await fetchPricesHistory(toks[0]);
        if (h.length < 2) continue;
        const p = priceAt(h, h[h.length - 1].t - LEAD);
        if (p !== null && p > 0.05 && p < 0.95) legs.push({ p, o, ev: e.slug ?? "" });
        break; // one leg per event keeps pairs cross-market
      }
      if (legs.length >= 40) break;
    }
    let predBoth = 0;
    let realBoth = 0;
    let pairs = 0;
    for (let i = 0; i + 1 < legs.length; i += 2) {
      const a = legs[i];
      const b = legs[i + 1];
      if (a.ev === b.ev) continue;
      predBoth += a.p * b.p; // independence prediction
      realBoth += a.o === 1 && b.o === 1 ? 1 : 0;
      pairs++;
    }
    console.log(`\n=== CROSS-MARKET independence sanity (${pairs} random cross-event pairs) ===`);
    console.log(`mean independence P(both) = ${(predBoth / Math.max(1, pairs)).toFixed(4)} | realized P(both) = ${(realBoth / Math.max(1, pairs)).toFixed(4)}`);
    expect(pairs).toBeGreaterThan(5);
  }, LONG);
});
