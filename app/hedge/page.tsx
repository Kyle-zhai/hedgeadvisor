"use client";

import { ArrowSquareOut, ShieldCheck, MagnifyingGlass } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import VenueTag from "@/components/VenueTag";

// The single hedge surface (merged from the former /protect + /discover, 2026-06-21). A hedge here is
// POSITIVE-SUM, never a short of your own bet: each leg is a standalone positive bet on a DIFFERENT
// event that tends to PAY WHEN YOUR BET FAILS, so ideally both win and at worst one wins. Powered by
// discoverRelations (lib/relate + lib/association). Positively-correlated markets (which fail together
// with your bet) are kept OUT of the companion layer; they amplify, they do not hedge.

type Venue = "polymarket" | "kalshi";
type RelationType = "same" | "related" | "mutually_exclusive" | "independent";
interface EventRelation {
  relation: RelationType;
  correlation: number;
  pAB: number;
  frechet: [number, number];
  frechetViolated: boolean;
  hedgeSignal: "same_exposure" | "hedge" | "diversify";
  hedgeRatio: number;
  effectiveness: number;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  method: string;
}
interface DiscoveredRelation {
  market: { id: string; venue: Venue; title: string; marketTitle: string; probYes: number; url: string };
  recall: "structural" | "semantic" | "lexical";
  similarity: number;
  classifyMethod: "rule" | "llm" | "heuristic";
  relation: EventRelation;
  mechanismGraph?: { mechanismType: string; scope: string; timeOrder: string; portability: string };
  hypothesis?: { relation: string; direction: string; mechanism: string; confidence: number; requiresCalibration: boolean };
}
interface RobustAllocation {
  candidateId: string;
  label: string;
  venue: Venue;
  side: "yes" | "no";
  spendUsd: number;
  shares: number;
  effectivePayGivenFail: number;
  modeledLossReductionUsd: number;
  provenance: "ANALYTIC" | "CALIBRATED" | "HYPOTHESIS";
}
interface RobustHedge {
  status: "RECOMMEND" | "NO_ACTION";
  reason: string;
  conservatism: number;
  budgetUsd: number;
  spendUsd: number;
  keepIfPrimaryWinsFloorUsd: number;
  modeledLossIfPrimaryFailsUsd: number;
  strictWorstLossIfPrimaryFailsUsd: number;
  allocations: RobustAllocation[];
  rejected: Array<{ candidateId: string; reason: string }>;
}
interface DiscoverResult {
  status: "ok" | "ambiguous" | "not_found";
  anchor?: { venue: Venue; title: string; marketTitle: string; probYes: number; url: string };
  relations?: DiscoveredRelation[];
  robustHedge?: RobustHedge;
  universeSize?: number;
  semanticRecall?: boolean;
  candidates?: { title: string; score: number }[];
  suggestions?: string[];
  error?: string;
}

const cents = (v: number) => `${Math.round(v * 100)}¢`;
const REL_LABEL: Record<RelationType, string> = { same: "Same", related: "Related", mutually_exclusive: "Exclusive", independent: "Independent" };
const REL_BADGE: Record<RelationType, string> = { same: "PARTIAL", related: "PARTIAL", mutually_exclusive: "GO", independent: "" };

function RelationRow({ r }: { r: DiscoveredRelation }) {
  const rel = r.relation;
  const badge = REL_BADGE[rel.relation];
  return (
    <tr>
      <td>
        <strong>{r.market.title}</strong> <VenueTag venue={r.market.venue} short />
        <div className="muted">{r.market.marketTitle} · {cents(r.market.probYes)}</div>
      </td>
      <td><span className={`badge ${badge}`} style={badge === "" ? { background: "var(--surface-2,#f4f4f3)", color: "var(--muted)" } : undefined}>{REL_LABEL[rel.relation]}</span></td>
      <td style={{ textAlign: "right", color: rel.correlation < 0 ? "var(--go)" : rel.correlation > 0 ? "var(--warn)" : "var(--ink)" }}>{rel.correlation >= 0 ? "+" : ""}{rel.correlation.toFixed(2)}</td>
      <td style={{ textAlign: "right" }}>{Math.round(rel.effectiveness * 100)}%</td>
      <td style={{ textAlign: "right" }}>{rel.hedgeRatio.toFixed(2)}</td>
      <td>{rel.confidence === "high" ? "High" : rel.confidence === "medium" ? "Med" : "Low"}</td>
      <td className="muted">{r.classifyMethod === "rule" ? "Structural rule" : r.classifyMethod === "llm" ? `LLM · ${r.mechanismGraph?.mechanismType ?? "mechanism"}/${r.mechanismGraph?.scope ?? "unknown scope"}` : "Heuristic"}</td>
      <td style={{ textAlign: "right" }}><a className="ghostbtn" target="_blank" rel="noreferrer" href={r.market.url}><ArrowSquareOut size={13} /></a></td>
    </tr>
  );
}

export default function HedgePage() {
  const [query, setQuery] = useState("France to win the World Cup");
  // Conservatism s∈[0,1]: 0 = pursue payoff (posterior mean, looser evidence); 1 = control max loss
  // (credible lower bound, strictest evidence, structural-only). Drives the robust optimizer.
  const [conservatism, setConservatism] = useState(0.5);
  const [stakeUsd, setStakeUsd] = useState("20");
  const [entryPrice, setEntryPrice] = useState("");
  const [data, setData] = useState<DiscoverResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const run = useCallback(async (q: string, s: number) => {
    if (!q.trim()) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setErr(null);
    try {
      const stake = Number(stakeUsd);
      const entry = Number(entryPrice);
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: q.trim(),
          topK: 16,
          conservatism: s,
          stakeUsd: Number.isFinite(stake) && stake > 0 ? stake : 20,
          ...(Number.isFinite(entry) && entry > 0 && entry < 1 ? { entryPrice: entry } : {}),
        }),
        signal: controller.signal,
      });
      const json: DiscoverResult = await res.json();
      if (!res.ok) throw new Error(json.error || "Hedge search failed");
      if (requestRef.current !== controller) return;
      setData(json);
    } catch (e) {
      if (controller.signal.aborted || requestRef.current !== controller) return;
      setErr(e instanceof Error ? e.message : "Hedge search failed");
      setData(null);
    } finally {
      if (requestRef.current === controller) setLoading(false);
    }
  }, [entryPrice, stakeUsd]);

  useEffect(() => {
    // Seed the search from ?q= (e.g. the Markets "Hedge" row link or a saved History record).
    const urlQ = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("q")?.trim() : "";
    if (urlQ) setQuery(urlQ);
    run(urlQ || query, conservatism);
    return () => requestRef.current?.abort();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  const anchor = data?.anchor;
  // Only structural or settlement-proven allocations can appear in the optimizer result. LLM
  // hypotheses remain a separate, unsized discovery list.
  const optimalLegs = useMemo(() => (data?.robustHedge?.allocations ?? []).filter((a) => a.provenance === "ANALYTIC" || a.provenance === "CALIBRATED"), [data]);
  const llmRels = useMemo(() => (data?.relations ?? []).filter((r) => r.classifyMethod === "llm"), [data]);
  const exploratory = useMemo(() => llmRels.filter((r) => r.hypothesis?.direction === "POSITIVE" || r.hypothesis?.direction === "NEGATIVE"), [llmRels]);
  const directionUnknownCount = llmRels.length - exploratory.length;
  const structuralRels = useMemo(() => (data?.relations ?? []).filter((r) => r.classifyMethod !== "llm"), [data]);

  // The recommendation card is ALWAYS rendered when there is an anchor — config when a qualifying
  // hedge exists, an explicit No Action otherwise — so the core area never silently disappears.
  const rh = data?.robustHedge;
  const hasHedge = optimalLegs.length > 0;
  const stakeNum = Number(stakeUsd) > 0 ? Number(stakeUsd) : 20;
  const currentMaxLoss = stakeNum; // unhedged: you lose your stake if the bet fails
  const hedgedMaxLoss = rh?.modeledLossIfPrimaryFailsUsd ?? stakeNum; // = stake when no hedge applies
  const hedgeSpend = rh?.spendUsd ?? 0;
  const keptIfWin = rh?.keepIfPrimaryWinsFloorUsd ?? (anchor ? stakeNum * (1 - anchor.probYes) / Math.max(0.01, anchor.probYes) : 0);
  const noActionReason = rh?.reason ?? "No candidate qualified after the evidence, uncertainty, price, and liquidity gates.";

  return (
    <div className="page">
      <div className="topbar">
        <div><div className="section-kicker">Hedge</div><h1 style={{ margin: 0 }}>Hedge a bet</h1></div>
        <div className="right"><span className="livebadge"><span className="livedot" /> Live Polymarket + Kalshi</span></div>
      </div>

      <div className="card">
        <p className="sub" style={{ marginTop: 0 }}>
          Enter a bet you hold or are about to place. The engine builds a live cross-venue market universe and looks for
          positive-sum companion bets: standalone bets on a DIFFERENT event that tend to pay when your bet does not, so ideally
          both win and at worst one wins. We never hedge by shorting your own bet, and we keep positively-correlated markets
          (which would fail together with it) out of the companion layer.
        </p>
        <form className="formrow" onSubmit={(e) => { e.preventDefault(); run(query, conservatism); }} style={{ alignItems: "flex-start", gap: 12 }}>
          <label className="combo-label" style={{ flex: 3, minWidth: 280 }}>Bet
            <div className="inputwrap"><span className="pre"><MagnifyingGlass size={15} /></span>
              <input className="has-pre" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. France to win the World Cup" />
            </div>
            <span className="combo-hint">A real outcome on Polymarket or Kalshi.</span>
          </label>
          <label className="combo-label" style={{ flex: 1.8, minWidth: 220 }}>
            Evidence conservatism {conservatism <= 0.33 ? "· aggressive" : conservatism >= 0.8 ? "· conservative" : "· balanced"}
            <div className="range-control"><input type="range" min={0} max={1} step={0.05} value={conservatism} onChange={(e) => { const s = Number(e.target.value); setConservatism(s); run(query, s); }} /></div>
            <span className="combo-hint">{conservatism <= 0.33 ? "posterior mean · admits strong-calibrated soft legs" : conservatism >= 0.98 ? "strict posture · structural cover only" : conservatism >= 0.8 ? "credible lower bound · soft legs require separated intervals" : "95% interval · evidence-gated soft legs"} · (does not change the hedge budget)</span>
          </label>
          <label className="combo-label" style={{ flex: 0.8, minWidth: 110 }}>Stake USD
            <input value={stakeUsd} onChange={(e) => setStakeUsd(e.target.value)} inputMode="decimal" aria-label="Position cost in USD" />
            <span className="combo-hint">Your actual cost.</span>
          </label>
          <label className="combo-label" style={{ flex: 0.8, minWidth: 110 }}>Avg entry
            <input value={entryPrice} onChange={(e) => setEntryPrice(e.target.value)} inputMode="decimal" placeholder="current" aria-label="Average entry price" />
            <span className="combo-hint">0–1; blank uses current.</span>
          </label>
          <label className="combo-label" style={{ flex: 0 }}>&nbsp;
            <button className="primarybtn" type="submit" disabled={loading}><ShieldCheck size={15} /> Hedge</button>
            <span className="combo-hint" aria-hidden>&nbsp;</span>
          </label>
        </form>
      </div>

      {err && <div className="card err">Could not search for hedges: {err}</div>}
      {loading && <div className="card"><span className="muted">Building the cross-venue universe and ranking companion bets…</span></div>}
      {data?.status === "ambiguous" && (
        <div className="card"><div className="headline">Which exact market?</div>{data.candidates?.map((c) => <button key={c.title} className="chip" type="button" onClick={() => { setQuery(c.title); run(c.title, conservatism); }}>{c.title}</button>)}</div>
      )}
      {data?.status === "not_found" && <div className="card err"><div className="headline">No live market matched</div><div className="muted">Try {(data.suggestions ?? ["France", "Spain"]).slice(0, 4).join(", ")}.</div></div>}

      {anchor && (
        <>
          <div className="section-head" style={{ marginTop: 4 }}>
            <div>
              <div className="section-kicker">Your bet</div>
              <h2 style={{ margin: "2px 0 0", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>{anchor.title} <VenueTag venue={anchor.venue} /></h2>
              <p className="sub" style={{ marginTop: 6, marginBottom: 0 }}>{anchor.marketTitle} · YES {cents(anchor.probYes)}</p>
            </div>
            <a className="ghostbtn" target="_blank" rel="noreferrer" href={anchor.url}>Open <ArrowSquareOut size={14} /></a>
          </div>

          <div className="metric-strip">
            <div className="metric"><div className="label">Universe</div><div className="value">{data?.universeSize}</div><div className="detail">live markets, both venues</div></div>
            <div className="metric"><div className="label">Relations</div><div className="value">{data?.relations?.length ?? 0}</div><div className="detail">classified pairs</div></div>
            <div className="metric"><div className="label">Recall</div><div className="value" style={{ fontSize: 18 }}>{data?.semanticRecall ? "Semantic" : "Lexical"}</div><div className="detail">{data?.semanticRecall ? "embeddings on" : "set an AI key for embeddings"}</div></div>
          </div>

          {/* Layer 1 — the trustworthy hedge recommendation. ALWAYS rendered: config when a qualifying
              calibrated/structural hedge exists, an explicit No Action otherwise, so the core
              recommendation area never silently disappears. */}
          <div className="card" style={{ borderColor: hasHedge ? "var(--go)" : "var(--border-strong)" }}>
            <div className="cardtitle" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              Optimal hedge <span className="hint">settlement-calibrated cross-event legs only · trustworthy</span>
              {hasHedge
                ? <span className="badge GO" style={{ marginLeft: "auto" }}>RECOMMENDED</span>
                : <span className="badge" style={{ marginLeft: "auto", background: "var(--surface-2,#f4f4f3)", color: "var(--muted)" }}>NO ACTION</span>}
            </div>
            <p className="sub" style={{ marginTop: 6 }}>{hasHedge ? rh?.reason : noActionReason}</p>
            <div className="metric-strip" style={{ marginTop: 4 }}>
              <div className="metric"><div className="label">Current max loss</div><div className="value pnl-neg">${currentMaxLoss.toFixed(2)}</div><div className="detail">unhedged, if your bet fails</div></div>
              <div className="metric"><div className="label">Hedged max loss</div><div className={`value ${hasHedge ? "pnl-pos" : ""}`}>${hedgedMaxLoss.toFixed(2)}</div><div className="detail">{hasHedge ? "after the hedge" : "no hedge applied"}</div></div>
              <div className="metric"><div className="label">Hedge spend</div><div className="value">${hedgeSpend.toFixed(2)}</div><div className="detail">{rh ? `budget $${rh.budgetUsd.toFixed(2)}` : "nothing to buy"}</div></div>
              <div className="metric"><div className="label">Kept if you win</div><div className="value pnl-pos">${keptIfWin.toFixed(2)}</div><div className="detail">winnings, after any cost</div></div>
            </div>
            {hasHedge ? (
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table style={{ minWidth: 560 }}>
                  <thead><tr><th>Leg</th><th>Provenance</th><th style={{ textAlign: "right" }}>Spend</th><th style={{ textAlign: "right" }}>Pay if fail</th><th style={{ textAlign: "right" }}>Loss ↓</th></tr></thead>
                  <tbody>{optimalLegs.map((a) => (
                    <tr key={a.candidateId}>
                      <td><strong>{a.side.toUpperCase()}</strong> {a.label} <VenueTag venue={a.venue} short /></td>
                      <td><span className={`badge ${a.provenance === "ANALYTIC" ? "GO" : "PARTIAL"}`}>{a.provenance}</span></td>
                      <td style={{ textAlign: "right" }}>${a.spendUsd.toFixed(2)}</td>
                      <td style={{ textAlign: "right" }}>{Math.round(a.effectivePayGivenFail * 100)}%</td>
                      <td style={{ textAlign: "right" }} className="pnl-pos">${a.modeledLossReductionUsd.toFixed(2)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : (
              <div className="note-box" style={{ marginTop: 8 }}>
                No settlement-calibrated cross-event hedge qualifies right now, so the honest recommendation is No Action: hold the
                bet as is, or weigh the exploratory layer below at your own risk. This stays empty until settled-outcome data proves
                a leg pays more often when your bet fails — it is a designed answer, not a missing result.
              </div>
            )}
            {rh && rh.rejected.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary className="muted">Rejected candidates ({rh.rejected.length}) · why they are not recommended</summary>
                <div style={{ marginTop: 6 }}>{rh.rejected.slice(0, 8).map((r) => <div key={r.candidateId} className="muted" style={{ fontSize: 12 }}>· {r.candidateId}: {r.reason}</div>)}</div>
              </details>
            )}
          </div>

          {/* Layer 2 — mechanism hypotheses only. They suggest a side to investigate but carry no
              conditional payoff, spend, or loss-reduction claim until historical calibration passes. */}
          {(exploratory.length > 0 || directionUnknownCount > 0) && (
            <div className="card" style={{ background: "var(--bg-subtle)" }}>
              <div className="cardtitle" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                Exploratory · inferred <span className="badge PARTIAL">LOW CONFIDENCE</span>
              </div>
              <p className="sub" style={{ marginTop: 6, color: "var(--ink-2)" }}>
                Cross-event and cross-domain mechanisms surfaced by the model. The side below is a qualitative hypothesis only:
                no payoff probability, spend, or loss reduction is assigned until settled historical evidence passes calibration.
              </p>

              {exploratory.length > 0 && (
                <div className="table-wrap" style={{ marginTop: 4 }}>
                  <table style={{ minWidth: 640 }}>
                    <thead><tr><th>Cross-event market</th><th>Mechanism</th><th>Side to investigate</th><th>Classification confidence</th><th></th></tr></thead>
                    <tbody>{exploratory.map((r) => (
                      <tr key={r.market.id}>
                        <td><strong>{r.market.title}</strong> <VenueTag venue={r.market.venue} short /><div style={{ color: "var(--ink-2)", fontSize: 12 }}>{r.market.marketTitle} · {cents(r.market.probYes)}</div></td>
                        <td style={{ color: "var(--ink-2)" }}>{r.mechanismGraph?.mechanismType ?? "mechanism"}{r.mechanismGraph?.scope ? ` · ${r.mechanismGraph.scope}` : ""}</td>
                        <td>{r.hypothesis?.direction === "POSITIVE" ? "Inspect NO" : "Inspect YES"}</td>
                        <td style={{ color: "var(--ink-2)" }}>{Math.round((r.hypothesis?.confidence ?? 0) * 100)}% · relation label only</td>
                        <td style={{ textAlign: "right" }}><a className="ghostbtn" target="_blank" rel="noreferrer" href={r.market.url}><ArrowSquareOut size={13} /></a></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}

              {directionUnknownCount > 0 && (
                <div className="note-box" style={{ marginTop: exploratory.length > 0 ? 10 : 4 }}>
                  {directionUnknownCount} additional mechanism{directionUnknownCount === 1 ? " has" : "s have"} no defensible payoff direction and therefore no suggested side.
                </div>
              )}
            </div>
          )}

          {/* Descriptive reference: the full structural φ map (not actionable on its own). */}
          {structuralRels.length > 0 && (
            <div className="card">
              <div className="section-head"><h2 style={{ margin: 0 }}>Related markets</h2><span className="muted">descriptive map · structural relations ranked by |φ| · negative φ pays when you fail</span></div>
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table style={{ minWidth: 720 }}>
                  <thead><tr><th>Market</th><th>Relation</th><th style={{ textAlign: "right" }}>φ</th><th style={{ textAlign: "right" }}>Effect.</th><th style={{ textAlign: "right" }}>Hedge ×</th><th>Conf.</th><th>Method</th><th></th></tr></thead>
                  <tbody>{structuralRels.map((r) => <RelationRow key={r.market.id} r={r} />)}</tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <div className="disclaimer">
        Not financial advice. Every hedge here is positive-sum, never a short of your own bet: each leg is a standalone
        positive bet on a different event that tends to pay when your bet does not, so ideally both win and at worst one wins.
        A companion must be negatively correlated to qualify; positively-correlated markets are excluded because they fail
        together with your bet. Two layers, read them differently. The OPTIMAL hedge is the trustworthy output: legs priced off
        the real book (cost), capped by depth (capacity), admitted only when settled-outcome calibration proves the leg pays more
        often when your bet fails (uncertainty via credible bounds). The EXPLORATORY layer is low confidence by design: cross-event
        and cross-domain mechanisms are model-inferred and shown without payoff probabilities or position sizes. Only historical
        settlement calibration can promote one into the optimizer. Every soft leg can still pay $0 in a possible state. The
        Related-markets table is a DESCRIPTIVE map: φ is the binary correlation from the joint P(A and B), exact for structural
        relations and a Fréchet-clamped estimate otherwise; price co-movement is never used as φ.
      </div>
    </div>
  );
}
