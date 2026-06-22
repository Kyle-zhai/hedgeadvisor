"use client";

import { ArrowClockwise, Funnel, MagnifyingGlass, ShieldCheck } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CategoryBarChart, MarketScatter } from "@/components/SignalCharts";
import VenueTag from "@/components/VenueTag";

interface LiveMarket {
  id: string;
  slug: string;
  title: string;
  outcome: string;
  category: string;
  yesPrice: number;
  change24h: number;
  spread: number;
  liquidity: number;
  volume24h: number;
  volume: number;
  endDate: string | null;
}

const money = (value: number) => value >= 1_000_000 ? `$${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `$${(value / 1_000).toFixed(0)}k` : `$${Math.round(value)}`;
const cents = (value: number) => `${(value * 100).toFixed(1)}¢`;
const signed = (value: number) => `${value >= 0 ? "+" : "−"}${Math.abs(value * 100).toFixed(1)}¢`;

export default function MarketsPage() {
  const [markets, setMarkets] = useState<LiveMarket[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [liquidity, setLiquidity] = useState("0");
  const [maxSpread, setMaxSpread] = useState("100");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pricedAt, setPricedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/markets?limit=72", { cache: "no-store" });
      const data: { markets?: LiveMarket[]; pricedAt?: string; error?: string } = await response.json();
      if (!response.ok) throw new Error(data.error || "Live market request failed");
      setMarkets(data.markets || []);
      setPricedAt(data.pricedAt || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Live market request failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const categories = useMemo(() => ["All", ...Array.from(new Set(markets.map((m) => m.category))).sort()], [markets]);
  const visible = useMemo(() => markets.filter((market) => {
    const matchesText = `${market.title} ${market.outcome}`.toLowerCase().includes(query.trim().toLowerCase());
    const matchesCategory = category === "All" || market.category === category;
    return matchesText && matchesCategory && market.liquidity >= Number(liquidity) && market.spread * 100 <= Number(maxSpread);
  }), [markets, query, category, liquidity, maxSpread]);

  const totalVolume = markets.reduce((sum, market) => sum + market.volume24h, 0);
  const tight = markets.filter((market) => market.spread <= .02).length;
  const spreads = markets.map((market) => market.spread).sort((a, b) => a - b);
  const medianSpread = spreads.length ? spreads[Math.floor(spreads.length / 2)] : 0;
  const categoryData = useMemo(() => {
    const totals = new Map<string, number>();
    markets.forEach((market) => totals.set(market.category, (totals.get(market.category) || 0) + market.volume24h));
    return Array.from(totals, ([name, value]) => ({ name, value: Math.round(value) })).sort((a, b) => b.value - a.value).slice(0, 7);
  }, [markets]);
  const scatterData = useMemo(() => markets.filter((m) => m.liquidity > 0 && m.spread > 0).slice(0, 50).map((m) => ({ liquidity: m.liquidity, spread: Number((m.spread * 100).toFixed(2)), name: m.outcome })), [markets]);

  return (
    <>
      <div className="topbar">
        <div className="tabs"><span className="tab active">Markets</span></div>
        <div className="right"><span className="livebadge"><span className="livedot" /> Live CLOB {pricedAt ? `· ${new Date(pricedAt).toLocaleTimeString()}` : ""}</span></div>
      </div>

      <div className="section-head">
        <div><div className="section-kicker">Live market intelligence</div><h1>Markets</h1></div>
        <button className="ghostbtn" type="button" onClick={load} disabled={loading}><ArrowClockwise size={15} /> {loading ? "Refreshing" : "Refresh"}</button>
      </div>

      <div className="card">
        <div className="filterbar">
          <label>Search<div className="inputwrap"><span className="pre"><MagnifyingGlass size={15} /></span><input className="has-pre" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search market or outcome" /></div></label>
          <label>Category<select value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Minimum liquidity<select value={liquidity} onChange={(e) => setLiquidity(e.target.value)}><option value="0">Any liquidity</option><option value="10000">$10k+</option><option value="100000">$100k+</option><option value="1000000">$1M+</option></select></label>
          <label>Maximum spread<select value={maxSpread} onChange={(e) => setMaxSpread(e.target.value)}><option value="100">Any spread</option><option value="5">5¢ or less</option><option value="2">2¢ or less</option><option value="1">1¢ or less</option></select></label>
          <button className="ghostbtn" type="button" onClick={() => { setQuery(""); setCategory("All"); setLiquidity("0"); setMaxSpread("100"); }}><Funnel size={15} /> Reset</button>
        </div>
      </div>

      <div className="metric-strip">
        <div className="metric"><div className="label">Live markets loaded</div><div className="value">{markets.length}</div><div className="detail">Top open markets by live 24h volume</div></div>
        <div className="metric"><div className="label">24h volume</div><div className="value">{money(totalVolume)}</div><div className="detail">Across the loaded live set</div></div>
        <div className="metric"><div className="label">Tight-spread opportunities</div><div className="value">{tight}</div><div className="detail">Spread at or below 2.0¢</div></div>
        <div className="metric"><div className="label">Median spread</div><div className="value">{cents(medianSpread)}</div><div className="detail">Current bid / ask midpoint gap</div></div>
      </div>

      {error && <div className="card err">Could not load live markets: {error}</div>}

      <div className="card">
        <div className="section-head"><h2>Live market ledger</h2><span className="muted">{visible.length} matching markets</span></div>
        <div className="table-wrap">
          <table style={{ minWidth: 960 }}>
            <thead><tr><th>#</th><th>Market</th><th>Outcome</th><th style={{ textAlign: "right" }}>Yes price</th><th style={{ textAlign: "right" }}>24h change</th><th style={{ textAlign: "right" }}>Spread</th><th style={{ textAlign: "right" }}>Liquidity</th><th style={{ textAlign: "right" }}>24h volume</th><th>Close date</th><th></th></tr></thead>
            <tbody>
              {visible.slice(0, 20).map((market, index) => (
                <tr key={market.id}>
                  <td>{index + 1}</td>
                  <td><strong>{market.title}</strong> <VenueTag venue="polymarket" short /><div className="muted">{market.category}</div></td>
                  <td>{market.outcome}</td>
                  <td style={{ textAlign: "right" }}>{cents(market.yesPrice)}</td>
                  <td style={{ textAlign: "right" }} className={market.change24h >= 0 ? "pnl-pos" : "pnl-neg"}>{signed(market.change24h)}</td>
                  <td style={{ textAlign: "right" }}>{cents(market.spread)}</td>
                  <td style={{ textAlign: "right" }}>{money(market.liquidity)}</td>
                  <td style={{ textAlign: "right" }}>{money(market.volume24h)}</td>
                  <td>{market.endDate ? new Date(market.endDate).toLocaleDateString() : "Open"}</td>
                  <td style={{ textAlign: "right" }}><a className="rowbtn" href={`/hedge?q=${encodeURIComponent(market.outcome)}`}><ShieldCheck size={14} /> Hedge</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="dash2">
        <div className="card"><div className="cardtitle">24h volume by category <span className="hint">real loaded-market volume</span></div><CategoryBarChart data={categoryData} /></div>
        <div className="card"><div className="cardtitle">Market depth quality <span className="hint">liquidity vs spread</span></div><MarketScatter data={scatterData} /></div>
      </div>

      <div className="disclaimer">All rows are requested from Polymarket&apos;s public Gamma API at page load. Prices and spreads can move before execution; HedgeAdvisor never holds funds or keys.</div>
    </>
  );
}
