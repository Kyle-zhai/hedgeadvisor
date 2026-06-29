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
  provenance: "ANALYTIC" | "CALIBRATED" | "MODELED" | "HYPOTHESIS";
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
  dimension?: string; scope?: string; tier?: "CALIBRATED" | "MODELED"; samples?: number;
}
interface HedgeCombo {
  legs: HedgeComboLeg[]; coverage: number; totalCostUsd: number;
  expectedReductionUsd: number; hedgedLossUsd: number; strictWorstLossUsd?: number; keptIfWinUsd: number; rationale: string;
  tier?: "CALIBRATED" | "MODELED";
}
type Tier = "ANALYTIC" | "CALIBRATED" | "MODELED";
interface SuperposeLeg {
  id: string; marketTitle: string; title: string; side: "YES" | "NO"; q: number;
  pWin: number; pFail: number; dimension: string; costUsd: number; shares: number; edgeWin: number; edgeFail: number; tier?: Tier;
}
interface Superposition {
  direction: number; mode: "aggressive" | "conservative" | "balanced"; legs: SuperposeLeg[];
  totalCostUsd: number; winPnlUsd: number; failPnlUsd: number; nakedWinPnlUsd: number; nakedFailPnlUsd: number;
  strictWorstUsd: number; bestCaseUsd: number; evUsd: number; nakedEvUsd: number; coherent: boolean; tier?: Tier;
}
const tierLabel = (t?: Tier) => t === "ANALYTIC" ? "analytic" : t === "CALIBRATED" ? "calibrated" : "modeled";
interface DiscoverResult {
  status: "ok" | "ambiguous" | "not_found";
  strategies?: HedgeStrategy[];
  combos?: HedgeCombo[];
  directional?: { aggressive: Superposition; conservative: Superposition };
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

type Suggestion = { label: string; value: string; sub?: string; slug: string; kind: string };

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
  // ── Bet autocomplete: live, resolvable positions (outcome/event) from /api/search ──
  const [suggest, setSuggest] = useState<Suggestion[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [sugIdx, setSugIdx] = useState(-1);
  const sugTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sugCtrl = useRef<AbortController | null>(null);

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

  // Debounced live typeahead. Best-effort: never blocks typing or submission.
  const fetchSuggest = (q: string) => {
    if (sugTimer.current) clearTimeout(sugTimer.current);
    if (q.trim().length < 2) { setSuggest([]); setShowSuggest(false); return; }
    sugTimer.current = setTimeout(async () => {
      sugCtrl.current?.abort();
      const ctrl = new AbortController();
      sugCtrl.current = ctrl;
      try {
        const res = await fetch(`/api/search?scope=events&q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal });
        const json = await res.json();
        if (ctrl.signal.aborted) return;
        const list: Suggestion[] = json.suggestions ?? [];
        setSuggest(list); setShowSuggest(list.length > 0); setSugIdx(-1);
      } catch { /* typeahead is best-effort */ }
    }, 160);
  };
  // Selecting a suggestion pins its event (slug) so it resolves to THIS live market — no "no live market".
  const pickSuggest = (s: Suggestion) => {
    setQuery(s.value); setShowSuggest(false); setSuggest([]); setSugIdx(-1);
    run(s.value, conservatism, s.slug);
  };

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
  // Aggressive↔conservative direction knob for the stacked superposition strategy (both come from the server).
  const [direction, setDirection] = useState<"conservative" | "aggressive">("conservative");
  const sup = direction === "aggressive" ? data?.directional?.aggressive : data?.directional?.conservative;
  // The optimizer's admitted legs ARE the recommendation: structural/calibrated (high confidence) AND the
  // engine's MODELED current-ability legs (lower confidence, clearly tiered). The moat raises a leg's tier
  // over time; it does not gate whether the engine recommends.
  const optimalLegs = useMemo(() => (data?.robustHedge?.allocations ?? []).filter((a) => a.provenance === "ANALYTIC" || a.provenance === "CALIBRATED" || a.provenance === "MODELED"), [data]);
  const structuralRels = useMemo(() => (data?.relations ?? []).filter((r) => r.classifyMethod !== "llm"), [data]);
  const rh = data?.robustHedge;
  const hasHedge = optimalLegs.length > 0; // calibrated, trustworthy legs drive the OPTIMAL verdict
  const stakeNum = Number(stakeUsd) > 0 ? Number(stakeUsd) : 20;
  const anchorPrice = anchor?.probYes ?? 0.5;
  const baseWinnings = stakeNum * (1 - anchorPrice) / Math.max(0.01, anchorPrice); // unhedged upside if the bet wins
  const currentMaxLoss = stakeNum; // unhedged: you lose your stake if the bet fails
  // OPTIMAL card metrics, calibrated only, NOT affected by an exploratory selection.
  const calHedgedLoss = rh?.modeledLossIfPrimaryFailsUsd ?? stakeNum;
  // Strict, probability-free worst case: a soft leg can pay $0, so the true floor is higher than the
  // modeled conditional loss. The optimizer already computes it; surface it so "hedged loss" isn't read
  // as a guaranteed cap.
  const calStrictWorst = rh?.strictWorstLossIfPrimaryFailsUsd ?? stakeNum;
  const calSpend = rh?.spendUsd ?? 0;
  const calKept = rh?.keepIfPrimaryWinsFloorUsd ?? baseWinnings;
  const noActionReason = rh?.reason ?? "No candidate qualified after the evidence, uncertainty, price, and liquidity gates.";

  // Cross-event hedge COMBOS come from the SERVER (data.combos). Each combo bundles 1–4 complementary legs;
  // each leg's correlation is the elicited conditional-probability signed φ (NOT a keyword label), and the
  // payoff is priced from those real conditionals. The elicited sign is a low-confidence MODELED signal —
  // the WC-anchor eval (REFOCUS §4) measured only 36% sign accuracy on single-nation champions — which is
  // exactly why every leg is labeled MODELED until settlement calibration promotes it. selectedId holds the
  // combo index as a string ("0".."3"); null = Hold.
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
          both win and at worst one wins. We never hedge by shorting your own bet, and we keep positively-correlated SIDES
          (the side that would fail together with your bet) out of the companion layer; a market that moves with your bet can
          still appear via its opposite (anti-correlated) side.
        </p>
        <form className="formrow" onSubmit={(e) => { e.preventDefault(); run(query, conservatism); }} style={{ alignItems: "flex-start", gap: 12 }}>
          <label className="combo-label" style={{ flex: 3, minWidth: 280 }}>Bet
            <div className="inputwrap"><span className="pre"><MagnifyingGlass size={15} /></span>
              <input className="has-pre" value={query} autoComplete="off" role="combobox" aria-expanded={showSuggest} aria-autocomplete="list"
                onChange={(e) => { setQuery(e.target.value); fetchSuggest(e.target.value); }}
                onFocus={() => { if (suggest.length) setShowSuggest(true); }}
                onBlur={() => window.setTimeout(() => setShowSuggest(false), 150)}
                onKeyDown={(e) => {
                  if (!showSuggest || suggest.length === 0) return;
                  if (e.key === "ArrowDown") { e.preventDefault(); setSugIdx((i) => Math.min(i + 1, suggest.length - 1)); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setSugIdx((i) => Math.max(i - 1, -1)); }
                  else if (e.key === "Enter" && sugIdx >= 0) { e.preventDefault(); pickSuggest(suggest[sugIdx]); }
                  else if (e.key === "Escape") { setShowSuggest(false); }
                }}
                placeholder="e.g. France to win the World Cup" />
              {showSuggest && suggest.length > 0 && (
                <ul className="combo-pop" role="listbox" style={{ listStyle: "none", margin: 0 }}>
                  {suggest.map((s, i) => (
                    <li key={`${s.slug}-${s.value}-${i}`} role="option" aria-selected={i === sugIdx}>
                      <button type="button" className={`suggest-item${i === sugIdx ? " active" : ""}`}
                        onMouseDown={(e) => { e.preventDefault(); pickSuggest(s); }}
                        onMouseEnter={() => setSugIdx(i)}>
                        <span className="s-label">{s.label}</span>
                        {s.sub && <span className="s-sub">{s.sub}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <span className="combo-hint">A real outcome on Polymarket or Kalshi.</span>
          </label>
          <label className="combo-label" style={{ flex: 1.8, minWidth: 220 }}>
            Evidence conservatism {conservatism <= 0.33 ? "· aggressive" : conservatism >= 0.8 ? "· conservative" : "· balanced"}
            <div className="range-control"><input type="range" min={0} max={1} step={0.05} value={conservatism} onChange={(e) => { const s = Number(e.target.value); setConservatism(s); run(query, s); }} /></div>
            <span className="combo-hint">{conservatism <= 0.33 ? "trusts the engine's modeled estimate · recommends to the limit of current ability" : conservatism >= 0.98 ? "strictest · structurally-certain cover only" : conservatism >= 0.8 ? "proven legs only · modeled estimates withheld" : "balanced · admits modeled legs, prefers calibrated/structural"} · (does not change the hedge budget)</span>
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
              Optimal hedge <span className="hint">the engine&apos;s best given current evidence · the tier badge shows how proven each leg is</span>
              {hasHedge
                ? <span className="badge GO" style={{ marginLeft: "auto" }}>RECOMMENDED</span>
                : <span className="badge" style={{ marginLeft: "auto", background: "var(--surface-2,#f4f4f3)", color: "var(--muted)" }}>NO ACTION</span>}
            </div>
            <p className="sub" style={{ marginTop: 6 }}>{hasHedge ? rh?.reason : noActionReason}</p>
            <div className="metric-strip" style={{ marginTop: 4 }}>
              <div className="metric"><div className="label">Current max loss</div><div className="value pnl-neg">${currentMaxLoss.toFixed(2)}</div><div className="detail">unhedged, if your bet fails</div></div>
              <div className="metric"><div className="label">Hedged loss (modeled)</div><div className={`value ${hasHedge ? "pnl-pos" : ""}`}>${calHedgedLoss.toFixed(2)}</div><div className="detail">{hasHedge ? `strict worst $${calStrictWorst.toFixed(2)} · a soft leg can pay $0` : "no hedge applied"}</div></div>
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
                      <td><span className={`badge ${a.provenance === "ANALYTIC" || a.provenance === "CALIBRATED" ? "GO" : "PARTIAL"}`} title={a.provenance === "ANALYTIC" ? "structurally certain" : a.provenance === "CALIBRATED" ? "settlement-proven" : "the model's current estimate — not yet settlement-proven; confidence rises as the moat learns"}>{a.provenance}</span></td>
                      <td style={{ textAlign: "right" }}>${a.spendUsd.toFixed(2)}</td>
                      <td style={{ textAlign: "right" }}>{Math.round(a.effectivePayGivenFail * 100)}%</td>
                      <td style={{ textAlign: "right" }} className="pnl-pos">${a.modeledLossReductionUsd.toFixed(2)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : (
              <div className="note-box" style={{ marginTop: 8 }}>
                {conservatism >= 0.8
                  ? "You are at the strict end of the conservatism slider, which admits only settlement-proven or structurally-certain legs. Lower it to let the engine recommend its current modeled best."
                  : "Even the engine's current modeled estimate found no positive-sum companion that pays more often when your bet fails — for this bet, genuinely nothing beats simply holding it. The Stacked strategy below is the closest exploratory option."}
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
                  <div className="kv"><span className="k">Loss if fail (modeled)</span><span className="v">${actHedgedLoss.toFixed(2)}</span></div>
                  <div className="kv"><span className="k">Strict worst case</span><span className="v" title="your bet fails AND no leg pays: stake plus the whole premium">${(selected.strictWorstLossUsd ?? stakeNum + selected.totalCostUsd).toFixed(2)}</span></div>
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
              a match only has scoreline markets, one leg is the honest answer. Each leg is tagged <strong>modeled</strong> (the
              LLM-elicited prior) or <strong>calibrated</strong> (a settlement-proven posterior, with its sample count); a leg
              upgrades itself from modeled to calibrated as settled outcomes for its template accumulate.
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
                        {c.tier && <span className={`combo-tier ${c.tier === "CALIBRATED" ? "cal" : "mod"}`}>{c.tier === "CALIBRATED" ? "calibrated" : "modeled"}</span>}
                      </span>
                      <span className="combo-legs">
                        {c.legs.map((l) => (
                          <span className="combo-leg" key={l.marketId}>
                            <span className={`strat-buy ${l.side === "YES" ? "yes" : "no"}`}>BUY {l.side}</span>
                            {l.dimension && <span className="combo-dim">{l.dimension}</span>}
                            {l.scope && <span className={`combo-scope${l.scope === "cross-event" ? " cross" : ""}`}>{l.scope === "cross-event" ? "cross-event" : "same-event"}</span>}
                            {l.tier && <span className={`combo-tier ${l.tier === "CALIBRATED" ? "cal" : "mod"}`} title={`${l.samples ?? 0} settled observations back this template`}>{l.tier === "CALIBRATED" ? `calibrated · ${l.samples}` : "modeled"}</span>}
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

          {/* SUPERPOSITION: one stacked strategy with an aggressive↔conservative direction knob. Aggressive
              stacks win-paying legs (higher payoff if your bet wins); conservative stacks fail-paying legs
              (smaller loss if it fails). Both MODELED + EV-negative; the knob reshapes the conditional payoff. */}
          {data?.directional && (
            <div className="card" style={{ background: "var(--bg-subtle)" }}>
              <div className="cardtitle" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                Stacked strategy {sup && sup.legs.length > 0
                  ? <span className={`combo-tier ${sup.tier === "MODELED" ? "mod" : "cal"}`} title={sup.tier === "ANALYTIC" ? "structurally certain — the relation is logically exact, not a model guess" : sup.tier === "CALIBRATED" ? "settlement-proven posterior" : "LLM-elicited prior (low confidence)"}>{tierLabel(sup.tier)}</span>
                  : <span className="badge PARTIAL">MODELED</span>}
                <div role="radiogroup" aria-label="Strategy direction" style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button type="button" role="radio" aria-checked={direction === "conservative"} className={`chip${direction === "conservative" ? " on" : ""}`} onClick={() => setDirection("conservative")}>Conservative · lose less</button>
                  <button type="button" role="radio" aria-checked={direction === "aggressive"} className={`chip${direction === "aggressive" ? " on" : ""}`} onClick={() => setDirection("aggressive")}>Aggressive · win more</button>
                </div>
              </div>
              <p className="sub" style={{ marginTop: 6, marginBottom: 10, color: "var(--ink-2)" }}>
                One stacked bet, two ways to lean. Every leg is conditioned on the SAME pivotal event — your bet&apos;s
                outcome — so the legs are logically related, not a grab bag. {direction === "aggressive"
                  ? "Aggressive stacks bets that pay MORE when your bet wins: higher upside if you are right, a bigger loss if you are wrong."
                  : "Conservative stacks bets that pay when your bet fails: a smaller loss if you are wrong, a little less kept if you are right."}
              </p>
              {sup && sup.legs.length > 0 ? (
                <>
                  <div className="metric-strip" style={{ marginTop: 4 }}>
                    <div className="metric"><div className="label">If your bet WINS</div><div className={`value ${sup.winPnlUsd >= sup.nakedWinPnlUsd ? "pnl-pos" : ""}`}>+${sup.winPnlUsd.toFixed(2)}</div><div className="detail">naked +${sup.nakedWinPnlUsd.toFixed(2)} · best ${sup.bestCaseUsd >= 0 ? "+" : ""}${sup.bestCaseUsd.toFixed(2)}</div></div>
                    <div className="metric"><div className="label">If your bet FAILS</div><div className={`value ${sup.failPnlUsd > sup.nakedFailPnlUsd ? "pnl-pos" : "pnl-neg"}`}>${sup.failPnlUsd.toFixed(2)}</div><div className="detail">naked ${sup.nakedFailPnlUsd.toFixed(2)} · strict worst ${sup.strictWorstUsd.toFixed(2)}</div></div>
                    <div className="metric"><div className="label">Extra staked</div><div className="value">${sup.totalCostUsd.toFixed(2)}</div><div className="detail">{sup.legs.length} leg{sup.legs.length > 1 ? "s" : ""}, stacked</div></div>
                    <div className="metric"><div className="label">EV</div><div className={`value ${sup.evUsd < sup.nakedEvUsd - 0.005 ? "pnl-neg" : ""}`}>${sup.evUsd.toFixed(2)}</div><div className="detail">{sup.evUsd < sup.nakedEvUsd - 0.005 ? "negative — you pay the vig" : "≈ EV of the bet alone"}</div></div>
                  </div>
                  <div className="table-wrap" style={{ marginTop: 8 }}>
                    <table style={{ minWidth: 600 }}>
                      <thead><tr><th>Leg</th><th>Facet</th><th style={{ textAlign: "right" }}>Stake</th><th style={{ textAlign: "right" }}>Price</th><th style={{ textAlign: "right" }}>{direction === "aggressive" ? "Pays if win" : "Pays if fail"}</th></tr></thead>
                      <tbody>{sup.legs.map((l) => (
                        <tr key={l.id}>
                          <td><strong className={`strat-buy ${l.side === "YES" ? "yes" : "no"}`}>BUY {l.side}</strong> {l.title} <VenueTag venue={"polymarket"} short /> <span className={`combo-tier ${l.tier === "MODELED" ? "mod" : "cal"}`}>{tierLabel(l.tier)}</span></td>
                          <td><span className="combo-dim">{l.dimension}</span></td>
                          <td style={{ textAlign: "right" }}>${l.costUsd.toFixed(2)}</td>
                          <td style={{ textAlign: "right" }}>{cents(l.q)}</td>
                          <td style={{ textAlign: "right" }}>{Math.round((direction === "aggressive" ? l.pWin : l.pFail) * 100)}%</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                  <div className="note-box" style={{ marginTop: 9 }}>
                    {sup.tier === "ANALYTIC"
                      ? "Structurally certain: the relationship is logically exact (a champion is a champion from its own continent), so this leg's payoff is not a model guess."
                      : "Modeled, not settled: whether this companion really pays is a model assumption until settlement data proves it."}{" "}
                    {sup.coherent ? `All ${sup.legs.length} leg${sup.legs.length > 1 ? "s" : ""} lean the same way (they ${direction === "aggressive" ? "pay when your bet wins" : "pay when your bet fails"}).` : ""} EV never beats the market — you pay the vig and the opposite outcome gets worse; the knob reshapes the payoff, it does not beat the market.
                  </div>
                </>
              ) : (
                <div className="note-box" style={{ marginTop: 4 }}>
                  No {direction} stacked strategy qualifies for this bet right now: there is no companion market that {direction === "aggressive" ? "reliably pays MORE when your bet wins" : "reliably pays when your bet fails"}. That is the honest answer, not a gap — try the other direction.
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
        A companion must be negatively correlated to qualify; a positively-correlated SIDE is excluded because it fails
        together with your bet (the same market can still qualify on its opposite, anti-correlated side). The OPTIMAL hedge is the
        engine&apos;s best recommendation given what it knows NOW — legs priced off the real book (cost), capped by depth (capacity)
        — and the tier badge is its CONFIDENCE: ANALYTIC (structurally certain) and CALIBRATED (settlement-proven) are trustworthy,
        MODELED is the model&apos;s current estimate (no settlement proof yet). Settlement data TRAINS the engine — it raises a leg&apos;s
        tier over time, it does not decide whether a recommendation appears; raise the conservatism slider to admit proven legs only.
        Every soft leg can still pay $0 in a possible state, and EV is always ≤ the market (you pay the vig). The Related-markets
        table is a DESCRIPTIVE map: φ is the binary correlation from the joint P(A and B), exact for structural relations and a
        Fréchet-clamped estimate otherwise; price co-movement is never used as φ.
      </div>
    </div>
  );
}
