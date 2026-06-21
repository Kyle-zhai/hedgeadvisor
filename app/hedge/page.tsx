"use client";

import { useEffect, useState } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react";
import VenueTag from "@/components/VenueTag";
import MarketSearch, { type Suggestion } from "@/components/MarketSearch";
import { PayoffChart } from "@/components/SignalCharts";
import { writeAnalysisHistory } from "@/lib/client-history";

type Verdict = "GO" | "PARTIAL" | "NO_GO";

interface PlacementCard {
  side: string;
  outcomeTitle: string;
  shares: number;
  limitPrice: number;
  estPayUsd: number;
  deepLink: string;
  steps: string[];
}
interface Decision {
  verdict: Verdict;
  reason: string;
  totalHedgeCostUsd: number;
  riskBefore: { stdDev: number; maxLoss: number; cvar: number; pLoss: number };
  riskAfter: { stdDev: number; maxLoss: number; cvar: number; pLoss: number };
  eta: number;
  facts: Record<string, string>;
}
interface HedgeOption {
  decision: Decision;
  explanation: string;
  placementCards: PlacementCard[];
}
interface HedgeResponse {
  status: "ok" | "ambiguous" | "not_found";
  eventTitle?: string;
  positionTitle?: string;
  candidates?: { title: string; score: number }[];
  suggestions?: string[];
  options?: HedgeOption[];
  explanation?: { text: string; source: "llm" | "template" };
  rivals?: { title: string; q: number }[];
  meta?: {
    outcomes: number;
    overroundPct: number;
    noBookDepthShares: number;
    pricesSource: "live" | "snapshot";
    pricedAt: string;
    bankrollUsd: number;
    bankrollAssumed: boolean;
    deVig?: string;
  };
  error?: string;
}

const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;

function OptionCard({
  option,
  rank,
  topExplanation,
}: {
  option: HedgeOption;
  rank: number;
  topExplanation?: string;
}) {
  const d = option.decision;
  const f = d.facts;
  const text = rank === 0 && topExplanation ? topExplanation : option.explanation;
  return (
    <div className="card result-card">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className={`badge ${d.verdict}`}>{d.verdict.replace("_", "-")}</span>
        <strong>{f.strategyLabel}</strong>
        {rank === 0 && d.verdict !== "NO_GO" && <span className="chip" style={{ cursor: "default" }}>Recommended</span>}
        <span className="muted" style={{ marginLeft: "auto" }}>
          η {d.eta}×
        </span>
      </div>
      <div className="headline">{f.headline}</div>
      <div className="explain">{text}</div>

      {d.verdict !== "NO_GO" && (
        <div className="grid">
          <div className="stat">
            <div className="k">Max loss</div>
            <div className="v">
              <span className="before">{f.maxLossBefore}</span> to <span className="after">{f.maxLossAfter}</span>
            </div>
          </div>
          <div className="stat">
            <div className="k">P&amp;L volatility</div>
            <div className="v">
              <span className="before">{f.stdDevBefore}</span> to <span className="after">{f.stdDevAfter}</span>
            </div>
          </div>
          <div className="stat">
            <div className="k">Execution cost</div>
            <div className="v">{f.execCostUsd}</div>
          </div>
          <div className="stat">
            <div className="k">Expected cost (incl. vig)</div>
            <div className="v">{f.expectedCostUsd}</div>
          </div>
        </div>
      )}

      {option.placementCards.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div className="muted">Place it on Polymarket (you confirm there; we never touch your funds/keys):</div>
          {option.placementCards.map((c, i) => (
            <div className="leg" key={i}>
              <div className="legtop">
                <strong>
                  {c.side} · {c.outcomeTitle}
                </strong>
                <span className="muted">est. {usd(c.estPayUsd)}</span>
              </div>
              <div className="muted">
                ~{c.shares.toLocaleString()} shares · limit {c.limitPrice}
              </div>
              <a className="pmlink" href={c.deepLink} target="_blank" rel="noopener noreferrer">
                Open Polymarket <ArrowSquareOut size={13} />
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const [query, setQuery] = useState("Spain wins the World Cup");
  const [stake, setStake] = useState("1000");
  const [avg, setAvg] = useState("");
  const [bankroll, setBankroll] = useState("");
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<HedgeResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Step 2 of discovery: after picking a multi-outcome event, list its real outcomes.
  const [outcomes, setOutcomes] = useState<Suggestion[] | null>(null);
  const [outcomesFor, setOutcomesFor] = useState<string>("");
  const [outLoading, setOutLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("position");
    const initial = fromUrl || query;
    if (fromUrl) setQuery(fromUrl);
    window.setTimeout(() => analyze(initial), 0);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function selectEvent(s: Suggestion) {
    setRes(null);
    setErr(null);
    setOutcomesFor(s.label);
    setOutcomes([]);
    setOutLoading(true);
    try {
      const r = await fetch(`/api/search?scope=outcomes&slug=${encodeURIComponent(s.slug)}`);
      const data: { suggestions?: Suggestion[] } = await r.json();
      setOutcomes(data.suggestions ?? []);
    } catch {
      setOutcomes([]);
    } finally {
      setOutLoading(false);
    }
  }

  async function analyze(q?: string, eventSlug?: string) {
    setLoading(true);
    setErr(null);
    setRes(null);
    setOutcomes(null);
    try {
      const body: Record<string, unknown> = { query: q ?? query };
      if (eventSlug) body.eventSlug = eventSlug; // hedge within the chosen event, not cross-domain re-search
      if (stake) body.stakeUsd = Number(stake);
      if (avg) body.avgPrice = Number(avg);
      if (bankroll) body.bankrollUsd = Number(bankroll);
      const r = await fetch("/api/hedge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: HedgeResponse = await r.json();
      if (!r.ok) throw new Error(data.error ?? "request failed");
      setRes(data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "something went wrong");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const best = res?.status === "ok" ? res.options?.[0] : undefined;
    if (!best) return;
    writeAnalysisHistory({
      id: `hedge-${res?.positionTitle || query}-${Date.now()}`,
      createdAt: new Date().toISOString(),
      type: "Protect",
      market: res?.eventTitle || "Live market",
      position: res?.positionTitle || query,
      stakeUsd: Number(stake) || 0,
      recommendation: best.decision.facts.strategyLabel || "Ranked hedge",
      maxLossBeforeUsd: best.decision.riskBefore.maxLoss,
      maxLossAfterUsd: best.decision.riskAfter.maxLoss,
      estimatedCostUsd: best.decision.totalHedgeCostUsd,
      status: "Analyzed",
      href: `/hedge?position=${encodeURIComponent(res?.positionTitle || query)}`,
    });
  }, [res, query, stake]);

  return (
    <>
      <div className="topbar">
        <div className="tabs">
          <a className="tab" href="/protect">Protect</a>
          <span className="tab active">Hedge</span>
          <span className="badge PARTIAL" style={{ marginBottom: 12 }}>Advanced</span>
        </div>
        <div className="right">
          <span className="livebadge"><span className="livedot" /> Priced from live CLOB</span>
        </div>
      </div>
      <p className="sub">
        Enter a position you hold or like. We rank correlated hedges, price each at the{" "}
        <strong>real executable cost</strong> (not the midpoint), and tell you honestly which is worth it, including when
        the answer is &ldquo;don&apos;t bother.&rdquo;
      </p>

      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          analyze();
        }}
      >
        <div className="row">
          <MarketSearch
            scope="events"
            flex={2}
            label="Your position"
            placeholder="Search real markets, e.g. World Cup, election, Bitcoin"
            value={query}
            onChange={setQuery}
            onSelect={selectEvent}
            hint="Pick a real Polymarket market below, then choose the outcome you hold."
          />
          <label>
            Stake (USD)
            <input value={stake} onChange={(e) => setStake(e.target.value)} inputMode="decimal" placeholder="1000" />
          </label>
          <label>
            Avg price (optional)
            <input value={avg} onChange={(e) => setAvg(e.target.value)} inputMode="decimal" placeholder="market" />
          </label>
          <label>
            Bankroll (optional)
            <input value={bankroll} onChange={(e) => setBankroll(e.target.value)} inputMode="decimal" placeholder="for exact size" />
          </label>
        </div>
        <button disabled={loading} type="submit">
          {loading ? "Analyzing…" : "Rank my hedges"}
        </button>
        <div className="chips">
          {["Spain wins the World Cup", "France wins the World Cup", "Brazil wins the World Cup", "Argentina wins the World Cup"].map(
            (s) => (
              <span
                key={s}
                className="chip"
                onClick={() => {
                  setQuery(s);
                  analyze(s);
                }}
              >
                {s}
              </span>
            ),
          )}
        </div>
      </form>

      {outcomes && (
        <div className="card result-card">
          <div className="headline">Which outcome do you hold in &ldquo;{outcomesFor}&rdquo;?</div>
          {outLoading ? (
            <div className="muted">Loading real outcomes…</div>
          ) : outcomes.length === 0 ? (
            <div className="muted">
              Couldn&apos;t list outcomes for this market. Type your exact position above and press Rank my hedges.
            </div>
          ) : (
            <>
              <div className="muted">Real outcomes on this market, most likely first. Pick the one you hold:</div>
              <div className="chips">
                {outcomes.map((o) => (
                  <span
                    key={o.value}
                    className="chip"
                    onClick={() => {
                      setQuery(o.value);
                      analyze(o.value, o.slug);
                    }}
                  >
                    {o.label} · {o.sub}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {err && (
        <div className="card err">
          Couldn&apos;t analyze: {err}
          <div className="muted" style={{ marginTop: 6 }}>
            This MVP reads live Polymarket data; if you&apos;re offline or the event isn&apos;t live, try again.
          </div>
        </div>
      )}

      {res?.status === "not_found" && (
        <div className="card">
          <div className="headline">No matching market found.</div>
          {res.suggestions && res.suggestions.length > 0 && (
            <>
              <div className="muted">Did you mean:</div>
              <div className="chips">
                {res.suggestions.map((s) => (
                  <span key={s} className="chip" onClick={() => analyze(`${s} wins`)}>
                    {s}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {res?.status === "ambiguous" && res.candidates && (
        <div className="card">
          <div className="headline">Which outcome did you mean?</div>
          <div className="chips">
            {res.candidates.map((c) => (
              <span key={c.title} className="chip" onClick={() => analyze(`${c.title} wins`)}>
                {c.title}
              </span>
            ))}
          </div>
        </div>
      )}

      {res?.status === "ok" && (!res.options || res.options.length === 0) && (
        <div className="card">
          <div className="headline">Couldn&apos;t price any hedge right now.</div>
          <div className="muted">The order books are empty or degenerate. Try again shortly.</div>
        </div>
      )}

      {res?.status === "ok" && res.options && res.options.length > 0 && (
        <>
          <div className="section-head">
            <div><div className="section-kicker">Advanced hedge analysis</div><h1 style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>{res.positionTitle || query} <VenueTag venue="polymarket" /></h1><p className="sub" style={{ marginTop: 6, marginBottom: 0 }}>{res.eventTitle}</p></div>
            <span className="badge GO">{res.options[0].decision.verdict.replace("_", "-")}</span>
          </div>
          <div className="metric-strip">
            <div className="metric"><div className="label">Current max loss</div><div className="value pnl-neg">{usd(res.options[0].decision.riskBefore.maxLoss)}</div><div className="detail">Before hedge execution</div></div>
            <div className="metric"><div className="label">Protected max loss</div><div className="value pnl-pos">{usd(res.options[0].decision.riskAfter.maxLoss)}</div><div className="detail">Recommended strategy</div></div>
            <div className="metric"><div className="label">Hedge cost</div><div className="value">{usd(res.options[0].decision.totalHedgeCostUsd)}</div><div className="detail">Estimated executable cost</div></div>
            <div className="metric"><div className="label">Volatility after</div><div className="value">{usd(res.options[0].decision.riskAfter.stdDev)}</div><div className="detail">P&amp;L standard deviation</div></div>
            <div className="metric"><div className="label">Efficiency</div><div className="value">{res.options[0].decision.eta.toFixed(2)}×</div><div className="detail">Risk reduction per dollar</div></div>
          </div>
          <div className="dash2">
            <div className="card"><div className="cardtitle">Payoff distribution <span className="hint">unhedged vs recommended</span></div><PayoffChart data={[0,20,40,60,80,100].map((probability) => ({ probability: `${probability}%`, unprotected: -res.options![0].decision.riskBefore.maxLoss + probability / 100 * (res.options![0].decision.riskBefore.maxLoss + Number(stake || 0)), protected: -res.options![0].decision.riskAfter.maxLoss + probability / 100 * (res.options![0].decision.riskAfter.maxLoss + Math.max(0, Number(stake || 0) - res.options![0].decision.totalHedgeCostUsd)) }))} primaryLabel="Recommended hedge" comparisonLabel="Unhedged" /></div>
            <div className="card"><div className="cardtitle">Market summary</div><div className="kv"><span className="k">Outcomes</span><span className="v">{res.meta?.outcomes}</span></div><div className="kv"><span className="k">Book overround</span><span className="v">{res.meta ? `${(res.meta.overroundPct * 100).toFixed(1)}%` : "—"}</span></div><div className="kv"><span className="k">Prices</span><span className="v">{res.meta?.pricesSource}</span></div><div className="kv"><span className="k">Ranked options</span><span className="v">{res.options.length}</span></div><div className="note-box" style={{ marginTop: 10 }}>Every option is priced from executable order-book depth, including spread, fee, slippage, and vig.</div></div>
          </div>
          <div className="card"><div className="section-head"><h2>Best hedge strategies</h2><span className="muted">Ranked by protected max loss and efficiency</span></div><div className="table-wrap"><table style={{ minWidth: 920 }}><thead><tr><th>Rank</th><th>Verdict</th><th>Strategy</th><th style={{ textAlign: "right" }}>Shares</th><th style={{ textAlign: "right" }}>Est. cost</th><th style={{ textAlign: "right" }}>Max loss before</th><th style={{ textAlign: "right" }}>Max loss after</th><th style={{ textAlign: "right" }}>P&amp;L volatility</th><th style={{ textAlign: "right" }}>Efficiency</th></tr></thead><tbody>{res.options.map((option, index) => <tr key={index}><td>{index + 1}</td><td><span className={`badge ${option.decision.verdict}`}>{option.decision.verdict.replace("_", "-")}</span></td><td><strong>{option.decision.facts.strategyLabel}</strong><div className="muted">{option.decision.facts.headline}</div></td><td style={{ textAlign: "right" }}>{option.placementCards.reduce((sum, card) => sum + card.shares, 0).toFixed(0)}</td><td style={{ textAlign: "right" }}>{usd(option.decision.totalHedgeCostUsd)}</td><td style={{ textAlign: "right" }} className="pnl-neg">{usd(option.decision.riskBefore.maxLoss)}</td><td style={{ textAlign: "right" }} className="pnl-pos">{usd(option.decision.riskAfter.maxLoss)}</td><td style={{ textAlign: "right" }}>{usd(option.decision.riskAfter.stdDev)}</td><td style={{ textAlign: "right" }}>{option.decision.eta.toFixed(2)}×</td></tr>)}</tbody></table></div></div>
          <div className="muted" style={{ margin: "4px 2px 4px" }}>
            {res.positionTitle ? `${res.positionTitle} · ${res.eventTitle}` : res.eventTitle} ·{" "}
            {res.meta?.outcomes} outcomes · book overround {res.meta ? `${(res.meta.overroundPct * 100).toFixed(1)}%` : "n/a"} ·{" "}
            {res.options.length} hedge option{res.options.length === 1 ? "" : "s"}, ranked
          </div>
          {res.meta && (
            <div className="muted" style={{ margin: "0 2px 14px", fontSize: 12 }}>
              {res.meta.pricesSource === "live" ? "Priced from live order books" : "Priced from cached snapshot"}
              {" at "}
              {new Date(res.meta.pricedAt).toLocaleTimeString()} ·{" "}
              {res.meta.bankrollAssumed
                ? `size assumes your position is ~20% of bankroll (≈$${res.meta.bankrollUsd.toLocaleString()}); enter your bankroll above for an exact size`
                : `size based on your $${res.meta.bankrollUsd.toLocaleString()} bankroll`}
              {res.meta.deVig ? ` · de-vig: ${res.meta.deVig}` : ""}
            </div>
          )}
          {res.options.map((opt, i) => (
            <OptionCard key={i} option={opt} rank={i} topExplanation={i === 0 ? res.explanation?.text : undefined} />
          ))}

          <div className="disclaimer">
            Not financial advice. Prediction-market trading involves substantial risk, including total loss. Within-book
            hedging is EV-negative after spread, fee and vig; it reduces variance, it is not expected to be profitable.
            HedgeAdvisor is an independent interface, not affiliated with Polymarket, and never holds your funds or keys.
          </div>
        </>
      )}
    </>
  );
}
