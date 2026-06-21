"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowSquareOut, CheckCircle, Copy, ShieldCheck } from "@phosphor-icons/react";
import VenueTag from "@/components/VenueTag";
import type { ProtectResponse, ProtectStrategy } from "@/lib/hedge";
import type { ComboResult } from "@/lib/combo";
import { PayoffChart } from "@/components/SignalCharts";
import { writeAnalysisHistory } from "@/lib/client-history";

// U+2212 minus, never ASCII hyphen.
const signedUsd = (x: number) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(2)}`;
const usd = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`;
const cents = (p: number) => `${(p * 100).toFixed(1)}¢`;

type FP = ProtectStrategy["frontier"][number];
function atK(frontier: FP[], k: number): FP {
  const pts = [...frontier].sort((a, b) => a.keepFraction - b.keepFraction);
  if (pts.length === 0) return { keepFraction: k, keepIfWinUsd: 0, coveredWorstUsd: 0, lossIfPrimaryFailsUsd: 0, spendUsd: 0, allocUsd: {} };
  if (k <= pts[0].keepFraction) return pts[0];
  if (k >= pts[pts.length - 1].keepFraction) return pts[pts.length - 1];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (k <= b.keepFraction) {
      const t = (k - a.keepFraction) / (b.keepFraction - a.keepFraction || 1);
      const lerp = (x: number, y: number) => x + t * (y - x);
      const lerpOpt = (x?: number, y?: number) => (x == null || y == null ? (x ?? y) : lerp(x, y));
      return {
        keepFraction: k,
        keepIfWinUsd: lerp(a.keepIfWinUsd, b.keepIfWinUsd),
        coveredWorstUsd: lerp(a.coveredWorstUsd, b.coveredWorstUsd),
        lossIfPrimaryFailsUsd: lerp(a.lossIfPrimaryFailsUsd, b.lossIfPrimaryFailsUsd),
        spendUsd: lerp(a.spendUsd, b.spendUsd),
        allocUsd: (t < 0.5 ? a : b).allocUsd, // per-leg $ from the nearer posture (maps don't interpolate)
        cvarBeforeUsd: lerpOpt(a.cvarBeforeUsd, b.cvarBeforeUsd),
        cvarAfterUsd: lerpOpt(a.cvarAfterUsd, b.cvarAfterUsd),
        cvarSpendUsd: lerpOpt(a.cvarSpendUsd, b.cvarSpendUsd),
      };
    }
  }
  return pts[pts.length - 1];
}

export default function ProtectPage() {
  const [query, setQuery] = useState("Spain wins the 2026 World Cup");
  const [betText, setBetText] = useState("Spain wins the 2026 World Cup");
  const [stake, setStake] = useState("20");
  const [sliderV, setSliderV] = useState(-50);
  const [userPick, setUserPick] = useState<string | null>(null); // a clicked strategy (overrides the slider's recommendation, does NOT move the slider)
  const [data, setData] = useState<ProtectResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // amplify: AUTO-discovered causal parlays — bet in B's direction (markets that also win when B wins)
  const [ampStrats, setAmpStrats] = useState<{ name: string; legLabel: string; result: ComboResult }[]>([]);
  const [ampPick, setAmpPick] = useState(0);
  const [ampLoading, setAmpLoading] = useState(false);

  // live bet typeahead (real outcomes as you type)
  const [sugs, setSugs] = useState<{ title: string; sub: string }[]>([]);
  const [sugOpen, setSugOpen] = useState(false);

  const minK = data?.minKeepFraction ?? 0.12;
  const k = sliderV <= 0 ? minK + (1 - minK) * (1 + sliderV / 100) : 1;
  const amplify = sliderV > 3;
  const noHedge = sliderV >= -3 && sliderV <= 3;

  const run = useCallback(async (bet: string, stakeUsd: number) => {
    if (!bet.trim()) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/protect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: bet.trim(), stakeUsd }) });
      const d: ProtectResponse & { error?: string } = await r.json();
      if (!r.ok) throw new Error(d.error ?? "request failed");
      setData(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "something went wrong");
    } finally {
      setLoading(false);
    }
  }, []);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!betText.trim()) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => run(betText, Number(stake) || 20), 220);
    return () => debounce.current ? clearTimeout(debounce.current) : undefined;
  }, [betText, stake, run]);

  function commitBet(v: string) {
    const q = v.trim();
    if (q.length < 3 || q === betText) return;
    setBetText(q);
    setData(null);
    setUserPick(null);
    setAmpStrats([]);
    setAmpPick(0);
  }
  const sugOpenRef = useRef(false);
  sugOpenRef.current = sugOpen;
  const betDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (betDebounce.current) clearTimeout(betDebounce.current);
    // Auto-commit free text only when NO live suggestions are open (otherwise let the user pick one).
    betDebounce.current = setTimeout(() => { if (!sugOpenRef.current) commitBet(query); }, 900);
    return () => betDebounce.current ? clearTimeout(betDebounce.current) : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Prefill from Markets ("Protect →" links pass ?q=<outcome>).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (q && q.trim().length >= 2) {
      setQuery(q.trim());
      commitBet(q.trim());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live bet typeahead: real outcomes (priced) matching what you type, across live events.
  const sugDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || q === betText) {
      setSugs([]);
      setSugOpen(false);
      return;
    }
    const ctrl = new AbortController();
    if (sugDebounce.current) clearTimeout(sugDebounce.current);
    sugDebounce.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?scope=events&q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        const d: { suggestions?: { slug: string }[] } = await r.json();
        const slugs = (d.suggestions ?? []).filter((s) => s.slug).slice(0, 3);
        const evs = await Promise.all(
          slugs.map(async (s) => {
            try {
              const er = await fetch(`/api/event?slug=${encodeURIComponent(s.slug)}`, { signal: ctrl.signal });
              return er.ok ? ((await er.json()) as { title: string; outcomes: { title: string; price: number }[] }) : null;
            } catch {
              return null;
            }
          }),
        );
        const qtokens = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
        const out: { title: string; sub: string }[] = [];
        const seen = new Set<string>();
        for (const ev of evs) {
          if (!ev) continue;
          const evMatch = qtokens.some((t) => ev.title.toLowerCase().includes(t)); // event-keyword query → all its outcomes
          for (const o of ev.outcomes ?? []) {
            const hit = evMatch || qtokens.some((t) => o.title.toLowerCase().includes(t));
            if (hit && !seen.has(o.title + ev.title)) {
              seen.add(o.title + ev.title);
              out.push({ title: o.title, sub: `${ev.title} · ${(o.price * 100).toFixed(1)}¢` });
            }
          }
        }
        if (!ctrl.signal.aborted) {
          setSugs(out.slice(0, 8));
          setSugOpen(out.length > 0);
        }
      } catch {
        /* ignore */
      }
    }, 250);
    return () => {
      ctrl.abort();
      if (sugDebounce.current) clearTimeout(sugDebounce.current);
    };
  }, [query, betText]);

  // AMPLIFY auto-discovery: bet in B's direction. The team that wins the tournament also wins its
  // matches — so we parlay B with each real match the entity plays (causally aligned, priced honestly
  // by the combo engine: independence-assumed, EV negative, flagged). Pre-composed cards, no manual fill.
  useEffect(() => {
    if (!amplify || !data?.bet || !betText) return;
    const entity = data.bet.title.split(/\s+/).slice(0, 2).join(" ");
    const stakeUsd = Number(stake) || 20;
    let cancelled = false;
    const ctrl = new AbortController();
    (async () => {
      setAmpLoading(true);
      try {
        const sr = await fetch(`/api/search?scope=fixtures&q=${encodeURIComponent(entity)}`, { signal: ctrl.signal });
        const sd: { suggestions?: { label: string; value: string }[] } = await sr.json();
        const matches = (sd.suggestions ?? []).filter((m) => m.value).slice(0, 3);
        const built: { name: string; legLabel: string; result: ComboResult }[] = [];
        for (const m of matches) {
          const r = await fetch("/api/combo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ legs: [{ query: betText, side: "yes" }, { query: m.value, side: "yes" }], stakeUsd }), signal: ctrl.signal });
          const d = await r.json();
          if (d?.result && d.result.comboProb > 0) built.push({ name: `${data.bet!.title} + ${m.label}`, legLabel: m.value, result: d.result });
        }
        if (!cancelled) {
          setAmpStrats(built);
          setAmpPick(0);
        }
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setAmpLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amplify, betText, stake, data?.bet?.title]);
  const ampSel = ampStrats[ampPick] ?? ampStrats[0];

  const bet = data?.bet;
  const strategies = data?.strategies ?? [];
  // The slider (conservativeness) DRIVES the recommendation — no clicking. We recommend the strategy
  // with the lowest TRUE worst-case at this posture (= full cover when available); its protection
  // intensity scales as you slide. Partial combos worsen the rare-upset tail, so they are shown as
  // clearly-labeled cheaper-but-riskier alternatives, never the default recommendation.
  const recommended = useMemo(() => {
    if (strategies.length === 0) return undefined;
    return [...strategies].sort((a, b) => atK(a.frontier, k).lossIfPrimaryFailsUsd - atK(b.frontier, k).lossIfPrimaryFailsUsd)[0];
  }, [strategies, k]);
  const selected = strategies.find((s) => s.id === userPick) ?? recommended; // click overrides the recommendation; slider still sets k
  const live = selected && !noHedge && !amplify ? atK(selected.frontier, k) : null;

  // headline numbers
  const keepIfWin = amplify ? ampSel?.result.maxGainUsd ?? 0 : noHedge ? bet?.profitUsd ?? 0 : live?.keepIfWinUsd ?? 0;
  const lossIfFail = amplify ? Math.abs(ampSel?.result.maxLossUsd ?? bet?.stakeUsd ?? 0) : noHedge ? bet?.stakeUsd ?? 0 : live?.lossIfPrimaryFailsUsd ?? 0;
  const coveredWorst = live?.coveredWorstUsd ?? lossIfFail;
  const spend = noHedge || amplify ? 0 : live?.spendUsd ?? 0;
  const scaleMax = Math.max(bet?.profitUsd ?? 1, bet?.stakeUsd ?? 1, keepIfWin, lossIfFail);
  // GREEN only when the TRUE worst case (incl. the rare-upset tail) drops below the no-hedge stake.
  const reduces = !amplify && !noHedge && bet ? lossIfFail < bet.stakeUsd - 0.01 : false;
  const partialCover = !amplify && !noHedge && bet ? coveredWorst < bet.stakeUsd - 0.01 && lossIfFail >= bet.stakeUsd - 0.01 : false;

  const payoffData = useMemo(() => {
    if (!bet) return [];
    return [0, 20, 40, 60, 80, 100].map((probability) => {
      const t = probability / 100;
      return {
        probability: `${probability}%`,
        unprotected: Number((-bet.stakeUsd + t * (bet.stakeUsd + bet.profitUsd)).toFixed(2)),
        protected: Number((-lossIfFail + t * (lossIfFail + keepIfWin)).toFixed(2)),
      };
    });
  }, [bet, keepIfWin, lossIfFail]);

  useEffect(() => {
    if (!bet || !live || !selected || amplify || noHedge) return;
    writeAnalysisHistory({
      id: `protect-${bet.title}-${Date.now()}`,
      createdAt: new Date().toISOString(),
      type: "Protect",
      market: bet.marketTitle,
      position: bet.title,
      stakeUsd: bet.stakeUsd,
      recommendation: selected.name,
      maxLossBeforeUsd: bet.stakeUsd,
      maxLossAfterUsd: live.lossIfPrimaryFailsUsd,
      estimatedCostUsd: live.spendUsd,
      status: "Analyzed",
      href: `/protect?q=${encodeURIComponent(bet.title)}`,
    });
  }, [bet, live, selected, amplify, noHedge]);

  const postureText = useMemo(() => {
    if (!bet) return "";
    if (amplify) return `Amplify (combo): parlay ${bet.title} with other real markets. Win more if it hits, lose more if it does not. Speculative, EV still negative.`;
    if (noHedge) return "No hedge: hold as is. Full upside if it hits, full stake lost if it does not.";
    return `Protect: keep about ${Math.round(k * 100)}% of the profit (at least ${Math.round(minK * 100)}% even at the most conservative, so a win always nets something), and spend the rest to cut the loss if it does not hit.`;
  }, [bet, amplify, noHedge, k, minK]);

  const riskReduction = bet ? Math.max(0, 1 - lossIfFail / bet.stakeUsd) : 0;

  return (
    <>
      <div className="topbar">
        <div className="tabs">
          <button className={`tab${!amplify ? " active" : ""}`} type="button" onClick={() => setSliderV(-50)}>Protect</button>
          <button className={`tab${amplify ? " active" : ""}`} type="button" onClick={() => setSliderV(55)}>Amplify</button>
        </div>
        <div className="right"><span className="livebadge"><span className="livedot" /> {data?.pricesSource === "snapshot" ? "Snapshot pricing" : "Live CLOB"}</span></div>
      </div>

      <div className="card">
        <div className="formrow protect-formrow">
          <label className="combo-label protect-control" style={{ flex: 2.2, minWidth: 280 }}>Position
            <div className="combo">
              <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { commitBet(query); setSugOpen(false); } if (e.key === "Escape") setSugOpen(false); }} onFocus={() => sugs.length > 0 && setSugOpen(true)} onBlur={() => setTimeout(() => setSugOpen(false), 150)} placeholder="Type a live outcome" role="combobox" aria-expanded={sugOpen} />
              {sugOpen && sugs.length > 0 && <div className="combo-pop" role="listbox">{sugs.map((s, i) => <div key={i} className="combo-opt" role="option" aria-selected={false} onMouseDown={() => { setQuery(s.title); commitBet(s.title); setSugOpen(false); }}><span className="combo-opt-label">{s.title}</span><span className="combo-opt-sub">{s.sub}</span></div>)}</div>}
            </div>
            <span className="combo-hint">{betText ? `Pricing ${betText}` : "Choose a live Polymarket outcome"}</span>
          </label>
          <label className="protect-control">Stake<div className="inputwrap"><span className="pre">$</span><input className="has-pre" value={stake} onChange={(e) => setStake(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" /></div><span className="combo-hint" aria-hidden="true">&nbsp;</span></label>
          <label className="protect-control" style={{ flex: 1.4 }}>Protection level<div className="range-control"><input type="range" min={-100} max={0} value={Math.min(0, sliderV)} onChange={(e) => setSliderV(Number(e.target.value))} /></div><span className="combo-hint">{Math.round(riskReduction * 100)}% downside protected</span></label>
          <button type="button" onClick={() => commitBet(query)} disabled={loading}>{loading ? "Pricing…" : "Analyze"}</button>
        </div>
      </div>

      {err && <div className="card err">Could not price this position: {err}</div>}
      {data?.status === "ambiguous" && <div className="card"><div className="headline">Choose the exact market</div>{data.candidates?.map((candidate) => <button key={candidate.title} className="chip" type="button" onClick={() => { setQuery(candidate.title); commitBet(candidate.title); }}>{candidate.title}</button>)}</div>}
      {data?.status === "not_found" && <div className="card err"><div className="headline">No live market matched</div><div className="muted">Try the exact outcome name shown on Polymarket.</div></div>}
      {loading && !bet && <div className="card"><span className="muted">Walking the live order book…</span></div>}

      {bet && <>
        <div className="section-head"><div><div className="section-kicker">Position analysis</div><h1 style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>{bet.title} <VenueTag venue="polymarket" /></h1><p className="sub" style={{ marginTop: 6, marginBottom: 0 }}>{bet.marketTitle} · YES {cents(bet.price)} · stake {usd(bet.stakeUsd)}</p></div><span className={`badge ${amplify ? "NO_GO" : reduces ? "GO" : "PARTIAL"}`}>{amplify ? "Higher risk" : reduces ? "Protected" : "Partial"}</span></div>

        <div className="metric-strip">
          <div className="metric"><div className="label">Current max loss</div><div className="value pnl-neg">{usd(bet.stakeUsd)}</div><div className="detail">If the position does not win</div></div>
          <div className="metric"><div className="label">Protected max loss</div><div className="value pnl-pos">{usd(lossIfFail)}</div><div className="detail">{Math.round(riskReduction * 100)}% downside removed</div></div>
          <div className="metric"><div className="label">Hedge cost</div><div className="value">{usd(spend)}</div><div className="detail">Estimated live execution cost</div></div>
          <div className="metric"><div className="label">Retained upside</div><div className="value pnl-pos">{usd(keepIfWin)}</div><div className="detail">If the position wins, after cost</div></div>
        </div>

        {!amplify ? <>
          <div className="dash2">
            <div className="card"><div className="cardtitle">Payoff comparison <span className="hint">unprotected vs selected strategy</span></div><PayoffChart data={payoffData} /></div>
            <div>
              <div className="card"><div className="cardtitle">Your target</div><div className="kv"><span className="k">Current max loss</span><span className="v pnl-neg">{usd(bet.stakeUsd)}</span></div><div className="kv"><span className="k">Target max loss</span><span className="v pnl-pos">{usd(lossIfFail)}</span></div><div className="kv"><span className="k">Risk reduction</span><span className="v pnl-pos">{Math.round(riskReduction * 100)}%</span></div><div className="kv"><span className="k">Retained upside</span><span className="v">{usd(keepIfWin)}</span></div></div>
              <div className="card"><div className="cardtitle">Why this works</div><div className="note-box" style={{ marginTop: 9 }}>The selected hedge pays in the states where your position loses, limiting the downside without fully removing the winning payout.</div><div className="kv"><span className="k">Hedge ratio</span><span className="v">{bet.stakeUsd ? `${((spend / bet.stakeUsd) * 100).toFixed(1)}%` : "—"}</span></div><div className="kv"><span className="k">Protected downside</span><span className="v">{usd(Math.max(0, bet.stakeUsd - lossIfFail))}</span></div></div>
              {live && live.cvarBeforeUsd != null && live.cvarAfterUsd != null && (
                <div className="card"><div className="cardtitle">Tail risk · CVaR(10%) <span className="hint">market-implied, not a forecast</span></div>
                  <div className="note-box" style={{ marginTop: 9 }}>Expected loss in your worst 10% of outcomes, weighted by de-vigged probabilities. The maximin above caps the absolute worst case; this is the probability-weighted tail the CVaR optimizer minimizes.</div>
                  <div className="kv"><span className="k">Unhedged CVaR</span><span className="v pnl-neg">{usd(live.cvarBeforeUsd)}</span></div>
                  <div className="kv"><span className="k">Hedged CVaR</span><span className="v pnl-pos">{usd(live.cvarAfterUsd)}</span></div>
                  <div className="kv"><span className="k">Tail reduction</span><span className="v pnl-pos">{live.cvarBeforeUsd > 0.01 ? `${Math.round((1 - live.cvarAfterUsd / live.cvarBeforeUsd) * 100)}%` : "—"}</span></div>
                  {live.cvarSpendUsd != null && <div className="kv"><span className="k">CVaR-optimal spend</span><span className="v">{usd(live.cvarSpendUsd)}</span></div>}
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="section-head"><h2>Best protection strategies</h2><span className="muted">Ranked from real executable legs</span></div>
            <div className="table-wrap"><table style={{ minWidth: 900 }}><thead><tr><th>Rank</th><th>Strategy</th><th>Coverage</th><th style={{ textAlign: "right" }}>Est. shares</th><th style={{ textAlign: "right" }}>Hedge cost</th><th style={{ textAlign: "right" }}>Max loss after</th><th style={{ textAlign: "right" }}>Loss reduction</th><th>Liquidity</th><th></th></tr></thead><tbody>
              {strategies.map((strategy, index) => {
                const point = atK(strategy.frontier, k);
                const isSelected = selected?.id === strategy.id;
                const shares = strategy.legs.reduce((sum, leg) => sum + ((point.allocUsd[leg.id] || 0) / Math.max(.001, leg.price)), 0);
                const reduction = bet.stakeUsd ? Math.max(0, 1 - point.lossIfPrimaryFailsUsd / bet.stakeUsd) : 0;
                return <tr key={strategy.id} style={isSelected ? { background: "var(--go-bg)" } : undefined}><td>{index + 1}</td><td><strong>{strategy.name}</strong> {index === 0 && <span className="badge GO">Recommended</span>}<div className="muted">{strategy.legs.map((leg) => `${leg.side.toUpperCase()} ${leg.label}`).join(" + ")}</div></td><td>{strategy.full ? "All losing states" : strategy.covers}</td><td style={{ textAlign: "right" }}>{Math.round(shares)}</td><td style={{ textAlign: "right" }}>{usd(point.spendUsd)}</td><td style={{ textAlign: "right" }} className="pnl-pos">{usd(point.lossIfPrimaryFailsUsd)}</td><td style={{ textAlign: "right" }} className="pnl-pos">{Math.round(reduction * 100)}%</td><td>{strategy.legs.some((leg) => leg.price >= .99) ? "Thin" : "Live"}</td><td style={{ textAlign: "right" }}><button className="rowbtn" type="button" onClick={() => setUserPick(strategy.id)}>{isSelected ? "Selected" : "Select"}</button></td></tr>;
              })}
            </tbody></table></div>
          </div>

          {selected && live && <div className="dash2">
            <div className="card"><div className="cardtitle">Execution details — recommended</div>{selected.legs.map((leg) => { const amount = live.allocUsd[leg.id] || 0; return <div className="kv" key={leg.id}><span className="k">Buy {leg.side.toUpperCase()} · {leg.label}</span><span className="v">{cents(leg.price)} · {usd(amount)} · {Math.round(amount / Math.max(.001, leg.price))} shares</span></div>; })}<div className="toolbar" style={{ marginTop: 12 }}><button className="ghostbtn" type="button" onClick={() => navigator.clipboard?.writeText(selected.legs.map((leg) => `Buy ${leg.side.toUpperCase()} ${leg.label} at ${cents(leg.price)} for ${usd(live.allocUsd[leg.id] || 0)}`).join("\n"))}><Copy size={15} /> Copy orders</button>{selected.legs[0]?.deepLink && <a className="primarybtn" target="_blank" rel="noreferrer" href={selected.legs[0].deepLink}>Open on Polymarket <ArrowSquareOut size={15} /></a>}</div></div>
            <div className="card"><div className="cardtitle">Execution boundary</div><div className="headline"><CheckCircle size={17} color="#087345" weight="fill" /> You confirm on Polymarket.</div><p className="muted">Review live prices before placing the selected limit orders. HedgeAdvisor does not place orders or hold funds.</p><div className="kv"><span className="k">Suggested order type</span><span className="v">Limit</span></div><div className="kv"><span className="k">Total estimated cost</span><span className="v">{usd(live.spendUsd)}</span></div></div>
          </div>}
        </> : <div className="card">
          <div className="cardtitle">Amplify strategies <span className="hint">causally aligned real-market combos</span></div>
          <p className="sub" style={{ marginTop: 8 }}>{postureText}</p>
          {ampLoading && <div className="muted">Discovering compatible live markets…</div>}
          <div className="hedge-menu">{ampStrats.map((strategy, index) => <button key={strategy.name} type="button" className="hedge-opt" onClick={() => setAmpPick(index)} style={{ textAlign: "left", color: "var(--ink)", background: index === ampPick ? "var(--warn-bg)" : "var(--surface)", borderColor: index === ampPick ? "var(--warn)" : "var(--border)" }}><div className="legtop"><strong>{strategy.name}</strong><span className="badge NO_GO">High risk</span><span className="muted" style={{ marginLeft: "auto" }}>{strategy.result.payoutMultiple.toFixed(2)}× payout</span></div><div className="muted" style={{ marginTop: 6 }}>All hit: {signedUsd(strategy.result.maxGainUsd)} · miss: {signedUsd(strategy.result.maxLossUsd)} · EV {signedUsd(strategy.result.expectedValueUsd)}</div></button>)}</div>
        </div>}

        <div className="disclaimer">Not financial advice. Probabilities are market-implied, not forecasts. Protect buys variance reduction after spread, fees, and vig; Amplify increases downside. All execution remains on Polymarket.</div>
      </>}
    </>
  );
}
