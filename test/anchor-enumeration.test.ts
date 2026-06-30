import { describe, it, expect } from "vitest";
import { selectIndexAnchors, type IndexAnchorRow } from "@/lib/relate/anchorEnumeration";

const row = (eventKey: string, category: string, venue = "polymarket"): IndexAnchorRow => ({
  venue, eventKey, title: `${eventKey} title`, marketTitle: `${eventKey} market`, category,
});

describe("selectIndexAnchors (Block A radar)", () => {
  it("drops non-Polymarket rows (Kalshi can't anchor today)", () => {
    const jobs = selectIndexAnchors([row("e1", "a"), row("e2", "a", "kalshi")], { limit: 10 });
    expect(jobs.map((j) => j.eventSlug)).toEqual(["e1"]);
  });

  it("dedupes by eventKey (one anchor per event)", () => {
    const jobs = selectIndexAnchors([row("e1", "a"), row("e1", "a"), row("e2", "a")], { limit: 10 });
    expect(jobs.map((j) => j.eventSlug).sort()).toEqual(["e1", "e2"]);
  });

  it("diversifies across categories (round-robin, not all from one)", () => {
    const rows = [
      row("a1", "A"), row("a2", "A"), row("a3", "A"),
      row("b1", "B"), row("b2", "B"), row("b3", "B"),
      row("c1", "C"), row("c2", "C"), row("c3", "C"),
    ];
    const jobs = selectIndexAnchors(rows, { limit: 6 });
    const cats = new Set(jobs.map((j) => j.eventSlug[0])); // first char encodes category
    expect(jobs).toHaveLength(6);
    expect(cats).toEqual(new Set(["a", "b", "c"]));
  });

  it("derives a topic bucket from the slug when category is empty (PM has no category)", () => {
    const rows: IndexAnchorRow[] = [
      { venue: "polymarket", eventKey: "fifwc-arg-cvi", title: "t", marketTitle: "wc1", category: "" },
      { venue: "polymarket", eventKey: "fifwc-bra-ger", title: "t", marketTitle: "wc2", category: "" },
      { venue: "polymarket", eventKey: "bitcoin-150k", title: "t", marketTitle: "btc", category: "" },
      { venue: "polymarket", eventKey: "fed-march-cut", title: "t", marketTitle: "fed", category: "" },
    ];
    const jobs = selectIndexAnchors(rows, { limit: 3 });
    const topics = jobs.map((j) => j.eventSlug.split("-")[0]);
    expect(new Set(topics).size).toBe(3); // fifwc / bitcoin / fed — not 2 World-Cup variants
  });

  it("rotates the slice by offset (coverage moves across runs)", () => {
    const rows = [row("e1", "A"), row("e2", "A"), row("e3", "A")];
    const a = selectIndexAnchors(rows, { limit: 1, offset: 0 });
    const b = selectIndexAnchors(rows, { limit: 1, offset: 1 });
    expect(a[0].eventSlug).toBe("e1");
    expect(b[0].eventSlug).toBe("e2");
  });

  it("sweeps distinct slices across many single-event topic buckets (full-index case)", () => {
    // 30 distinct topics, one event each — within-bucket rotation is a no-op, so the sweep must come from
    // rotating the bucket VISIT order by the offset.
    const rows: IndexAnchorRow[] = Array.from({ length: 30 }, (_, i) => row(`topic${i}-ev`, ""));
    const a = selectIndexAnchors(rows, { limit: 5, offset: 0 });
    const b = selectIndexAnchors(rows, { limit: 5, offset: 5 });
    const overlap = a.filter((x) => b.some((y) => y.eventSlug === x.eventSlug)).length;
    expect(overlap).toBe(0); // disjoint slice ⇒ real coverage movement
  });

  it("is bounded by limit and safe on empty / zero", () => {
    expect(selectIndexAnchors([], { limit: 5 })).toEqual([]);
    expect(selectIndexAnchors([row("e1", "a")], { limit: 0 })).toEqual([]);
    const jobs = selectIndexAnchors([row("e1", "a"), row("e2", "a"), row("e3", "a")], { limit: 2 });
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toEqual({ query: "e1 market", eventSlug: "e1", topK: 4 });
  });
});
