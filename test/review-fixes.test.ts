import { describe, expect, test } from "vitest";

// The hedge-sizing review-fix tests (depth-clip surfaced; resolved-position short-circuit) covered the
// lib/sizing engine, removed in the 2026-06-21 consolidation. The deep-link sanitization fix remains.
describe("review fix: deep-link slug is sanitized", () => {
  test("strips path-traversal / cross-origin attempts", async () => {
    const { buildMarketDeepLink } = await import("@/lib/execute/deeplink");
    const u = buildMarketDeepLink("..%2f..%2fevil.com");
    expect(u.startsWith("https://polymarket.com/event/")).toBe(true);
    expect(new URL(u).origin).toBe("https://polymarket.com"); // never cross-origin
    expect(u).not.toContain(".."); // no path traversal
    expect(u).not.toContain("%"); // no encoded escapes survive
    expect(u).not.toContain("/evil.com"); // the host fragment isn't a path/host
  });
});
