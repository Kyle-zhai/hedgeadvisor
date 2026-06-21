import { describe, expect, test } from "vitest";
import { L2_ENABLED, l2Guard, l2NotImplemented } from "@/lib/execute";

describe("L2 execution stays GATED (no live money path without sign-off)", () => {
  test("L2 is disabled by default (feature flag off)", () => {
    expect(L2_ENABLED).toBe(false);
  });

  test("l2Guard fails closed even if a US user / counsel flags were somehow set", () => {
    const g = l2Guard({ isUsUser: false, counselSignedOff: true, tosCleared: true });
    expect(g.enabled).toBe(false); // flag is off → still blocked
    expect(g.blockers.some((b) => b.includes("HEDGE_L2_ENABLED"))).toBe(true);
  });

  test("US users are always blocked from L2-on-global", () => {
    const g = l2Guard({ isUsUser: true });
    expect(g.enabled).toBe(false);
    expect(g.blockers.some((b) => b.toLowerCase().includes("us user"))).toBe(true);
  });

  test("the L2 signing path is intentionally not implemented (throws)", () => {
    expect(() => l2NotImplemented()).toThrow(/gated/i);
  });
});
