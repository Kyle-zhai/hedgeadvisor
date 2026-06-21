/**
 * MANUAL live verification of the cross-venue linker (hits REAL Polymarket + Kalshi).
 * SKIPPED by default so the offline suite stays deterministic. To run:
 *   change `describe.skip` → `describe`, then
 *   npx vitest run test/link-live.test.ts --reporter=basic
 * Validates the user's example end to end: a Polymarket bet on Spain surfaces the live Kalshi
 * markets logically tied to it, each correctly classified (EQUIVALENT/MUTEX/SUBSET vs speculative).
 */
import { describe, expect, test } from "vitest";
import { relateCrossVenue } from "@/lib/link";

const LONG = 90_000;

function dump(label: string, r: Awaited<ReturnType<typeof relateCrossVenue>>) {
  console.log(`\n=== ${label} ===  status=${r.status}`);
  if (r.pm) console.log(`PM: ${r.pm.claim}  [${r.pm.claimKind}]  yesMid=${r.pm.yesMid != null ? Math.round(r.pm.yesMid * 100) + "¢" : "n/a"}`);
  for (const l of r.links ?? []) {
    console.log(
      `  • [${l.rule}/${l.provenance}] ${l.kalshiLabel} — ${l.kalshiMarketTitle} ` +
        `(${l.kalshiTicker}, ${l.kalshiYesMid != null ? Math.round(l.kalshiYesMid * 100) + "¢" : "?"}, take ${l.kalshiSide.toUpperCase()}; uses ${l.uses.join("+")})` +
        (l.priceNote ? `\n      ${l.priceNote}` : ""),
    );
  }
}

describe.skip("cross-venue linker (live)", () => {
  test(
    "champion claim: Spain to win the World Cup",
    async () => {
      const r = await relateCrossVenue({ query: "Spain to win the World Cup", stakeUsd: 20 });
      dump("Spain · champion", r);
      expect(r.status).toBe("ok");
      expect(r.pm?.entity.toLowerCase()).toContain("spain");
      const links = r.links ?? [];
      expect(links.length).toBeGreaterThan(0);
      // a clean EQUIVALENT cross-venue leg must exist (Kalshi champion market)
      expect(links.some((l) => l.rule === "EQUIVALENT" && l.provenance === "ANALYTIC")).toBe(true);
      // every ANALYTIC link is actionable; every speculative one is context-only
      for (const l of links) {
        if (l.provenance === "SPECULATIVE") expect(l.uses).toEqual(["context"]);
      }
    },
    LONG,
  );

  test(
    "match claim: Spain wins next match",
    async () => {
      const r = await relateCrossVenue({ query: "Spain wins next match", stakeUsd: 20 });
      dump("Spain · next match", r);
      expect(r.status).toBe("ok");
      expect(r.pm?.claimKind).toBe("match");
    },
    LONG,
  );
});
