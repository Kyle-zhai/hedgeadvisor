"use client";

import { ArrowSquareOut, Graph, MagnifyingGlass } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import VenueTag from "@/components/VenueTag";

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
const REL_LABEL: Record<RelationType, string> = { same: "同一", related: "相关", mutually_exclusive: "互斥", independent: "独立" };
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
      <td>{rel.confidence === "high" ? "高" : rel.confidence === "medium" ? "中" : "低"}</td>
      <td className="muted">{r.classifyMethod === "rule" ? "结构规则" : r.classifyMethod === "llm" ? `LLM · ${r.mechanismGraph?.mechanismType ?? "机制"}/${r.mechanismGraph?.scope ?? "未知范围"}` : "启发"}</td>
      <td style={{ textAlign: "right" }}><a className="ghostbtn" target="_blank" rel="noreferrer" href={r.market.url}><ArrowSquareOut size={13} /></a></td>
    </tr>
  );
}

export default function DiscoverPage() {
  const [query, setQuery] = useState("France to win the World Cup");
  // Conservatism s∈[0,1]: 0 = pursue payoff (posterior mean, looser evidence); 1 = control max loss
  // (credible lower bound, strictest evidence, structural-only). Drives the robust optimizer.
  const [conservatism, setConservatism] = useState(0.5);
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
      const res = await fetch("/api/discover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q.trim(), topK: 16, conservatism: s }), signal: controller.signal });
      const json: DiscoverResult = await res.json();
      if (!res.ok) throw new Error(json.error || "Discovery failed");
      if (requestRef.current !== controller) return;
      setData(json);
    } catch (e) {
      if (controller.signal.aborted || requestRef.current !== controller) return;
      setErr(e instanceof Error ? e.message : "Discovery failed");
      setData(null);
    } finally {
      if (requestRef.current === controller) setLoading(false);
    }
  }, []);

  useEffect(() => {
    run(query, conservatism);
    return () => requestRef.current?.abort();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  const anchor = data?.anchor;
  // Two-layer split: trustworthy legs (logically certain or settlement-proven) vs exploratory
  // cross-event mechanisms (model-inferred, never calibrated). Honesty separation is the point.
  const optimalLegs = useMemo(() => (data?.robustHedge?.allocations ?? []).filter((a) => a.provenance === "ANALYTIC" || a.provenance === "CALIBRATED"), [data]);
  const inferredLegs = useMemo(() => (data?.robustHedge?.allocations ?? []).filter((a) => a.provenance === "HYPOTHESIS"), [data]);
  const crossEvent = useMemo(() => (data?.relations ?? []).filter((r) => r.classifyMethod === "llm"), [data]);
  const structuralRels = useMemo(() => (data?.relations ?? []).filter((r) => r.classifyMethod !== "llm"), [data]);
  const inferredSpend = inferredLegs.reduce((s, a) => s + a.spendUsd, 0);

  return (
    <div className="page">
      <div className="topbar">
        <div><div className="section-kicker">Relation engine</div><h1 style={{ margin: 0 }}>Discover relations</h1></div>
        <div className="right"><span className="livebadge"><span className="livedot" /> Live Polymarket + Kalshi</span></div>
      </div>

      <div className="card">
        <p className="sub" style={{ marginTop: 0 }}>
          Enter a bet. The engine builds a live cross-venue market universe, then runs the 5-stage pipeline —
          candidate generation → relation classification → φ correlation, optimal hedge ratio, effectiveness, and confidence —
          and ranks every related market. Structural relations are exact; cross-entity links need embeddings (set an AI key).
        </p>
        <form className="formrow" onSubmit={(e) => { e.preventDefault(); run(query, conservatism); }} style={{ alignItems: "flex-start", gap: 12 }}>
          <label className="combo-label" style={{ flex: 3, minWidth: 280 }}>Bet
            <div className="inputwrap"><span className="pre"><MagnifyingGlass size={15} /></span>
              <input className="has-pre" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. France to win the World Cup" />
            </div>
            <span className="combo-hint">Try “Spain to win the World Cup” or “Mbappe golden boot”.</span>
          </label>
          <label className="combo-label" style={{ flex: 1.8, minWidth: 220 }}>
            Evidence conservatism · 证据保守度 {conservatism <= 0.33 ? "· 进取" : conservatism >= 0.8 ? "· 保守" : "· 平衡"}
            <div className="range-control"><input type="range" min={0} max={1} step={0.05} value={conservatism} onChange={(e) => { const s = Number(e.target.value); setConservatism(s); run(query, s); }} /></div>
            <span className="combo-hint">{conservatism <= 0.33 ? "posterior mean · admits strong-calibrated soft legs" : conservatism >= 0.98 ? "strict posture · structural cover only" : conservatism >= 0.8 ? "credible lower bound · soft legs require separated intervals" : "95% interval · evidence-gated soft legs"} · (does not change the hedge budget)</span>
          </label>
          <label className="combo-label" style={{ flex: 0 }}>&nbsp;
            <button className="primarybtn" type="submit" disabled={loading}><Graph size={15} /> Discover</button>
            <span className="combo-hint" aria-hidden>&nbsp;</span>
          </label>
        </form>
      </div>

      {err && <div className="card err">Could not discover relations: {err}</div>}
      {loading && <div className="card"><span className="muted">Building the cross-venue universe and classifying relations…</span></div>}
      {data?.status === "ambiguous" && (
        <div className="card"><div className="headline">Which exact market?</div>{data.candidates?.map((c) => <button key={c.title} className="chip" type="button" onClick={() => { setQuery(c.title); run(c.title, conservatism); }}>{c.title}</button>)}</div>
      )}
      {data?.status === "not_found" && <div className="card err"><div className="headline">No live market matched</div><div className="muted">Try {(data.suggestions ?? ["France", "Spain"]).slice(0, 4).join(", ")}.</div></div>}

      {anchor && (
        <>
          <div className="section-head" style={{ marginTop: 4 }}>
            <div>
              <div className="section-kicker">Anchor</div>
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

          {/* Layer 1 — the trustworthy, actionable hedge: logically certain or settlement-calibrated only. */}
          {data?.robustHedge && (
            <div className="card" style={{ borderColor: data.robustHedge.status === "RECOMMEND" && optimalLegs.length ? "var(--go)" : "var(--border-strong)" }}>
              <div className="cardtitle">
                Optimal hedge · 最优对冲 <span className="hint">structural + settlement-calibrated legs only · trustworthy, usable today</span>
              </div>
              <p className="sub" style={{ marginTop: 6 }}>{data.robustHedge.reason}</p>
              {optimalLegs.length > 0 ? (
                <>
                  <div className="metric-strip" style={{ marginTop: 4 }}>
                    <div className="metric"><div className="label">Spend</div><div className="value">${data.robustHedge.spendUsd.toFixed(2)}</div><div className="detail">budget ${data.robustHedge.budgetUsd.toFixed(2)}{inferredSpend > 0 ? ` · incl. $${inferredSpend.toFixed(2)} exploratory` : ""}</div></div>
                    <div className="metric"><div className="label">Modeled loss if fails</div><div className="value pnl-pos">${data.robustHedge.modeledLossIfPrimaryFailsUsd.toFixed(2)}</div><div className="detail">after the hedge</div></div>
                    <div className="metric"><div className="label">Strict worst loss</div><div className="value pnl-neg">${data.robustHedge.strictWorstLossIfPrimaryFailsUsd.toFixed(2)}</div><div className="detail">the true floor; soft/inferred legs can pay $0</div></div>
                    <div className="metric"><div className="label">Kept if you win</div><div className="value pnl-pos">${data.robustHedge.keepIfPrimaryWinsFloorUsd.toFixed(2)}</div></div>
                  </div>
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
                </>
              ) : (
                <p className="sub" style={{ margin: "8px 0 0" }}>No structural or settlement-calibrated leg clears its executable cost here. The honest answer is to skip the hedge, or weigh the exploratory layer below at your own risk.</p>
              )}
              {data.robustHedge.rejected.length > 0 && (
                <details style={{ marginTop: 8 }}>
                  <summary className="muted">Rejected candidates ({data.robustHedge.rejected.length}) · why they are not recommended</summary>
                  <div style={{ marginTop: 6 }}>{data.robustHedge.rejected.slice(0, 8).map((r) => <div key={r.candidateId} className="muted" style={{ fontSize: 12 }}>· {r.candidateId}: {r.reason}</div>)}</div>
                </details>
              )}
            </div>
          )}

          {/* Layer 2 — exploratory cross-event mechanisms: model-inferred, never calibrated. Subordinate by design. */}
          {(inferredLegs.length > 0 || crossEvent.length > 0) && (
            <div className="card" style={{ background: "var(--bg-subtle)" }}>
              <div className="cardtitle" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                Exploratory · 探索 · 推理 · 低置信 <span className="badge PARTIAL">LOW CONFIDENCE</span>
              </div>
              <p className="sub" style={{ marginTop: 6, color: "var(--ink-2)" }}>
                Cross-event and cross-domain mechanisms the model surfaced. Not settlement-proven, not guaranteed, and not part of the optimal hedge above. For exploration only. 仅供参考,未经结算校准,不构成对冲建议。
              </p>

              {inferredLegs.length > 0 && (
                <div className="table-wrap" style={{ marginTop: 4 }}>
                  <table style={{ minWidth: 520 }}>
                    <thead><tr><th>Inferred leg in the combo</th><th style={{ textAlign: "right" }}>Spend</th><th style={{ textAlign: "right" }}>Assumed pay if fail</th></tr></thead>
                    <tbody>{inferredLegs.map((a) => (
                      <tr key={a.candidateId}>
                        <td><strong>{a.side.toUpperCase()}</strong> {a.label} <VenueTag venue={a.venue} short /> <span className="badge PARTIAL">推理 INFERRED</span></td>
                        <td style={{ textAlign: "right" }}>${a.spendUsd.toFixed(2)}</td>
                        <td style={{ textAlign: "right", color: "var(--ink-2)" }}>{Math.round(a.effectivePayGivenFail * 100)}%</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}

              {crossEvent.length > 0 && (
                <div className="table-wrap" style={{ marginTop: inferredLegs.length > 0 ? 10 : 4 }}>
                  <table style={{ minWidth: 640 }}>
                    <thead><tr><th>Cross-event market</th><th>Mechanism</th><th style={{ textAlign: "right" }}>φ est.</th><th>Conf.</th><th></th></tr></thead>
                    <tbody>{crossEvent.map((r) => (
                      <tr key={r.market.id}>
                        <td><strong>{r.market.title}</strong> <VenueTag venue={r.market.venue} short /><div style={{ color: "var(--ink-2)", fontSize: 12 }}>{r.market.marketTitle} · {cents(r.market.probYes)}</div></td>
                        <td style={{ color: "var(--ink-2)" }}>{r.mechanismGraph?.mechanismType ?? "机制"}{r.mechanismGraph?.scope ? ` · ${r.mechanismGraph.scope}` : ""}</td>
                        <td style={{ textAlign: "right", color: "var(--ink-2)" }}>{r.relation.correlation >= 0 ? "+" : ""}{r.relation.correlation.toFixed(2)}</td>
                        <td style={{ color: "var(--ink-2)" }}>{r.relation.confidence === "high" ? "高" : r.relation.confidence === "medium" ? "中" : "低"}</td>
                        <td style={{ textAlign: "right" }}><a className="ghostbtn" target="_blank" rel="noreferrer" href={r.market.url}><ArrowSquareOut size={13} /></a></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Descriptive reference: the full structural φ map (not actionable on its own). */}
          {structuralRels.length > 0 && (
            <div className="card">
              <div className="section-head"><h2 style={{ margin: 0 }}>Related markets</h2><span className="muted">descriptive map · structural relations ranked by |φ|</span></div>
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
        Not financial advice. Two layers, read them differently. The OPTIMAL hedge is the trustworthy output: it prices each
        leg off the real book (cost), caps by depth (capacity), and admits a leg only when deterministic structure proves it
        covers every anchor-fail state, or settled-outcome calibration proves it pays more often when the anchor fails
        (uncertainty via credible bounds). The EXPLORATORY layer is low confidence by design: cross-event and cross-domain
        mechanisms are model-inferred, their edge is assumed (not settlement-proven), and they are shown for exploration, never
        as a guarantee. Inferred and soft legs add to the strict worst loss because they can pay $0 in a possible state. The
        Related-markets table is a DESCRIPTIVE map: φ is the binary correlation from the joint P(A and B), exact for structural
        relations and a Fréchet-clamped estimate otherwise; price co-movement is never used as φ.
      </div>
    </div>
  );
}
