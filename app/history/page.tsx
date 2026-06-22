"use client";

import { DownloadSimple, MagnifyingGlass, Trash } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { TrendChart } from "@/components/SignalCharts";
import { ANALYSIS_HISTORY_KEY, readAnalysisHistory, type AnalysisHistoryRecord, type AnalysisType } from "@/lib/client-history";

interface LegacyPlan {
  id: string; createdAt: string; query: string; budgetUsd: number; fixtureTitle: string; betDesc: string;
  deployedUsd: number; maxLossUsd: number; maxLegs: number; sliderS: number;
}

const LEGACY_KEY = "hedgeadvisor.plan.history.v1";
const money = (value: number) => `${value < 0 ? "−" : ""}$${Math.abs(value).toFixed(2)}`;

export default function HistoryPage() {
  const [items, setItems] = useState<AnalysisHistoryRecord[]>([]);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"All" | AnalysisType>("All");
  const [status, setStatus] = useState("All");

  useEffect(() => {
    let records = readAnalysisHistory();
    try {
      const legacyRaw = window.localStorage.getItem(LEGACY_KEY);
      const legacy = legacyRaw ? (JSON.parse(legacyRaw) as LegacyPlan[]) : [];
      if (legacy.length) {
        const migrated: AnalysisHistoryRecord[] = legacy.map((plan) => ({
          id: `legacy-${plan.id}`,
          createdAt: plan.createdAt,
          type: "Plan",
          market: plan.fixtureTitle,
          position: plan.betDesc,
          stakeUsd: plan.budgetUsd,
          recommendation: "Built plan",
          maxLossBeforeUsd: plan.budgetUsd,
          maxLossAfterUsd: Math.abs(plan.maxLossUsd),
          estimatedCostUsd: plan.deployedUsd,
          status: "Analyzed",
          href: `/hedge?q=${encodeURIComponent(plan.query)}`,
        }));
        const ids = new Set(records.map((record) => record.id));
        records = [...records, ...migrated.filter((record) => !ids.has(record.id))].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
        window.localStorage.setItem(ANALYSIS_HISTORY_KEY, JSON.stringify(records));
      }
    } catch { /* ignore malformed legacy storage */ }
    setItems(records);
  }, []);

  const filtered = useMemo(() => items.filter((item) => {
    const text = `${item.market} ${item.position} ${item.recommendation}`.toLowerCase();
    return text.includes(query.toLowerCase()) && (type === "All" || item.type === type) && (status === "All" || item.status === status);
  }), [items, query, type, status]);

  const exposure = items.reduce((sum, item) => sum + item.stakeUsd, 0);
  const removed = items.reduce((sum, item) => sum + Math.max(0, item.maxLossBeforeUsd - item.maxLossAfterUsd), 0);
  const cost = items.reduce((sum, item) => sum + item.estimatedCostUsd, 0);
  const trend = useMemo(() => {
    let running = 0;
    return [...items].reverse().map((item) => {
      running += Math.max(0, item.maxLossBeforeUsd - item.maxLossAfterUsd);
      return { label: new Date(item.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }), value: Number(running.toFixed(2)) };
    });
  }, [items]);

  function clearHistory() {
    if (!window.confirm("Clear all local analysis history on this device?")) return;
    window.localStorage.removeItem(ANALYSIS_HISTORY_KEY);
    window.localStorage.removeItem(LEGACY_KEY);
    setItems([]);
  }

  function exportCsv() {
    const header = ["created_at", "type", "market", "position", "stake_usd", "recommendation", "max_loss_before", "max_loss_after", "estimated_cost", "status"];
    const lines = filtered.map((item) => [item.createdAt, item.type, item.market, item.position, item.stakeUsd, item.recommendation, item.maxLossBeforeUsd, item.maxLossAfterUsd, item.estimatedCostUsd, item.status]);
    const csv = [header, ...lines].map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `hedgeadvisor-history-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="topbar">
        <div className="tabs"><span className="tab active">History</span></div>
        <div className="right"><span className="livebadge"><span className="livedot" /> Browser-local analysis ledger</span></div>
      </div>

      <div className="section-head">
        <div><div className="section-kicker">Saved on this device</div><h1>Analysis history</h1></div>
        <div className="toolbar">
          <button className="ghostbtn" type="button" onClick={exportCsv} disabled={!filtered.length}><DownloadSimple size={15} /> Export CSV</button>
          <button className="ghostbtn" type="button" onClick={clearHistory} disabled={!items.length}><Trash size={15} /> Clear history</button>
        </div>
      </div>

      <div className="card">
        <div className="filterbar">
          <label>Search<div className="inputwrap"><span className="pre"><MagnifyingGlass size={15} /></span><input className="has-pre" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search market, position or recommendation" /></div></label>
          <label>Type<select value={type} onChange={(e) => setType(e.target.value as typeof type)}><option>All</option><option>Protect</option><option>Plan</option><option>Combo</option></select></label>
          <label>Status<select value={status} onChange={(e) => setStatus(e.target.value)}><option>All</option><option>Analyzed</option><option>Executed</option></select></label>
        </div>
      </div>

      <div className="metric-strip">
        <div className="metric"><div className="label">Saved analyses</div><div className="value">{items.length}</div><div className="detail">Stored only in this browser</div></div>
        <div className="metric"><div className="label">Protected exposure</div><div className="value">{money(exposure)}</div><div className="detail">Stake analyzed across all records</div></div>
        <div className="metric"><div className="label">Downside removed</div><div className="value pnl-pos">{money(removed)}</div><div className="detail">Before vs after max-loss delta</div></div>
        <div className="metric"><div className="label">Capital deployed</div><div className="value">{money(cost)}</div><div className="detail">Estimated analyzed execution cost</div></div>
      </div>

      {items.length > 0 && <div className="card"><div className="cardtitle">Cumulative downside removed <span className="hint">from saved real analyses</span></div><TrendChart data={trend} label="Downside removed" color="#087345" /></div>}

      <div className="card">
        <div className="section-head"><h2>Saved analysis ledger</h2><span className="muted">{filtered.length} record{filtered.length === 1 ? "" : "s"}</span></div>
        {filtered.length === 0 ? (
          <div className="empty-state"><div><strong>No matching saved analyses</strong><span className="muted">Run Hedge or Combo and completed analysis will appear here automatically.</span></div></div>
        ) : (
          <div className="table-wrap"><table style={{ minWidth: 980 }}>
            <thead><tr><th>Saved</th><th>Type</th><th>Market</th><th>Position</th><th style={{ textAlign: "right" }}>Stake</th><th>Recommendation</th><th style={{ textAlign: "right" }}>Max loss before</th><th style={{ textAlign: "right" }}>Max loss after</th><th style={{ textAlign: "right" }}>Est. cost</th><th>Status</th><th></th></tr></thead>
            <tbody>{filtered.map((item) => <tr key={item.id}>
              <td>{new Date(item.createdAt).toLocaleString()}</td><td><span className={`badge ${item.type === "Protect" ? "GO" : "PARTIAL"}`}>{item.type}</span></td>
              <td><strong>{item.market}</strong></td><td>{item.position}</td><td style={{ textAlign: "right" }}>{money(item.stakeUsd)}</td><td>{item.recommendation}</td>
              <td style={{ textAlign: "right" }} className="pnl-neg">{money(item.maxLossBeforeUsd)}</td><td style={{ textAlign: "right" }} className="pnl-pos">{money(item.maxLossAfterUsd)}</td>
              <td style={{ textAlign: "right" }}>{money(item.estimatedCostUsd)}</td><td><span className="livebadge"><span className="livedot" /> {item.status}</span></td><td style={{ textAlign: "right" }}><a className="rowbtn" href={item.href}>Open</a></td>
            </tr>)}</tbody>
          </table></div>
        )}
      </div>
      <div className="disclaimer">History never leaves this browser. Clearing site data clears this ledger; HedgeAdvisor still has no account or custody layer.</div>
    </>
  );
}
