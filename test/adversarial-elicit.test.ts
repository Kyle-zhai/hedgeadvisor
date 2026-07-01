import { describe, expect, test } from "vitest";
import { adversarialSignVeto } from "@/lib/association";

/** §19 anti-sycophancy sign veto: keep a divergence ONLY when it survives being argued against.
 *  Veto-only (can never widen a divergence or admit a leg); fail-open on adversarial errors. */

describe("adversarialSignVeto", () => {
  const hedgy = { pGivenAnchorWins: 0.1, pGivenAnchorFails: 0.6 }; // fail-leaning primary (dP > 0)

  test("survives: adversarial reproduces a materially divergent SAME-SIGN estimate", () => {
    const v = adversarialSignVeto(hedgy, { status: "ok", pGivenAnchorWins: 0.2, pGivenAnchorFails: 0.5 });
    expect(v.vetoed).toBe(false);
    expect(v.pGivenAnchorFails).toBe(0.6); // primary untouched
  });

  test("vetoed: adversarial maintains independence (equalized) ⇒ conditionals equalize, φ→0", () => {
    const v = adversarialSignVeto(hedgy, { status: "ok", pGivenAnchorWins: 0.35, pGivenAnchorFails: 0.35 });
    expect(v.vetoed).toBe(true);
    expect(v.pGivenAnchorWins).toBeCloseTo(0.35, 6); // mid of primary (0.1+0.6)/2
    expect(v.pGivenAnchorWins).toBe(v.pGivenAnchorFails);
  });

  test("vetoed: adversarial flips the SIGN (fabricated-mechanism case)", () => {
    const v = adversarialSignVeto(hedgy, { status: "ok", pGivenAnchorWins: 0.6, pGivenAnchorFails: 0.2 });
    expect(v.vetoed).toBe(true);
    expect(v.pGivenAnchorWins).toBe(v.pGivenAnchorFails);
  });

  test("fail-open: adversarial errored / missing ⇒ primary kept (a blip must not kill every leg)", () => {
    expect(adversarialSignVeto(hedgy, null).vetoed).toBe(false);
    expect(adversarialSignVeto(hedgy, { status: "error" }).vetoed).toBe(false);
    expect(adversarialSignVeto(hedgy, { status: "ok" }).vetoed).toBe(false); // no numbers returned
  });

  test("no-op: primary already ~independent — nothing to defend, nothing to veto", () => {
    const flat = adversarialSignVeto({ pGivenAnchorWins: 0.4, pGivenAnchorFails: 0.41 }, { status: "ok", pGivenAnchorWins: 0.9, pGivenAnchorFails: 0.1 });
    expect(flat.vetoed).toBe(false);
    expect(flat.pGivenAnchorFails).toBe(0.41);
  });

  test("veto-only invariant: output divergence never exceeds the primary's", () => {
    const cases = [
      { status: "ok", pGivenAnchorWins: 0.2, pGivenAnchorFails: 0.5 },
      { status: "ok", pGivenAnchorWins: 0.5, pGivenAnchorFails: 0.5 },
      null,
    ] as const;
    for (const adv of cases) {
      const v = adversarialSignVeto(hedgy, adv as never);
      const dOut = Math.abs(v.pGivenAnchorFails - v.pGivenAnchorWins);
      const dIn = Math.abs(hedgy.pGivenAnchorFails - hedgy.pGivenAnchorWins);
      expect(dOut).toBeLessThanOrEqual(dIn + 1e-12);
    }
  });
});
