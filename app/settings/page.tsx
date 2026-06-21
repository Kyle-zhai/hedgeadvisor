"use client";

import { CheckCircle, FloppyDisk, Trash } from "@phosphor-icons/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ANALYSIS_HISTORY_KEY } from "@/lib/client-history";

const SETTINGS_KEY = "hedgeadvisor.settings.v1";

interface Settings {
  livePricing: boolean;
  slippageModel: "linear" | "depth" | "conservative";
  takerFeePct: number;
  defaultOrder: "limit" | "market";
  staleSeconds: number;
  protectionPct: number;
  bankrollWarningPct: number;
  maxComboLegs: number;
  localHistory: boolean;
  retentionDays: number;
  confirmHandoff: boolean;
}

const DEFAULTS: Settings = { livePricing: true, slippageModel: "depth", takerFeePct: 2, defaultOrder: "limit", staleSeconds: 30, protectionPct: 60, bankrollWarningPct: 10, maxComboLegs: 5, localHistory: true, retentionDays: 90, confirmHandoff: true };
const money = (value: number) => `${value < 0 ? "−" : ""}$${Math.abs(value).toFixed(2)}`;

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [service, setService] = useState<{ ok: boolean; latency: number } | null>(null);
  const [livePrice, setLivePrice] = useState<number | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SETTINGS_KEY);
      if (raw) setSettings({ ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) });
    } catch { /* keep defaults */ }
    const start = performance.now();
    fetch("/api/markets?limit=12", { cache: "no-store" }).then((response) => setService({ ok: response.ok, latency: Math.round(performance.now() - start) })).catch(() => setService({ ok: false, latency: Math.round(performance.now() - start) }));
    fetch("/api/protect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "Spain wins the 2026 World Cup", stakeUsd: 100 }) })
      .then((response) => response.json())
      .then((data: { bet?: { price?: number } }) => { if (data.bet?.price) setLivePrice(data.bet.price); })
      .catch(() => {});
  }, []);

  const impact = useMemo(() => {
    const stake = 100;
    const price = livePrice || .5;
    const protectedLoss = stake * (1 - settings.protectionPct / 100);
    const baseHedge = stake - protectedLoss;
    const fee = baseHedge * settings.takerFeePct / 100;
    const slippageRate = settings.slippageModel === "conservative" ? .018 : settings.slippageModel === "linear" ? .01 : .006;
    const slippage = baseHedge * slippageRate;
    const cost = baseHedge * price + fee + slippage;
    const upside = stake * (1 / price - 1) * .1 - cost;
    return { stake, price, protectedLoss, fee, slippage, cost, upside };
  }, [settings, livePrice]);

  const patch = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings((current) => ({ ...current, [key]: value }));
  const save = () => { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); setSavedAt(new Date()); };
  const clearLocalData = () => {
    if (!window.confirm("Clear local analysis history and saved settings on this device?")) return;
    window.localStorage.removeItem(ANALYSIS_HISTORY_KEY);
    window.localStorage.removeItem("hedgeadvisor.plan.history.v1");
    window.localStorage.removeItem(SETTINGS_KEY);
    setSettings(DEFAULTS);
    setSavedAt(new Date());
  };

  return (
    <>
      <div className="topbar"><div className="tabs"><span className="tab active">Settings</span></div><div className="right"><span className="livebadge"><span className="livedot" /> Settings stay on this device</span></div></div>
      <div className="section-head"><div><div className="section-kicker">Runtime policy</div><h1>Settings</h1></div><div className="toolbar"><span className="muted">{savedAt ? `Saved ${savedAt.toLocaleTimeString()}` : "Unsaved changes are local only"}</span><button type="button" onClick={save}><FloppyDisk size={16} /> Save changes</button></div></div>

      <div className="dash2">
        <div>
          <section className="card">
            <div className="cardtitle">Runtime pricing</div>
            <Setting label="Live CLOB pricing" help="Request live public order-book prices for every analysis"><label className="switch"><input type="checkbox" checked={settings.livePricing} onChange={(e) => patch("livePricing", e.target.checked)} /><span /></label></Setting>
            <Setting label="Slippage model" help="Estimate execution impact from displayed market depth"><select value={settings.slippageModel} onChange={(e) => patch("slippageModel", e.target.value as Settings["slippageModel"])}><option value="depth">Depth-aware</option><option value="linear">Linear</option><option value="conservative">Conservative buffer</option></select></Setting>
            <Setting label="Taker fee" help="Fee assumption applied per executed side"><div className="inputwrap"><input value={settings.takerFeePct} type="number" min="0" max="10" step="0.1" onChange={(e) => patch("takerFeePct", Number(e.target.value))} /></div></Setting>
            <Setting label="Default order type" help="Suggested order style for Polymarket handoff"><select value={settings.defaultOrder} onChange={(e) => patch("defaultOrder", e.target.value as Settings["defaultOrder"])}><option value="limit">Limit</option><option value="market">Market</option></select></Setting>
            <Setting label="Stale quote threshold" help="Warn when a quote is older than this threshold"><input type="number" min="5" max="300" value={settings.staleSeconds} onChange={(e) => patch("staleSeconds", Number(e.target.value))} /></Setting>
          </section>

          <section className="card">
            <div className="cardtitle">Risk defaults</div>
            <Setting label="Default protection level" help="Initial downside protection target"><div style={{ width: "100%" }}><input type="range" min="0" max="100" value={settings.protectionPct} onChange={(e) => patch("protectionPct", Number(e.target.value))} /><div className="muted" style={{ textAlign: "right" }}>{settings.protectionPct}%</div></div></Setting>
            <Setting label="Bankroll warning" help="Warn when projected max loss exceeds this share of bankroll"><input type="number" min="1" max="100" value={settings.bankrollWarningPct} onChange={(e) => patch("bankrollWarningPct", Number(e.target.value))} /></Setting>
            <Setting label="Maximum combo legs" help="Hard cap for manually assembled combos"><input type="number" min="2" max="12" value={settings.maxComboLegs} onChange={(e) => patch("maxComboLegs", Number(e.target.value))} /></Setting>
          </section>

          <section className="card">
            <div className="cardtitle">Execution boundary</div>
            <Setting label="Polymarket handoff" help="Approved orders open on Polymarket in a new tab"><strong>Manual deep-link only</strong></Setting>
            <Setting label="Never place orders" help="HedgeAdvisor does not sign, submit, or custody orders"><span className="badge GO">Enforced</span></Setting>
            <Setting label="Confirmation required" help="Require a clear confirmation before opening Polymarket"><label className="switch"><input type="checkbox" checked={settings.confirmHandoff} onChange={(e) => patch("confirmHandoff", e.target.checked)} /><span /></label></Setting>
          </section>

          <section className="card">
            <div className="cardtitle">Data &amp; privacy</div>
            <Setting label="Local history" help="Save completed analyses in this browser only"><label className="switch"><input type="checkbox" checked={settings.localHistory} onChange={(e) => patch("localHistory", e.target.checked)} /><span /></label></Setting>
            <Setting label="Retention window" help="Preferred local retention period"><select value={settings.retentionDays} onChange={(e) => patch("retentionDays", Number(e.target.value))}><option value="30">30 days</option><option value="90">90 days</option><option value="180">180 days</option><option value="365">1 year</option></select></Setting>
            <Setting label="Clear local data" help="Remove analysis history and saved settings from this device"><button className="ghostbtn" type="button" onClick={clearLocalData}><Trash size={15} /> Clear data</button></Setting>
          </section>
        </div>

        <div>
          <section className="card">
            <div className="cardtitle">Current configuration impact <span className="hint">$100 YES position example</span></div>
            <div className="kv"><span className="k">Market</span><span className="v">Spain wins the 2026 World Cup</span></div>
            <div className="kv"><span className="k">Live reference price</span><span className="v">{livePrice ? `${(livePrice * 100).toFixed(1)}¢` : "Loading live price…"}</span></div>
            <div className="kv"><span className="k">Protection level</span><span className="v">{settings.protectionPct}%</span></div>
            <div className="kv"><span className="k">Protected max loss</span><span className="v pnl-neg">{money(impact.protectedLoss)}</span></div>
            <div className="kv"><span className="k">Estimated hedge cost</span><span className="v">{money(impact.cost)}</span></div>
            <div className="kv"><span className="k">Fee assumption</span><span className="v">{money(impact.fee)}</span></div>
            <div className="kv"><span className="k">Slippage assumption</span><span className="v">{money(impact.slippage)}</span></div>
            <div className="kv"><span className="k">Illustrative retained upside</span><span className="v pnl-pos">{money(impact.upside)}</span></div>
          </section>

          <section className="card">
            <div className="cardtitle">Service status</div>
            <div className="kv"><span className="k">Gamma market feed</span><span className="v">{service ? <span className={`badge ${service.ok ? "GO" : "NO_GO"}`}>{service.ok ? "Operational" : "Unavailable"}</span> : "Checking…"}</span></div>
            <div className="kv"><span className="k">Observed latency</span><span className="v">{service ? `${service.latency} ms` : "—"}</span></div>
            <div className="kv"><span className="k">History storage</span><span className="v"><span className="badge GO">Local</span></span></div>
          </section>

          <section className="card">
            <div className="cardtitle">Product stance</div>
            <div className="note-box" style={{ marginTop: 10 }}>Probabilities are market-implied and de-vigged, not forecasts.</div>
            <div className="note-box" style={{ marginTop: 8 }}>Protect buys variance reduction and is normally EV-negative after spread, fees, and vig.</div>
            <div className="note-box" style={{ marginTop: 8 }}>Amplify increases upside and downside. It is never presented as a free edge.</div>
          </section>

          <section className="card"><div className="headline" style={{ marginTop: 0 }}>You confirm on Polymarket.</div><p className="muted">HedgeAdvisor never places orders or holds funds, credentials, or keys.</p><div className="livebadge"><CheckCircle size={16} color="#087345" weight="fill" /> Execution boundary enforced</div></section>
        </div>
      </div>
    </>
  );
}

function Setting({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return <div className="setting-row"><div className="setting-copy"><strong>{label}</strong><span>{help}</span></div><div className="setting-control">{children}</div></div>;
}
