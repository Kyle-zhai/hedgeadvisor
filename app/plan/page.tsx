"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, Check } from "@phosphor-icons/react";
import VenueTag from "@/components/VenueTag";
import MarketSearch from "@/components/MarketSearch";
import { ScenarioBarChart } from "@/components/SignalCharts";
import { writeAnalysisHistory } from "@/lib/client-history";
// Canonical wire types (the server serializes these); import rather than re-declare so the
// page can never drift from lib/types.ts. (Type-only import — erased from the client bundle.)
import type { Plan, PlanLeg } from "@/lib/types";

interface PlanResponse {
  status: "ok" | "not_found" | "ambiguous";
  fixtureTitle?: string;
  plan?: Plan;
  suggestions?: { slug: string; title: string }[];
  meta?: { betType: string; pricedAt: string; sliderS: number; note?: string; deVig?: string; fixtureSlug?: string; viewTitle?: string };
  error?: string;
}
// Subset of the hedge-engine response we render in the Protect-end strategy menu.
interface HedgeStratLeg { side: string; outcomeTitle: string; shares: number; limitPrice: number; estPayUsd: number; deepLink: string }
interface HedgeStrat { verdict: "GO" | "PARTIAL" | "NO_GO"; eta: number; facts: Record<string, string>; legs: HedgeStratLeg[] }
interface PlanHistoryItem {
  id: string;
  createdAt: string;
  pricedAt?: string;
  query: string;
  budgetUsd: number;
  maxLegs: number;
  sliderS: number;
  fixtureTitle: string;
  betDesc: string;
  posture: string;
  deployedUsd: number;
  pProfit: number;
  expectedValueUsd: number;
  maxLossUsd: number;
  verdict: Plan["verdict"];
}

// Use the Unicode MINUS SIGN (U+2212), not the ASCII hyphen — the hyphen is a line-break
// opportunity, so "-$0.26" could wrap to "-" / "$0.26" in a narrow cell.
const usd2 = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`;
const signedUsd = (x: number) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(2)}`;
const pct0 = (x: number) => `${x < 0 ? "−" : ""}${Math.round(Math.abs(x) * 100)}%`;
const pct1 = (x: number) => `${x < 0 ? "−" : ""}${(Math.abs(x) * 100).toFixed(1)}%`;
const cents = (p: number) => `${p < 0 ? "−" : ""}${(Math.abs(p) * 100).toFixed(1)}¢`;
const sideLabel = (s: "buy_yes" | "buy_no") => (s === "buy_no" ? "No" : "Yes");
// Trim a trailing "(... vs ...)" qualifier so "Draw (Spain vs. Saudi Arabia)" → "Draw"
// (the fixture is already in the header), keeping the narrow table columns readable.
const shortOutcome = (s: string) => s.replace(/\s*\([^)]*\)\s*$/, "").trim() || s;
const HISTORY_KEY = "hedgeadvisor.plan.history.v1";

const COST = [
  { key: "fairValueUsd", label: "Fair value", color: "#2b66d9" },
  { key: "spreadUsd", label: "Spread", color: "#3aa0a0" },
  { key: "slippageUsd", label: "Slippage", color: "#e08a2b" },
  { key: "takerFeeUsd", label: "Taker fee", color: "#067a46" },
  { key: "vigUsd", label: "Vig / overround", color: "#c0392b" },
] as const;

export default function PlanPage() {
  const hydrated = useRef(false);
  const [query, setQuery] = useState("Spain beats Saudi Arabia");
  const [budget, setBudget] = useState("100");
  const [bets, setBets] = useState(3); // number-of-bets stepper (maxLegs)
  // Default leans Balanced so the first plan shows a real spread (your pick wins big / others
  // lose). Full Protect (s→1) equalizes every outcome to ~breakeven-minus-vig on purpose.
  const [s, setS] = useState(0.45);
  const [res, setRes] = useState<PlanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // At the Protect end of the slider we show a ranked menu of honest hedge strategies for the pick.
  const [hedges, setHedges] = useState<HedgeStrat[] | null>(null);
  const [hedgesLoading, setHedgesLoading] = useState(false);
  const hedgeAbort = useRef<AbortController | null>(null);

  const run = useCallback(
    async (q?: string, slider?: number, legCap?: number, budgetOverride?: string | number) => {
      setLoading(true);
      setErr(null);
      try {
        const budgetUsd = Number(budgetOverride ?? budget) || 20;
        const r = await fetch("/api/plan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: q ?? query,
            budgetUsd,
            sliderS: slider ?? s,
            maxLegs: Math.min(20, Math.max(1, legCap ?? bets)),
          }),
        });
        const data: PlanResponse = await r.json();
        if (!r.ok) throw new Error(data.error ?? "request failed");
        setRes(data);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "something went wrong");
      } finally {
        setLoading(false);
      }
    },
    [query, budget, s, bets],
  );

  // Re-price (debounced) when posture, budget, or number of bets changes and a plan exists.
  useEffect(() => {
    if (!res || res.status !== "ok") return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => run(), 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, budget, bets]);

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const params = new URLSearchParams(window.location.search);
    const bet = params.get("bet");
    const budgetParam = params.get("budget");
    const betsParam = params.get("bets");
    const sliderParam = params.get("s");
    const nextQuery = bet ?? query;
    const nextBudget = budgetParam && Number.isFinite(Number(budgetParam)) ? budgetParam : budget;
    const nextBets = betsParam && Number.isFinite(Number(betsParam)) ? Math.min(12, Math.max(1, Math.floor(Number(betsParam)))) : bets;
    const nextSlider = sliderParam && Number.isFinite(Number(sliderParam)) ? Math.min(1, Math.max(0, Number(sliderParam))) : s;
    if (bet) setQuery(nextQuery);
    if (nextBudget !== budget) setBudget(nextBudget);
    if (nextBets !== bets) setBets(nextBets);
    if (nextSlider !== s) setS(nextSlider);
    window.setTimeout(() => run(nextQuery, nextSlider, nextBets, nextBudget), 0);
  }, [bets, budget, query, run, s]);

  useEffect(() => {
    if (!res?.plan || res.status !== "ok") return;
    const p = res.plan;
    const item: PlanHistoryItem = {
      id: `${Date.now()}-${p.betDesc}`,
      createdAt: new Date().toISOString(),
      pricedAt: res.meta?.pricedAt,
      query,
      budgetUsd: Number(budget) || p.budgetUsd,
      maxLegs: bets,
      sliderS: s,
      fixtureTitle: p.fixtureTitle,
      betDesc: p.betDesc,
      posture: p.posture,
      deployedUsd: p.deployedUsd,
      pProfit: p.pProfit,
      expectedValueUsd: p.expectedValueUsd,
      maxLossUsd: p.risk.maxLossUsd,
      verdict: p.verdict,
    };
    try {
      const raw = window.localStorage.getItem(HISTORY_KEY);
      const existing = raw ? (JSON.parse(raw) as PlanHistoryItem[]) : [];
      const withoutDupes = existing.filter((x) => !(x.betDesc === item.betDesc && x.budgetUsd === item.budgetUsd && x.maxLegs === item.maxLegs && x.sliderS === item.sliderS));
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify([item, ...withoutDupes].slice(0, 20)));
    } catch {
      // Local history is a convenience; the pricing path stays stateless if storage is unavailable.
    }
  }, [res, query, budget, bets, s]);

  useEffect(() => {
    if (!res?.plan || res.status !== "ok") return;
    const plan = res.plan;
    writeAnalysisHistory({
      id: `plan-${plan.betDesc}-${Date.now()}`,
      createdAt: new Date().toISOString(),
      type: "Plan",
      market: plan.fixtureTitle,
      position: plan.betDesc,
      stakeUsd: plan.budgetUsd,
      recommendation: `${plan.posture} ${plan.legs.length}-leg plan`,
      maxLossBeforeUsd: plan.nakedRisk.maxLossUsd,
      maxLossAfterUsd: plan.risk.maxLossUsd,
      estimatedCostUsd: plan.deployedUsd,
      status: "Analyzed",
      href: `/plan?bet=${encodeURIComponent(query)}&budget=${budget}&bets=${bets}&s=${s}`,
    });
  }, [res, query, budget, bets, s]);

  // Protect end → fetch a ranked menu of structural hedges for the pick (own-NO, rival basket,
  // cross-event ladder). Different leg types, all with a real (analytic) correlation, honestly verdicted.
  useEffect(() => {
    const isProtect = s >= 0.8;
    if (res?.status !== "ok" || !isProtect || res.meta?.betType !== "result" || !res.meta?.fixtureSlug || !res.meta?.viewTitle) {
      setHedges(null);
      setHedgesLoading(false);
      return;
    }
    setHedgesLoading(true);
    const t = setTimeout(async () => {
      hedgeAbort.current?.abort();
      const ctrl = new AbortController();
      hedgeAbort.current = ctrl;
      try {
        const r = await fetch("/api/hedge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({ query: res.meta!.viewTitle, eventSlug: res.meta!.fixtureSlug, stakeUsd: Number(budget) || 20 }),
        });
        const data = await r.json();
        const opts: HedgeStrat[] = (data.options ?? []).map((o: { decision: { verdict: HedgeStrat["verdict"]; eta: number; facts: Record<string, string> }; placementCards?: HedgeStratLeg[] }) => ({
          verdict: o.decision.verdict,
          eta: o.decision.eta,
          facts: o.decision.facts,
          legs: o.placementCards ?? [],
        }));
        setHedges(opts);
      } catch {
        /* aborted or offline */
      } finally {
        setHedgesLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res, s, budget]);

  const p = res?.plan;
  const postureLabel = s < 0.4 ? "Express" : s >= 0.8 ? "Protect" : "Balanced";
  const cb = p?.costBreakdown;
  const cbTotal = cb ? Math.max(0.01, COST.reduce((a, c) => a + Math.max(0, cb[c.key]), 0)) : 1;
  const riskScale = p ? Math.max(p.nakedRisk.maxLossUsd, p.risk.maxLossUsd, p.nakedRisk.stdDevUsd, p.risk.stdDevUsd, 0.01) : 1;

  function copyLeg(i: number, l: PlanLeg) {
    const t = `Buy ${sideLabel(l.side)} · ${l.outcomeTitle}: ~${Math.round(l.shares)} shares, limit ${l.limitPrice.toFixed(3)}, ~${usd2(l.costUsd)}`;
    navigator.clipboard?.writeText(t).then(() => {
      setCopied(i);
      setTimeout(() => setCopied(null), 1400);
    }, () => {});
  }

  return (
    <>
      <div className="topbar">
        <div className="tabs">
          <a className="tab" href="/protect">Protect</a>
          <a className="tab active" href="/plan">Build plan</a>
          <a className="tab" href="/combo">Combo check</a>
        </div>
        <div className="right">
          <VenueTag venue="polymarket" />
          <span className="livebadge"><span className="livedot" /> Priced from live CLOB</span>
          <a className="ghostbtn" href="/history">Plan history</a>
        </div>
      </div>

      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <div className="formrow">
          <MarketSearch
            scope="fixtures"
            flex={2}
            label="Market / Bet"
            placeholder="Type a team, e.g. England (add 1:0 for an exact score)"
            value={query}
            onChange={setQuery}
            onSelect={(sug) => run(sug.value)}
          />
          <div className="field">
            Budget
            <div className="inputwrap">
              <span className="pre">$</span>
              <input className="has-pre" value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" placeholder="60" />
            </div>
          </div>
          <div className="field">
            Number of bets
            <div className="stepper">
              <button type="button" aria-label="fewer bets" onClick={() => setBets((b) => Math.max(1, b - 1))}>−</button>
              <span className="val">{bets}</span>
              <button type="button" aria-label="more bets" onClick={() => setBets((b) => Math.min(12, b + 1))}>+</button>
            </div>
          </div>
          <div className="field postureslide">
            Posture: {postureLabel}
            <input type="range" min={0} max={1} step={0.05} value={s} onChange={(e) => setS(Number(e.target.value))} />
            <div className="ends"><span>Express</span><span>Protect</span></div>
          </div>
          <button disabled={loading} type="submit">{loading ? "Pricing…" : "Build plan"}</button>
        </div>
      </form>

      {err && <div className="card err">Couldn&apos;t build a plan: {err}</div>}

      {res?.status === "not_found" && (
        <div className="card">
          <div className="headline">That&apos;s not a real fixture.</div>
          <div className="muted">We only plan bets on markets that actually exist. Real matches you could pick:</div>
          <div className="chips">
            {res.suggestions?.map((sug) => (
              <span key={sug.slug} className="chip" onClick={() => run(sug.title.replace(/\s*vs\.?\s*/i, " beats "))}>{sug.title}</span>
            ))}
          </div>
        </div>
      )}

      {res?.status === "ok" && p && (
        <>
          {res.meta?.note && <div className="card" style={{ color: "var(--warn)" }}>{res.meta.note}</div>}

          {/* stat row */}
          <div className="card result-card" style={{ padding: "10px 6px" }}>
            <div className="statrow">
              <div className="statcell">
                <div className="k">Deployed</div>
                <div className="v">{usd2(p.deployedUsd)}</div>
                <div className="sub">{pct0(p.deployedUsd / p.budgetUsd)} of budget</div>
              </div>
              <div className="statcell">
                <div className="k">Worst case</div>
                <div className="v pnl-neg">{signedUsd(p.maxLossUsd)}</div>
                <div className="sub">{pct1(p.maxLossUsd / p.deployedUsd)} · the floor</div>
              </div>
              <div className="statcell">
                <div className="k">Max loss protected</div>
                <div className="v">{pct0(p.maxLossProtectedPct)}</div>
                <div className="sub">vs all-in on your pick</div>
              </div>
              <div className="statcell">
                <div className="k">Expected value</div>
                <div className="v pnl-neg">{signedUsd(p.expectedValueUsd)}</div>
                <div className="sub">{pct1(p.expectedValueUsd / p.budgetUsd)} · negative by design</div>
              </div>
              <div className="statcell">
                <div className="k">Best case</div>
                <div className="v pnl-pos">{signedUsd(p.maxGainUsd)}</div>
                <div className="sub">if your pick wins</div>
              </div>
              <div className="statcell">
                <div className="k">Chance of profit</div>
                <div className="v">{pct0(p.pProfit)}</div>
                <div className="sub">market-implied, not a forecast</div>
              </div>
              <div className="statcell verdict">
                <div className="k">Verdict</div>
                <div style={{ marginTop: 4 }}>
                  <span className={`badge ${p.verdict === "HIGH_RISK" ? "NO_GO" : "PARTIAL"}`}>
                    {p.verdict === "HIGH_RISK" ? "HIGH RISK" : "EV-NEGATIVE"}
                  </span>
                </div>
                <div className="reason">{p.verdictReason}</div>
              </div>
            </div>
          </div>

          {p.facts.guaranteedLossWarning && <div className="card err">{p.facts.guaranteedLossWarning}</div>}

          {/* Protect end → ranked menu of honest hedge strategies for the pick (multiple combos) */}
          {s >= 0.8 && (
            <div className="card result-card">
              <div className="cardtitle">
                Ways to protect this pick <span className="hint">multiple honest hedges, ranked by efficiency (η)</span>
              </div>
              {hedgesLoading && <div className="muted" style={{ marginTop: 10 }}>Pricing hedge strategies off the live book…</div>}
              {!hedgesLoading && (!hedges || hedges.length === 0) && (
                <div className="muted" style={{ marginTop: 10 }}>No structural hedge is available for this pick right now.</div>
              )}
              {hedges && hedges.length > 0 && (
                <div className="hedge-menu">
                  {hedges.map((h, i) => (
                    <div className="hedge-opt" key={i}>
                      <div className="legtop">
                        <span className={`badge ${h.verdict}`}>{h.verdict.replace("_", "-")}</span>
                        <strong style={{ fontSize: 13 }}>{h.facts.strategyLabel}</strong>
                        <span className="muted" style={{ marginLeft: "auto" }}>η {h.eta}×</span>
                      </div>
                      <div className="muted" style={{ marginTop: 6 }}>{h.facts.headline}</div>
                      {h.verdict !== "NO_GO" && h.facts.maxLossBefore && (
                        <div className="muted" style={{ marginTop: 4 }}>
                          Max loss {h.facts.maxLossBefore} to {h.facts.maxLossAfter} · cost {h.facts.execCostUsd}
                        </div>
                      )}
                      {h.legs.map((l, j) => (
                        <div key={j} className="muted" style={{ marginTop: 4 }}>
                          {l.side} · {shortOutcome(l.outcomeTitle)} — ~{Math.round(l.shares)} sh, limit {l.limitPrice} ·{" "}
                          <a href={l.deepLink} target="_blank" rel="noopener noreferrer">Open <ArrowSquareOut size={12} /></a>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              <div className="note-box" style={{ marginTop: 12 }}>
                These are <strong>structural</strong> hedges for your pick (different leg types, real analytic correlation).
                To diversify across other bet <em>types</em> or auto-build multi-leg parlays, use{" "}
                <a href="/combo">Combo check</a>.
              </div>
            </div>
          )}

          {/* row 1: scenarios | risk change */}
          <div className="dash2">
            {/* payoff scenarios */}
            <div className="card">
              <div className="cardtitle">Payoff scenarios <span className="hint">sorted by probability</span></div>
              <ScenarioBarChart data={p.scenarios.slice(0, 6).map((scenario) => ({ name: shortOutcome(scenario.outcome), value: Number(scenario.pnlUsd.toFixed(2)) }))} />
              <table style={{ marginTop: 12 }}>
                <thead><tr><th>Outcome</th><th>Probability</th><th style={{ textAlign: "right" }}>P&amp;L ($)</th><th style={{ textAlign: "right" }}>P&amp;L (%)</th></tr></thead>
                <tbody>
                  {p.scenarios.map((sc) => (
                    <tr key={sc.outcome}>
                      <td>{shortOutcome(sc.outcome)}</td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ width: 30, color: "var(--ink-3)", fontSize: 12 }}>{pct0(sc.prob)}</span>
                          <span className="pbar" style={{ flex: 1 }}><i style={{ width: `${Math.min(100, sc.prob * 100)}%` }} /></span>
                        </div>
                      </td>
                      <td style={{ textAlign: "right" }} className={sc.pnlUsd >= 0 ? "pnl-pos" : "pnl-neg"}>{signedUsd(sc.pnlUsd)}</td>
                      <td style={{ textAlign: "right" }} className={sc.pnlUsd >= 0 ? "pnl-pos" : "pnl-neg"}>{pct1(sc.pnlUsd / p.deployedUsd)}</td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 600 }}>
                    <td>Total</td><td>100%</td>
                    <td style={{ textAlign: "right" }} className={p.expectedValueUsd >= 0 ? "pnl-pos" : "pnl-neg"}>{signedUsd(p.expectedValueUsd)}</td>
                    <td style={{ textAlign: "right" }} className={p.expectedValueUsd >= 0 ? "pnl-pos" : "pnl-neg"}>{pct1(p.expectedValueUsd / p.deployedUsd)}</td>
                  </tr>
                </tbody>
              </table>
              <div className="muted" style={{ marginTop: 8 }}>Probabilities are market-implied (de-vigged), not forecasts.</div>
            </div>

            {/* risk change */}
            <div className="card">
              <div className="cardtitle">Risk change <span className="hint">vs all-in on your pick</span></div>
              <div className="legendrow">
                <span><span className="dot" style={{ background: "#c9cdd3" }} /> All-in</span>
                <span><span className="dot" style={{ background: "var(--accent)" }} /> This plan</span>
              </div>
              {([
                { label: "Max loss (USD)", before: p.nakedRisk.maxLossUsd, after: p.risk.maxLossUsd },
                { label: "Volatility (Std. Dev.)", before: p.nakedRisk.stdDevUsd, after: p.risk.stdDevUsd },
              ]).map((m) => {
                const drop = m.before - m.after;
                return (
                  <div key={m.label} style={{ marginTop: 14 }}>
                    <div className="muted" style={{ marginBottom: 6 }}>{m.label}</div>
                    <div className="rbar before" style={{ marginBottom: 5 }}><i style={{ width: `${(m.before / riskScale) * 100}%` }} /></div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="rbar after" style={{ flex: 1 }}><i style={{ width: `${(m.after / riskScale) * 100}%` }} /></span>
                      <span className="delta-neg">−{usd2(drop).replace("$", "$")} ({m.before > 0 ? pct0(drop / m.before) : "0%"})</span>
                    </div>
                  </div>
                );
              })}
              <div className="kv" style={{ marginTop: 16, borderTop: "1px solid var(--border)" }}>
                <span className="k">Max loss protected vs all-in</span>
                <span className="v">{pct0(p.maxLossProtectedPct)}</span>
              </div>
            </div>
          </div>

          {/* plan construction — full width so the 9-column table has room (no cramped wrapping) */}
          <div className="card">
            <div className="cardtitle">Plan construction <span className="hint">manual placement only</span></div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ marginTop: 12, minWidth: 680 }}>
                <thead><tr><th>#</th><th>Leg (buy)</th><th style={{ textAlign: "right" }}>Fair</th><th style={{ textAlign: "right" }}>You pay</th><th style={{ textAlign: "right" }}>Gap</th><th style={{ textAlign: "right" }}>Shares</th><th style={{ textAlign: "right" }}>Limit</th><th style={{ textAlign: "right" }}>Est. cost</th><th></th></tr></thead>
                <tbody>
                  {p.legs.map((l, i) => {
                    const gap = l.avgFillPrice - l.fairValue;
                    return (
                      <tr key={i}>
                        <td>{i + 1}</td>
                        <td>{shortOutcome(l.outcomeTitle)} <span className="muted">({sideLabel(l.side)})</span></td>
                        <td style={{ textAlign: "right" }}>{cents(l.fairValue)}</td>
                        <td style={{ textAlign: "right" }} className="pnl-neg">{cents(l.avgFillPrice)}</td>
                        <td style={{ textAlign: "right" }} className="muted">{cents(gap)}{l.fairValue > 0 ? ` / ${pct0(gap / l.fairValue)}` : ""}</td>
                        <td style={{ textAlign: "right" }}>{Math.round(l.shares)}</td>
                        <td style={{ textAlign: "right" }}>{l.limitPrice.toFixed(3)}</td>
                        <td style={{ textAlign: "right" }}>{usd2(l.costUsd)}</td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          <button type="button" className="rowbtn" onClick={() => copyLeg(i, l)}>{copied === i ? <Check size={13} /> : "Copy"}</button>
                          <a className="rowbtn" href={l.deepLink} target="_blank" rel="noopener noreferrer">Open <ArrowSquareOut size={13} /></a>
                        </td>
                      </tr>
                    );
                  })}
                  <tr style={{ fontWeight: 600 }}><td colSpan={7}>Total estimated cost</td><td style={{ textAlign: "right" }}>{usd2(p.deployedUsd)}</td><td></td></tr>
                </tbody>
              </table>
            </div>
              <ol className="steps">
                <li>Buy each leg on Polymarket, in order.</li>
                <li>Use the limit price shown. Don&apos;t cross the spread.</li>
                <li>Confirm fills. Re-run the plan if the market moves materially.</li>
              </ol>
              <div className="note-box" style={{ marginTop: 12 }}>All orders are placed by you on Polymarket. We never touch your funds, keys, or orders.</div>
          </div>

          {/* row 2: cost breakdown | alternatives | market data */}
          <div className="dash3">
            {/* cost breakdown */}
            <div className="card">
              <div className="cardtitle">Cost breakdown <span className="hint">where {usd2(p.deployedUsd)} goes</span></div>
              {cb && (
                <>
                  <div className="stack" style={{ marginTop: 14 }}>
                    {COST.map((c) => {
                      const v = Math.max(0, cb[c.key]);
                      return v > 0 ? <i key={c.key} style={{ width: `${(v / cbTotal) * 100}%`, background: c.color }} title={c.label} /> : null;
                    })}
                  </div>
                  <div style={{ marginTop: 12 }}>
                    {COST.map((c) => (
                      <div key={c.key} className="kv">
                        <span className="k"><span className="legendrow" style={{ display: "inline" }}><span className="dot" style={{ background: c.color }} /></span>{c.label}</span>
                        <span className="v">{usd2(cb[c.key])} <span className="muted">· {pct1(Math.max(0, cb[c.key]) / cbTotal)}</span></span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* alternatives */}
            <div className="card">
              <div className="cardtitle">Alternatives ranked</div>
              <table style={{ marginTop: 12 }}>
                <thead><tr><th>Plan</th><th>Verdict</th><th style={{ textAlign: "right" }}>Cost</th><th style={{ textAlign: "right" }}>Max loss</th><th style={{ textAlign: "right" }}>pProfit</th></tr></thead>
                <tbody>
                  <tr style={{ background: "var(--accent-soft)" }}>
                    <td>This plan ({p.posture})</td>
                    <td><span className={`badge ${p.verdict === "HIGH_RISK" ? "NO_GO" : "PARTIAL"}`}>{p.verdict === "HIGH_RISK" ? "HIGH RISK" : "EV-NEG"}</span></td>
                    <td style={{ textAlign: "right" }}>{usd2(p.deployedUsd)}</td>
                    <td style={{ textAlign: "right" }} className="pnl-neg">{usd2(p.risk.maxLossUsd)}</td>
                    <td style={{ textAlign: "right" }}>{pct0(p.pProfit)}</td>
                  </tr>
                  {p.alternatives.map((a) => (
                    <tr key={a.label}>
                      <td>{a.label}</td>
                      <td>{a.verdict === "NONE" ? <span className="muted">—</span> : <span className={`badge ${a.verdict === "HIGH_RISK" ? "NO_GO" : "PARTIAL"}`}>{a.verdict === "HIGH_RISK" ? "HIGH RISK" : "EV-NEG"}</span>}</td>
                      <td style={{ textAlign: "right" }}>{usd2(a.costUsd)}</td>
                      <td style={{ textAlign: "right" }} className={a.maxLossUsd > 0 ? "pnl-neg" : ""}>{usd2(a.maxLossUsd)}</td>
                      <td style={{ textAlign: "right" }}>{pct0(a.pProfit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="muted" style={{ marginTop: 8 }}>A constructed bet is EV-negative; not betting is always a valid row.</div>
            </div>

            {/* market data & safety */}
            <div className="card">
              <div className="cardtitle">Market data &amp; safety</div>
              <div style={{ marginTop: 8 }}>
                <div className="kv"><span className="k">Live CLOB snapshot</span><span className="v">{res.meta ? new Date(res.meta.pricedAt).toLocaleString() : "—"} <span className="badge GO" style={{ marginLeft: 6 }}>Live</span></span></div>
                <div className="kv"><span className="k">Book overround (vig)</span><span className="v">{p.bookOverroundPct !== undefined ? pct1(p.bookOverroundPct) : "n/a"}</span></div>
                <div className="kv"><span className="k">De-vig method</span><span className="v">{res.meta?.deVig ?? "Proportional"}</span></div>
                <div className="kv"><span className="k">Fee schedule</span><span className="v">Taker {p.feeRatePct !== undefined ? pct1(p.feeRatePct) : "n/a"} · no maker rebate</span></div>
                <div className="kv"><span className="k">Bet type</span><span className="v">{res.meta?.betType ?? "result"}</span></div>
              </div>
              {p.warnings.filter((w) => w !== p.facts.guaranteedLossWarning).length > 0 && (
                <div className="muted" style={{ marginTop: 12 }}>
                  {p.warnings.filter((w) => w !== p.facts.guaranteedLossWarning).map((w, i) => <div key={i}>{w}</div>)}
                </div>
              )}
            </div>
          </div>

          <div className="disclaimer">
            Not financial advice. Prediction-market bets are expected to lose money on average (the vig). This plan
            expresses your view honestly; it is not an edge. HedgeAdvisor is an independent interface, not affiliated with
            Polymarket, and never holds your funds or keys.
          </div>
        </>
      )}
    </>
  );
}
