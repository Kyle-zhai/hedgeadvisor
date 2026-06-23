"use client";

import { ArrowSquareOut, ShieldCheck, MagnifyingGlass } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import VenueTag from "@/components/VenueTag";
import { PayoffChart } from "@/components/SignalCharts";

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
interface HedgeStrategy {
  marketId: string; venue: Venue; title: string; marketTitle: string; probYes: number; url: string;
  side: "YES" | "NO"; legPrice: number; phi: number; pGivenFails: number; pGivenWins: number;
  confidence: number; costUsd: number; expectedReductionUsd: number; hedgedLossUsd: number; keptIfWinUsd: number; mechanism: string;
}
interface HedgeComboLeg {
  marketId: string; venue: Venue; title: string; marketTitle: string; url: string;
  side: "YES" | "NO"; legPrice: number; pGivenFails: number; costUsd: number; mechanism: string;
  dimension?: string; scope?: string;
}
interface HedgeCombo {
  legs: HedgeComboLeg[]; coverage: number; totalCostUsd: number;
  expectedReductionUsd: number; hedgedLossUsd: number; keptIfWinUsd: number; rationale: string;
}
interface DiscoverResult {
  status: "ok" | "ambiguous" | "not_found";
  strategies?: HedgeStrategy[];
  combos?: HedgeCombo[];
  anchor?: { venue: Venue; title: string; marketTitle: string; probYes: number; url: string };
  relations?: DiscoveredRelation[];
  robustHedge?: RobustHedge;
  universeSize?: number;
  semanticRecall?: boolean;
  candidates?: { title: string; score: number }[];
  eventSlug?: string;
  mode?: "outcome" | "event";
  disambiguatedTo?: string;
  suggestions?: string[];
  llm?: { classification?: { candidates?: number; rule?: number; llm?: number; heuristic?: number } };
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

  const run = useCallback(async (q: string, s: number, slug?: string) => {
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
          ...(slug ? { eventSlug: slug } : {}),
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Calibrated/structural legs only appear in the optimizer result (the trustworthy OPTIMAL card).
  const optimalLegs = useMemo(() => (data?.robustHedge?.allocations ?? []).filter((a) => a.provenance === "ANALYTIC" || a.provenance === "CALIBRATED"), [data]);
  const structuralRels = useMemo(() => (data?.relations ?? []).filter((r) => r.classifyMethod !== "llm"), [data]);
  const rh = data?.robustHedge;
  const hasHedge = optimalLegs.length > 0; // calibrated, trustworthy legs drive the OPTIMAL verdict
  const stakeNum = Number(stakeUsd) > 0 ? Number(stakeUsd) : 20;
  const anchorPrice = anchor?.probYes ?? 0.5;
  const baseWinnings = stakeNum * (1 - anchorPrice) / Math.max(0.01, anchorPrice); // unhedged upside if the bet wins
  const currentMaxLoss = stakeNum; // unhedged: you lose your stake if the bet fails
  // OPTIMAL card metrics, calibrated only, NOT affected by an exploratory selection.
  const calHedgedLoss = rh?.modeledLossIfPrimaryFailsUsd ?? stakeNum;
  const calSpend = rh?.spendUsd ?? 0;
  const calKept = rh?.keepIfPrimaryWinsFloorUsd ?? baseWinnings;
  const noActionReason = rh?.reason ?? "No candidate qualified after the evidence, uncertainty, price, and liquidity gates.";

  // Cross-event hedge COMBOS come from the SERVER (data.combos). Each combo bundles 1–4 complementary legs;
  // each leg's correlation is the elicited conditional-probability signed φ (~96% held-out sign accuracy),
  // NOT a keyword label, and the payoff is priced from those real conditionals. selectedId holds the combo
  // index as a string ("0".."3"); null = Hold.
  const combos = useMemo(() => data?.combos ?? [], [data]);
  const selected = selectedId != null ? combos[Number(selectedId)] ?? null : null;

  // Curve/summary use the selected combo when chosen, else the unhedged baseline. The server gates each leg
  // to expected cut > 0, so the protected line is never strictly below the unhedged line.
  const actHedgedLoss = selected?.hedgedLossUsd ?? stakeNum;
  const actKept = selected?.keptIfWinUsd ?? baseWinnings;
  const payoffData = [0, 0.25, 0.5, 0.75, 1].map((p) => ({
    probability: `${Math.round(p * 100)}%`,
    unprotected: Number((p * baseWinnings - (1 - p) * stakeNum).toFixed(2)),
    protected: Number((p * actKept - (1 - p) * actHedgedLoss).toFixed(2)),
  })).map((point) => ({
    ...point,
    delta: Number((point.protected - point.unprotected).toFixed(2)),
  }));

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
        <div className="card">
          <div className="headline">{data.mode === "event" ? "Pick the outcome you are betting on" : "Which exact market?"}</div>
          {data.mode === "event" && <p className="sub" style={{ marginTop: 4 }}>That is the name of the whole event. Choose the specific outcome you hold, most likely first.</p>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
            {data.candidates?.map((c) => <button key={c.title} className="chip" type="button" onClick={() => { setQuery(c.title); run(c.title, conservatism, data.eventSlug); }}>{c.title}</button>)}
          </div>
        </div>
      )}
      {data?.status === "not_found" && <div className="card err"><div className="headline">No live market matched</div><div className="muted">Try {(data.suggestions ?? ["France", "Spain"]).slice(0, 4).join(", ")}.</div></div>}

      {anchor && (
        <>
          {data?.disambiguatedTo && (
            <div className="note-box" style={{ marginTop: 6 }}>
              Your query matched an event, so it was resolved to <strong>{data.disambiguatedTo}</strong>. Not what you meant? Refine the bet text above.
            </div>
          )}
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
              <div className="metric"><div className="label">Hedged max loss</div><div className={`value ${hasHedge ? "pnl-pos" : ""}`}>${calHedgedLoss.toFixed(2)}</div><div className="detail">{hasHedge ? "after the hedge" : "no hedge applied"}</div></div>
              <div className="metric"><div className="label">Hedge spend</div><div className="value">${calSpend.toFixed(2)}</div><div className="detail">{rh ? `budget $${rh.budgetUsd.toFixed(2)}` : "nothing to buy"}</div></div>
              <div className="metric"><div className="label">Kept if you win</div><div className="value pnl-pos">${calKept.toFixed(2)}</div><div className="detail">winnings, after any cost</div></div>
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
                a leg pays more often when your bet fails. It is a designed answer, not a missing result.
              </div>
            )}
            {rh && rh.rejected.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary className="muted">Rejected candidates ({rh.rejected.length}) · why they are not recommended</summary>
                <div style={{ marginTop: 6 }}>{rh.rejected.slice(0, 8).map((r) => <div key={r.candidateId} className="muted" style={{ fontSize: 12 }}>· {r.candidateId}: {r.reason}</div>)}</div>
              </details>
            )}
          </div>

          {/* Intuitive view: the payoff curve (hedged vs unhedged) + a plain-language analysis summary. */}
          <div className="dash2">
            <div className="card">
              <div className="cardtitle" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                Payoff curve
                {selected
                  ? <><span className="badge PARTIAL">MODEL</span><span className="hint" style={{ marginLeft: 0 }}>live prices, assumes the companion pays when your bet fails</span></>
                  : <span className="hint" style={{ marginLeft: 0 }}>P&amp;L vs your bet&apos;s win probability</span>}
              </div>
              <PayoffChart data={payoffData} primaryLabel={selected ? "With combo" : "Your bet"} comparisonLabel="Hold (no hedge)" showDelta={Boolean(selected)} />
              <p className="sub" style={{ marginTop: 8, marginBottom: 0 }}>
                {selected
                  ? `Modeled at today's prices: win and you keep about $${selected.keptIfWinUsd.toFixed(2)} (after $${selected.totalCostUsd.toFixed(2)} spread across ${selected.legs.length} leg${selected.legs.length > 1 ? "s" : ""}); lose and, if a leg pays, you are down about $${actHedgedLoss.toFixed(2)} instead of $${stakeNum.toFixed(2)}.`
                  : "Your bet's payoff with no hedge. Pick a combo below to model how it would reshape this line."}
              </p>
            </div>
            <div className="card">
              <div className="cardtitle">Analysis summary</div>
              <div className="kv"><span className="k">Your bet price (YES)</span><span className="v">{cents(anchor.probYes)}</span></div>
              <div className="kv"><span className="k">Stake at risk</span><span className="v">${stakeNum.toFixed(2)}</span></div>
              <div className="kv"><span className="k">Universe scanned</span><span className="v">{data?.universeSize ?? 0} markets</span></div>
              <div className="kv"><span className="k">Relations classified</span><span className="v">{data?.relations?.length ?? 0}</span></div>
              <div className="kv"><span className="k">Cross-event (LLM)</span><span className="v">{data?.llm?.classification?.llm ?? 0}</span></div>
              <div className="kv"><span className="k">Recall · conservatism</span><span className="v">{data?.semanticRecall ? "Semantic" : "Lexical"} · {conservatism.toFixed(2)}</span></div>
              {selected && (
                <>
                  <div className="kv"><span className="k">Combo</span><span className="v">{selected.legs.length} leg{selected.legs.length > 1 ? "s" : ""} · covers ~{Math.round(selected.coverage * 100)}% of fail states</span></div>
                  <div className="kv"><span className="k">Total hedge cost</span><span className="v">${selected.totalCostUsd.toFixed(2)}</span></div>
                  <div className="kv"><span className="k">Expected downside cut</span><span className="v pnl-pos">${selected.expectedReductionUsd.toFixed(2)}</span></div>
                  <div className="kv"><span className="k">Kept if your bet wins</span><span className="v pnl-pos">${selected.keptIfWinUsd.toFixed(2)}</span></div>
                  <div className="kv"><span className="k">Loss if your bet fails</span><span className="v">${actHedgedLoss.toFixed(2)}</span></div>
                </>
              )}
              <div className="note-box" style={{ marginTop: 9 }}>
                {selected
                  ? "Modeled, not settled: the cost, price and confidence are live, but whether this companion really pays when your bet fails is a model assumption until settled-outcome data proves it."
                  : "Every leg is priced from executable order-book depth (spread, fee, slippage, de-vig)."}
              </div>
            </div>
          </div>

          {/* Hedge COMBOS: each bundles up to 4 complementary legs (each spelled out). Selecting one models
              the payoff curve + summary above. Per-leg correlation = elicited conditional φ; MODELED. */}
          <div className="card" style={{ background: "var(--bg-subtle)" }}>
            <div className="cardtitle" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              Hedge combos <span className="badge PARTIAL">MODELED</span>
              {combos.length > 0 && <span className="hint" style={{ marginLeft: "auto" }}>select one to model its payoff above</span>}
            </div>
            <p className="sub" style={{ marginTop: 6, marginBottom: 13, color: "var(--ink-2)" }}>
              Each combo bundles bets on GENUINELY ORTHOGONAL facets, one per dimension. Total goals, the winning margin and
              the exact score are all the SAME dimension (the scoreline) and never stack. Truly different facets are the ones
              the score does not determine: a red card, the first goal, what the broadcast announcer says, a specific player.
              It prefers a cross-event leg when a different event correlates, else falls back to these same-event facets. When
              a match only has scoreline markets, one leg is the honest answer. Correlation is the elicited conditional φ;
              payoff is modeled from live prices.
            </p>
            {combos.length > 0 ? (
              <div className="strat-list" role="radiogroup" aria-label="Hedge combos">
                <button type="button" role="radio" aria-checked={!selected} className="strat-opt" onClick={() => setSelectedId(null)}>
                  <span className="strat-mark"><span className="strat-dot" /><span className="strat-rank">0</span></span>
                  <span className="strat-body"><span className="strat-title">Hold, no hedge</span><span className="strat-sub">keep your bet exactly as it is</span></span>
                  <span className="strat-metric"><span className="num" style={{ color: "var(--ink-3)" }}>$0</span><span className="lbl">cost</span></span>
                </button>
                {combos.map((c, i) => (
                  <button key={i} type="button" role="radio" aria-checked={selectedId === String(i)} className="strat-opt" style={{ alignItems: "start" }} onClick={() => setSelectedId(String(i))}>
                    <span className="strat-mark" style={{ marginTop: 2 }}><span className="strat-dot" /><span className="strat-rank">{i + 1}</span></span>
                    <span className="strat-body">
                      <span className="strat-title">
                        {c.legs.length === 1 ? "Single-leg hedge" : `Combo of ${c.legs.length} legs`}
                        <span className="combo-tag">covers ~{Math.round(c.coverage * 100)}%</span>
                        <span className="combo-tag">cost ${c.totalCostUsd.toFixed(2)}</span>
                      </span>
                      <span className="combo-legs">
                        {c.legs.map((l) => (
                          <span className="combo-leg" key={l.marketId}>
                            <span className={`strat-buy ${l.side === "YES" ? "yes" : "no"}`}>BUY {l.side}</span>
                            {l.dimension && <span className="combo-dim">{l.dimension}</span>}
                            {l.scope && <span className={`combo-scope${l.scope === "cross-event" ? " cross" : ""}`}>{l.scope === "cross-event" ? "cross-event" : "same-event"}</span>}
                            <span className="combo-leg-name"><strong>{l.title}</strong> <VenueTag venue={l.venue} short /></span>
                            <span className="combo-leg-price">@ {cents(l.legPrice)} · ${l.costUsd.toFixed(2)}</span>
                          </span>
                        ))}
                      </span>
                    </span>
                    <span className="strat-metric" style={{ marginTop: 2 }}><span className="num">${c.expectedReductionUsd.toFixed(2)}</span><span className="lbl">exp. cut</span></span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="note-box" style={{ marginTop: 4 }}>
                No combo of cross-event bets beats simply holding this one. For many bets there is no positive-sum
                hedge: the rival outcomes fail together with your bet. That is the honest answer, not a gap.
              </div>
            )}
          </div>

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
