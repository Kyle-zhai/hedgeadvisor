"use client";

import { useEffect, useState } from "react";
import { ScenarioBarChart } from "@/components/SignalCharts";
import { writeAnalysisHistory } from "@/lib/client-history";
import { ArrowSquareOut, CheckCircle, X, XCircle } from "@phosphor-icons/react";
import VenueTag from "@/components/VenueTag";
// Canonical wire type (type-only import, erased from the client bundle) so the page can't
// drift from lib/combo.
import type { ComboResult } from "@/lib/combo";

interface ComboResponse {
  status: "ok" | "error";
  result?: ComboResult;
  unresolved?: { query: string; reason: string }[];
  pricedAt?: string;
  error?: string;
}

// Unicode MINUS SIGN (U+2212), not ASCII hyphen — the hyphen lets "-$0.26" wrap mid-number.
const usd2 = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`;
const signedUsd = (x: number) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(2)}`;
const pct1 = (x: number) => `${x < 0 ? "−" : ""}${(Math.abs(x) * 100).toFixed(1)}%`;
const c1 = (cents: number) => `${cents < 0 ? "−" : ""}${(Math.abs(cents)).toFixed(1)}¢`;

export default function ComboPage() {
  const [legs, setLegs] = useState<{ query: string; side: "yes" | "no" }[]>([
    { query: "Spain win the World Cup", side: "yes" },
    { query: "France win the World Cup", side: "no" },
    { query: "Argentina reach the World Cup semifinal", side: "yes" },
  ]);
  const [stake, setStake] = useState("20");
  const [quote, setQuote] = useState(""); // optional quoted combo price, in cents
  const [res, setRes] = useState<ComboResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function setLeg(i: number, patch: Partial<{ query: string; side: "yes" | "no" }>) {
    setLegs((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }
  const addLeg = () => setLegs((ls) => (ls.length >= 8 ? ls : [...ls, { query: "", side: "yes" }]));
  const removeLeg = (i: number) => setLegs((ls) => (ls.length <= 1 ? ls : ls.filter((_, j) => j !== i)));

  async function run() {
    setLoading(true);
    setErr(null);
    try {
      const quotedCents = Number(quote);
      const body: Record<string, unknown> = {
        legs: legs.filter((l) => l.query.trim()).map((l) => ({ query: l.query.trim(), side: l.side })),
        stakeUsd: Number(stake) || 20,
      };
      if (quotedCents > 0 && quotedCents < 100) body.quotedComboPrice = quotedCents / 100;
      const r = await fetch("/api/combo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data: ComboResponse = await r.json();
      if (!r.ok) throw new Error(data.error ?? "request failed");
      setRes(data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "something went wrong");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void run(); /* initial real analysis */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const c = res?.result;

  useEffect(() => {
    if (!c) return;
    writeAnalysisHistory({
      id: `combo-${c.legs.map((leg) => leg.title).join("-")}-${Date.now()}`,
      createdAt: new Date().toISOString(),
      type: "Combo",
      market: `${c.legs.length}-leg live combo`,
      position: c.legs.map((leg) => `${leg.side.toUpperCase()} ${leg.title}`).join(" + "),
      stakeUsd: c.stakeUsd,
      recommendation: c.verdict === "HIGH_RISK" ? "Pass or size conservatively" : "Review quoted discount",
      maxLossBeforeUsd: c.stakeUsd,
      maxLossAfterUsd: Math.abs(c.maxLossUsd),
      estimatedCostUsd: c.stakeUsd,
      status: "Analyzed",
      href: "/combo",
    });
  }, [c]);

  return (
    <>
      <div className="topbar">
        <div className="tabs">
          <a className="tab" href="/protect">Protect</a>
          <a className="tab" href="/plan">Build plan</a>
          <a className="tab active" href="/combo">Combo check</a>
        </div>
        <div className="right">
          <span className="livebadge"><span className="livedot" /> Priced from live CLOB</span>
        </div>
      </div>
      <p className="sub">
        Build a multi-leg combo (parlay). We walk each leg&apos;s <strong>real order book</strong> to show the true cost
        of legging it in yourself, the fair value, and the <strong>compounded vig</strong> — and, if you paste a quoted
        combo price, whether the &ldquo;discount&rdquo; is actually real.
      </p>

      <form className="card" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <div className="cardtitle">Legs <span className="hint">all must hit for the combo to pay</span></div>
        {legs.map((l, i) => (
          <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
            <span className="muted" style={{ width: 16 }}>{i + 1}</span>
            <input
              style={{ flex: 1 }}
              value={l.query}
              onChange={(e) => setLeg(i, { query: e.target.value })}
              placeholder="Type a real outcome, e.g. England win the World Cup, Trump 2028, Lakers win NBA"
            />
            <div className="stepper" role="group" aria-label="side">
              {(["yes", "no"] as const).map((sd) => (
                <button
                  key={sd}
                  type="button"
                  onClick={() => setLeg(i, { side: sd })}
                  style={{
                    background: l.side === sd ? "var(--accent-soft)" : "var(--bg)",
                    color: l.side === sd ? "var(--accent-ink)" : "var(--ink-3)",
                    width: 48, textTransform: "uppercase", fontSize: 12,
                  }}
                >
                  {sd}
                </button>
              ))}
            </div>
            <button type="button" className="copybtn" onClick={() => removeLeg(i)} aria-label="remove leg" style={{ padding: "8px 10px" }}><X size={14} /></button>
          </div>
        ))}
        <div style={{ marginTop: 12 }}>
          <button type="button" className="copybtn" onClick={addLeg} disabled={legs.length >= 8}>+ Add leg</button>
        </div>

        <div className="formrow" style={{ marginTop: 16 }}>
          <div className="field">
            Stake
            <div className="inputwrap"><span className="pre">$</span><input className="has-pre" value={stake} onChange={(e) => setStake(e.target.value)} inputMode="decimal" placeholder="20" /></div>
          </div>
          <div className="field">
            Quoted combo price <span className="combo-hint">optional, in ¢ per $1</span>
            <div className="inputwrap"><input value={quote} onChange={(e) => setQuote(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="e.g. 23" /></div>
          </div>
          <button disabled={loading} type="submit">{loading ? "Checking…" : "Check combo"}</button>
        </div>
      </form>

      {err && <div className="card err">Couldn&apos;t check the combo: {err}</div>}

      {res?.unresolved && res.unresolved.length > 0 && (
        <div className="card" style={{ borderColor: "#f4d9b0" }}>
          <div className="headline">Some legs aren&apos;t real markets (skipped)</div>
          {res.unresolved.map((u, i) => (
            <div key={i} className="muted">&ldquo;{u.query}&rdquo; — {u.reason}</div>
          ))}
          <div className="muted" style={{ marginTop: 6 }}>Name the specific outcome (e.g. &ldquo;England win the World Cup&rdquo;), not just the event.</div>
        </div>
      )}

      {c && (
        <>
          <div className="card result-card" style={{ padding: "10px 6px" }}>
            <div className="statrow">
              <div className="statcell"><div className="k">Worst case</div><div className="v pnl-neg">{signedUsd(c.maxLossUsd)}</div><div className="sub">a parlay can lose your full stake</div></div>
              <div className="statcell"><div className="k">You pay vs fair</div><div className="v pnl-neg">{c1(c.buildPriceCents)} vs {c1(c.fairPriceCents)}</div><div className="sub">{c1(c.compoundedVigCents)} compounded vig</div></div>
              <div className="statcell"><div className="k">Expected value</div><div className="v pnl-neg">{signedUsd(c.expectedValueUsd)}</div><div className="sub">{pct1(c.expectedValueUsd / c.stakeUsd)} of stake · negative by design</div></div>
              <div className="statcell"><div className="k">Chance all hit</div><div className="v">{pct1(c.comboProb)}</div><div className="sub">{c.structuralJoint ? (c.structuralJoint.p === 0 ? "can never all hit" : "exact · redundant legs") : "market-implied, not a forecast"}</div></div>
              <div className="statcell"><div className="k">Payout if all hit</div><div className="v">{c.payoutMultiple.toFixed(2)}×</div><div className="sub">{signedUsd(c.maxGainUsd)} on {usd2(c.stakeUsd)}</div></div>
              <div className="statcell verdict">
                <div className="k">Verdict</div>
                <div style={{ marginTop: 4 }}><span className={`badge ${c.verdict === "HIGH_RISK" ? "NO_GO" : "PARTIAL"}`}>{c.verdict === "HIGH_RISK" ? "HIGH RISK" : "EV-NEGATIVE"}</span></div>
                <div className="reason">{c.verdictReason}</div>
              </div>
            </div>
          </div>

          {c.quote && (
            <div className={`card ${c.quote.realDiscount ? "" : "err"}`} style={c.quote.realDiscount ? { background: "var(--go-bg)", borderColor: "#bfe3cd" } : {}}>
              <div className="headline" style={{ marginTop: 0, display: "flex", alignItems: "center", gap: 7 }}>
                {c.quote.realDiscount ? <CheckCircle size={17} weight="fill" /> : <XCircle size={17} weight="fill" />} {c.quote.realDiscount ? "Real discount vs legging in" : "No real discount"} — quote {c1(c.quote.quotedCents)} vs build {c1(c.quote.buildCents)}
              </div>
              <div className="muted">{c.quote.note}</div>
            </div>
          )}

          {c.structuralJoint && (
            <div
              className="card"
              style={
                c.structuralJoint.p === 0
                  ? { background: "var(--nogo-bg)", borderColor: "#f4cdc8" }
                  : { background: "var(--go-bg)", borderColor: "#bfe3cd" }
              }
            >
              <div className="cardtitle">
                Exact joint <span className="hint">ANALYTIC · derived from market structure, not estimated</span>
              </div>
              <div className="headline" style={{ marginTop: 6 }}>
                {c.structuralJoint.p === 0 ? "Impossible — these legs can never all hit (0%)" : `True chance all hit: ${pct1(c.structuralJoint.p)} (exact)`}
              </div>
              <div className="muted" style={{ marginTop: 4 }}>{c.structuralJoint.why}</div>
            </div>
          )}

          {c.relation && c.legs.length === 2 && (
            <div className="card" style={{ borderColor: "var(--border-strong)" }}>
              <div className="cardtitle">
                Correlation &amp; hedge{" "}
                <span className="hint">
                  {c.relation.method === "structural" ? "ANALYTIC · derived from market structure" : c.relation.method === "independence" ? "independent by default (no correlation info)" : "estimate · Fréchet-clamped"}
                </span>
              </div>
              <div className="metric-strip" style={{ marginTop: 8 }}>
                <div className="metric">
                  <div className="label">Relation</div>
                  <div className="value" style={{ fontSize: 18 }}>
                    {c.relation.relation === "mutually_exclusive" ? "Exclusive" : c.relation.relation === "same" ? "Same" : c.relation.relation === "related" ? "Related" : "Independent"}
                  </div>
                  <div className="detail">{c.relation.hedgeSignal === "same_exposure" ? "Same-direction exposure" : c.relation.hedgeSignal === "hedge" ? "Natural hedge" : "Diversifiable"}</div>
                </div>
                <div className="metric">
                  <div className="label">Correlation φ</div>
                  <div className="value" style={{ color: c.relation.correlation < 0 ? "var(--go)" : c.relation.correlation > 0 ? "var(--warn)" : "var(--ink)" }}>
                    {c.relation.correlation >= 0 ? "+" : ""}{c.relation.correlation.toFixed(2)}
                  </div>
                  <div className="detail">phi ∈ [−1, 1]</div>
                </div>
                <div className="metric">
                  <div className="label">Hedge effectiveness</div>
                  <div className="value">{Math.round(c.relation.effectiveness * 100)}%</div>
                  <div className="detail">= φ² (risk removable)</div>
                </div>
                <div className="metric">
                  <div className="label">Optimal hedge ratio</div>
                  <div className="value">{c.relation.hedgeRatio.toFixed(2)}:1</div>
                  <div className="detail">{c.relation.hedgeRatio < 0 ? `buy No-leg2 ${Math.abs(c.relation.hedgeRatio).toFixed(2)}:1` : c.relation.hedgeRatio > 0 ? `buy Yes-leg2 ${c.relation.hedgeRatio.toFixed(2)}:1` : "n/a"}</div>
                </div>
                <div className="metric">
                  <div className="label">Confidence</div>
                  <div className="value" style={{ fontSize: 18 }}>{c.relation.confidence === "high" ? "High" : c.relation.confidence === "medium" ? "Med" : "Low"}</div>
                  <div className="detail">P(A∩B) ≈ {pct1(c.relation.pAB)}{c.relation.frechetViolated ? " · clamped to bounds" : ""}</div>
                </div>
              </div>
              <div className="note-box" style={{ marginTop: 10 }}>{c.relation.reasoning}</div>
            </div>
          )}

          {c.jointEstimate && (
            <div className="card" style={{ borderColor: "#d8e2fa" }}>
              <div className="cardtitle">
                Estimated correlation <span className="hint">cross-market · ESTIMATED, not analytic</span>
              </div>
              <div className="muted" style={{ marginTop: 8 }}>
                The naive combo assumes the legs are independent. They probably aren&apos;t — but we can&apos;t measure the
                correlation from prices, so we don&apos;t fake a number. Instead: the exact range the true chance MUST fall
                in, whatever the correlation.
              </div>
              <div className="statrow" style={{ marginTop: 12 }}>
                <div className="statcell">
                  <div className="k">If independent</div>
                  <div className="v">{pct1(c.jointEstimate.independence)}</div>
                  <div className="sub">Π of legs</div>
                </div>
                <div className="statcell">
                  <div className="k">True range (any correlation)</div>
                  <div className="v">{pct1(c.jointEstimate.frechetLow)} – {pct1(c.jointEstimate.frechetHigh)}</div>
                  <div className="sub">Fréchet envelope (incl. marginal uncertainty)</div>
                </div>
                <div className="statcell">
                  <div className="k">If moderately correlated</div>
                  <div className="v">{pct1(c.jointEstimate.correlated)}</div>
                  <div className="sub">illustrative, ρ={c.jointEstimate.illustrativeRho}</div>
                </div>
              </div>
              <div className="dash2" style={{ marginTop: 12 }}>
                <div>
                  <div className="cardtitle">Leg probability contribution</div>
                  <ScenarioBarChart format="percent" data={c.legs.map((leg) => ({ name: leg.title.slice(0, 24), value: Number((leg.q * 100).toFixed(2)) }))} />
                </div>
                <div>
                  <div className="cardtitle">Correlation matrix <span className="hint">illustrative rho</span></div>
                  <table style={{ marginTop: 10 }}><thead><tr><th>Leg</th>{c.legs.map((_, i) => <th key={i} style={{ textAlign: "right" }}>{i + 1}</th>)}</tr></thead><tbody>{c.legs.map((leg, row) => <tr key={leg.title}><td>{row + 1}. {leg.title.slice(0, 22)}</td>{c.legs.map((_, col) => <td key={col} style={{ textAlign: "right", background: row === col ? "var(--go-bg)" : "var(--warn-bg)" }}>{row === col ? "1.00" : Number(c.jointEstimate!.illustrativeRho).toFixed(2)}</td>)}</tr>)}</tbody></table>
                </div>
              </div>
              <div className="note-box" style={{ marginTop: 12 }}>
                Positive correlation pushes the chance up (legs hit together), negative pushes it down. Marginals also carry
                de-vig method uncertainty. Treat the range as the honest answer; the ρ point is illustration only.
              </div>
            </div>
          )}

          <div className="dash2">
            <div className="card">
              <div className="cardtitle">Legs <span className="hint">priced off the real book</span></div>
              <table style={{ marginTop: 12 }}>
                <thead><tr><th>#</th><th>Leg</th><th style={{ textAlign: "right" }}>Fair</th><th style={{ textAlign: "right" }}>You pay</th><th style={{ textAlign: "right" }}>Gap</th><th></th></tr></thead>
                <tbody>
                  {c.legs.map((l, i) => {
                    const gap = (l.price - l.q) * 100;
                    return (
                      <tr key={i}>
                        <td>{i + 1}</td>
                        <td>{l.title} <VenueTag venue="polymarket" short /> <span className="muted">({l.side.toUpperCase()} · {l.marketTitle})</span>{l.capacityHit ? <span className="muted"> · thin</span> : ""}</td>
                        <td style={{ textAlign: "right" }}>{c1(l.q * 100)}</td>
                        <td style={{ textAlign: "right" }} className="pnl-neg">{c1(l.price * 100)}</td>
                        <td style={{ textAlign: "right" }} className="muted">{c1(gap)}</td>
                        <td style={{ textAlign: "right" }}><a className="rowbtn" href={l.deepLink} target="_blank" rel="noopener noreferrer">Open <ArrowSquareOut size={13} /></a></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="card">
              <div className="cardtitle">Why combos bleed</div>
              <div className="muted" style={{ marginTop: 8 }}>
                The vig compounds with every leg: you pay {c1(c.buildPriceCents)} for something worth {c1(c.fairPriceCents)},
                so {c1(c.compoundedVigCents)} of every $1 of payout is gone before the games even start.
              </div>
              {c.warnings.map((w, i) => (
                <div key={i} className="note-box" style={{ marginTop: 10 }}>{w}</div>
              ))}
            </div>
          </div>

          <div className="disclaimer">
            Not financial advice. A combo is structurally EV-negative; the more legs, the more compounded vig you eat. The
            joint probability assumes independence — correlated legs make it worse. HedgeAdvisor never holds your funds or keys.
          </div>
        </>
      )}
    </>
  );
}
