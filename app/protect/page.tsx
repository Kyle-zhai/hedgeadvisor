"use client";

import { ArrowSquareOut, MagnifyingGlass, ShieldCheck } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import VenueTag from "@/components/VenueTag";

// Plan a bet you are about to place. The hedge here is POSITIVE-SUM, never a short of your own bet:
// every leg is a standalone positive bet on a DIFFERENT event that tends to pay when your bet does not,
// so ideally both win and at worst one wins. Powered by the same engine as /discover.

type Venue = "polymarket" | "kalshi";
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
  budgetUsd: number;
  spendUsd: number;
  keepIfPrimaryWinsFloorUsd: number;
  modeledLossIfPrimaryFailsUsd: number;
  strictWorstLossIfPrimaryFailsUsd: number;
  allocations: RobustAllocation[];
}
interface DiscoveredRelation {
  market: { id: string; venue: Venue; title: string; marketTitle: string; probYes: number; url: string };
  classifyMethod: "rule" | "llm" | "heuristic";
  relation: { correlation: number; confidence: "high" | "medium" | "low" };
  mechanismGraph?: { mechanismType: string; scope: string };
}
interface DiscoverResult {
  status: "ok" | "ambiguous" | "not_found";
  anchor?: { venue: Venue; title: string; marketTitle: string; probYes: number; url: string };
  relations?: DiscoveredRelation[];
  robustHedge?: RobustHedge;
  candidates?: { title: string }[];
  suggestions?: string[];
  error?: string;
}

const cents = (p: number) => `${(p * 100).toFixed(1)}¢`;
const usd = (x: number) => `$${x.toFixed(2)}`;

export default function ProtectPage() {
  const [query, setQuery] = useState("Spain wins the 2026 World Cup");
  const [stake, setStake] = useState("20");
  const [conservatism, setConservatism] = useState(0.5);
  const [data, setData] = useState<DiscoverResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reqRef = useRef<AbortController | null>(null);

  const run = useCallback(async (q: string, stakeUsd: number, s: number) => {
    if (!q.trim()) return;
    reqRef.current?.abort();
    const controller = new AbortController();
    reqRef.current = controller;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/discover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q.trim(), stakeUsd, conservatism: s, topK: 16 }), signal: controller.signal });
      const json: DiscoverResult = await res.json();
      if (!res.ok) throw new Error(json.error || "Planning failed");
      if (reqRef.current !== controller) return;
      setData(json);
    } catch (e) {
      if (controller.signal.aborted || reqRef.current !== controller) return;
      setErr(e instanceof Error ? e.message : "Planning failed");
      setData(null);
    } finally {
      if (reqRef.current === controller) setLoading(false);
    }
  }, []);

  useEffect(() => {
    run(query, Number(stake) || 20, conservatism);
    return () => reqRef.current?.abort();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  const anchor = data?.anchor;
  const rh = data?.robustHedge;
  const optimalLegs = (rh?.allocations ?? []).filter((a) => a.provenance === "ANALYTIC" || a.provenance === "CALIBRATED");
  const inferredLegs = (rh?.allocations ?? []).filter((a) => a.provenance === "HYPOTHESIS");
  const crossEvent = (data?.relations ?? []).filter((r) => r.classifyMethod === "llm");
  const stakeUsd = Number(stake) || 20;

  return (
    <div className="page">
      <div className="topbar">
        <div><div className="section-kicker">Plan a bet</div><h1 style={{ margin: 0 }}>Plan a bet</h1></div>
        <div className="right"><span className="livebadge"><span className="livedot" /> Live Polymarket + Kalshi</span></div>
      </div>

      <div className="card">
        <p className="sub" style={{ marginTop: 0 }}>
          Enter a bet you are about to place. We price it off the real book, then find positive-sum companion bets:
          standalone positive bets on other events that tend to pay when this one does not. Ideally both win; at worst one wins.
          We never hedge by shorting your own bet.
        </p>
        <form className="formrow" onSubmit={(e) => { e.preventDefault(); run(query, stakeUsd, conservatism); }} style={{ alignItems: "flex-start", gap: 12 }}>
          <label className="combo-label" style={{ flex: 3, minWidth: 260 }}>Bet
            <div className="inputwrap"><span className="pre"><MagnifyingGlass size={15} /></span>
              <input className="has-pre" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. Spain wins the 2026 World Cup" />
            </div>
            <span className="combo-hint">A real outcome on Polymarket or Kalshi.</span>
          </label>
          <label className="combo-label" style={{ flex: 0.8, minWidth: 110 }}>Stake (USD)
            <div className="inputwrap"><input value={stake} onChange={(e) => setStake(e.target.value)} inputMode="decimal" placeholder="20" /></div>
            <span className="combo-hint">Sets the hedge budget.</span>
          </label>
          <label className="combo-label" style={{ flex: 1.4, minWidth: 200 }}>
            Evidence conservatism {conservatism <= 0.33 ? "· aggressive" : conservatism >= 0.8 ? "· conservative" : "· balanced"}
            <div className="range-control"><input type="range" min={0} max={1} step={0.05} value={conservatism} onChange={(e) => { const s = Number(e.target.value); setConservatism(s); run(query, stakeUsd, s); }} /></div>
            <span className="combo-hint">{conservatism <= 0.33 ? "admits inferred cross-event legs" : conservatism >= 0.8 ? "settlement-calibrated only" : "balanced evidence gate"}</span>
          </label>
          <label className="combo-label" style={{ flex: 0 }}>&nbsp;
            <button className="primarybtn" type="submit" disabled={loading}><ShieldCheck size={15} /> Plan</button>
            <span className="combo-hint" aria-hidden>&nbsp;</span>
          </label>
        </form>
      </div>

      {err && <div className="card err">Could not plan this bet: {err}</div>}
      {loading && <div className="card"><span className="muted">Pricing the bet and finding positive-sum companions…</span></div>}
      {data?.status === "ambiguous" && (
        <div className="card"><div className="headline">Which exact market?</div>{data.candidates?.map((c) => <button key={c.title} className="chip" type="button" onClick={() => { setQuery(c.title); run(c.title, stakeUsd, conservatism); }}>{c.title}</button>)}</div>
      )}
      {data?.status === "not_found" && <div className="card err"><div className="headline">No live market matched</div><div className="muted">Try {(data.suggestions ?? ["Spain", "France"]).slice(0, 4).join(", ")}.</div></div>}

      {anchor && (
        <>
          <div className="section-head" style={{ marginTop: 4 }}>
            <div>
              <div className="section-kicker">Your bet</div>
              <h2 style={{ margin: "2px 0 0", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>{anchor.title} <VenueTag venue={anchor.venue} /></h2>
              <p className="sub" style={{ marginTop: 6, marginBottom: 0 }}>{anchor.marketTitle} · YES {cents(anchor.probYes)} · stake {usd(stakeUsd)}</p>
            </div>
            <a className="ghostbtn" target="_blank" rel="noreferrer" href={anchor.url}>Open <ArrowSquareOut size={14} /></a>
          </div>

          <div className="card">
            <p className="sub" style={{ margin: 0 }}>
              This bet is EV-negative by the vig, like every prediction-market position. Placing it is your call. The companions
              below do not short it: each is its own positive bet on a different event, chosen because it tends to pay when this
              one does not. We never recommend buying NO on your own bet.
            </p>
          </div>

          {/* Positive-sum companions, settlement-calibrated (trustworthy). */}
          {rh && (
            <div className="card" style={{ borderColor: rh.status === "RECOMMEND" && optimalLegs.length ? "var(--go)" : "var(--border-strong)" }}>
              <div className="cardtitle">Calibrated companions <span className="hint">settlement-proven cross-event legs only · trustworthy</span></div>
              <p className="sub" style={{ marginTop: 6 }}>{rh.reason}</p>
              {optimalLegs.length > 0 ? (
                <>
                  <div className="metric-strip" style={{ marginTop: 4 }}>
                    <div className="metric"><div className="label">Spend</div><div className="value">{usd(rh.spendUsd)}</div><div className="detail">budget {usd(rh.budgetUsd)}</div></div>
                    <div className="metric"><div className="label">Modeled loss if it fails</div><div className="value pnl-pos">{usd(rh.modeledLossIfPrimaryFailsUsd)}</div><div className="detail">after the companions</div></div>
                    <div className="metric"><div className="label">Strict worst loss</div><div className="value pnl-neg">{usd(rh.strictWorstLossIfPrimaryFailsUsd)}</div><div className="detail">the true floor; a leg can pay $0</div></div>
                    <div className="metric"><div className="label">Kept if it wins</div><div className="value pnl-pos">{usd(rh.keepIfPrimaryWinsFloorUsd)}</div></div>
                  </div>
                  <div className="table-wrap" style={{ marginTop: 8 }}>
                    <table style={{ minWidth: 560 }}>
                      <thead><tr><th>Companion bet</th><th>Provenance</th><th style={{ textAlign: "right" }}>Spend</th><th style={{ textAlign: "right" }}>Pay if it fails</th><th style={{ textAlign: "right" }}>Loss ↓</th></tr></thead>
                      <tbody>{optimalLegs.map((a) => (
                        <tr key={a.candidateId}>
                          <td><strong>{a.side.toUpperCase()}</strong> {a.label} <VenueTag venue={a.venue} short /></td>
                          <td><span className={`badge ${a.provenance === "ANALYTIC" ? "GO" : "PARTIAL"}`}>{a.provenance}</span></td>
                          <td style={{ textAlign: "right" }}>{usd(a.spendUsd)}</td>
                          <td style={{ textAlign: "right" }}>{Math.round(a.effectivePayGivenFail * 100)}%</td>
                          <td style={{ textAlign: "right" }} className="pnl-pos">{usd(a.modeledLossReductionUsd)}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                </>
              ) : (
                <p className="sub" style={{ margin: "8px 0 0" }}>No settlement-calibrated companion yet. The honest answer is to place the bet on its own, or weigh the exploratory layer below at your own risk.</p>
              )}
            </div>
          )}

          {/* Exploratory cross-event companions: model-inferred, low confidence. */}
          {(inferredLegs.length > 0 || crossEvent.length > 0) && (
            <div className="card" style={{ background: "var(--bg-subtle)" }}>
              <div className="cardtitle" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                Exploratory · inferred <span className="badge PARTIAL">LOW CONFIDENCE</span>
              </div>
              <p className="sub" style={{ marginTop: 6, color: "var(--ink-2)" }}>
                Cross-event and cross-domain companions the model surfaced. Not settlement-proven, not guaranteed. For exploration only, not a recommendation.
              </p>
              {inferredLegs.length > 0 && (
                <div className="table-wrap" style={{ marginTop: 4 }}>
                  <table style={{ minWidth: 520 }}>
                    <thead><tr><th>Inferred companion</th><th style={{ textAlign: "right" }}>Spend</th><th style={{ textAlign: "right" }}>Assumed pay if it fails</th></tr></thead>
                    <tbody>{inferredLegs.map((a) => (
                      <tr key={a.candidateId}>
                        <td><strong>{a.side.toUpperCase()}</strong> {a.label} <VenueTag venue={a.venue} short /> <span className="badge PARTIAL">INFERRED</span></td>
                        <td style={{ textAlign: "right" }}>{usd(a.spendUsd)}</td>
                        <td style={{ textAlign: "right", color: "var(--ink-2)" }}>{Math.round(a.effectivePayGivenFail * 100)}%</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
              {crossEvent.length > 0 && (
                <div className="table-wrap" style={{ marginTop: inferredLegs.length > 0 ? 10 : 4 }}>
                  <table style={{ minWidth: 620 }}>
                    <thead><tr><th>Cross-event market</th><th>Mechanism</th><th style={{ textAlign: "right" }}>φ est.</th><th>Conf.</th><th></th></tr></thead>
                    <tbody>{crossEvent.map((r) => (
                      <tr key={r.market.id}>
                        <td><strong>{r.market.title}</strong> <VenueTag venue={r.market.venue} short /><div style={{ color: "var(--ink-2)", fontSize: 12 }}>{r.market.marketTitle} · {cents(r.market.probYes)}</div></td>
                        <td style={{ color: "var(--ink-2)" }}>{r.mechanismGraph?.mechanismType ?? "mechanism"}{r.mechanismGraph?.scope ? ` · ${r.mechanismGraph.scope}` : ""}</td>
                        <td style={{ textAlign: "right", color: "var(--ink-2)" }}>{r.relation.correlation >= 0 ? "+" : ""}{r.relation.correlation.toFixed(2)}</td>
                        <td style={{ color: "var(--ink-2)" }}>{r.relation.confidence === "high" ? "High" : r.relation.confidence === "medium" ? "Med" : "Low"}</td>
                        <td style={{ textAlign: "right" }}><a className="ghostbtn" target="_blank" rel="noreferrer" href={r.market.url}><ArrowSquareOut size={13} /></a></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <div className="disclaimer">
        Not financial advice. Every companion here is positive-sum, never a short of your own bet: each leg is a standalone
        positive bet on a different event that tends to pay when your bet does not, so ideally both win and at worst one wins.
        Calibrated companions are settlement-proven; exploratory ones are model-inferred and low confidence. Every leg adds to
        the strict worst loss because it can pay $0 in a possible state. Placing the primary bet is EV-negative by the vig.
      </div>
    </div>
  );
}
