"use client";

import { ArrowSquareOut, ArrowsLeftRight, LinkSimple, MagnifyingGlass } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import VenueTag from "@/components/VenueTag";

type LinkRule = "EQUIVALENT" | "MUTEX" | "SUBSET" | "SUPERSET" | "SAME_EVENT" | "SAME_ENTITY" | "NARRATIVE";
interface CrossVenueLink {
  rule: LinkRule;
  provenance: "ANALYTIC" | "SPECULATIVE";
  uses: ("hedge" | "amplify" | "context")[];
  venue: "polymarket" | "kalshi";
  kalshiTicker: string;
  kalshiLabel: string;
  kalshiMarketTitle: string;
  kalshiSide: "yes" | "no";
  kalshiYesMid: number | null;
  kalshiDeepLink: string;
  rulesSnippet: string;
  why: string;
  priceNote?: string;
}
interface RelateResult {
  status: "ok" | "ambiguous" | "not_found";
  pm?: {
    entity: string;
    claim: string;
    claimKind: "champion" | "match" | "generic";
    eventTitle: string;
    eventSlug: string;
    yesMid: number | null;
    stakeUsd: number;
    deepLink: string;
  };
  links?: CrossVenueLink[];
  candidates?: { title: string; score: number }[];
  suggestions?: string[];
  pricedAt?: string;
  error?: string;
}

const cents = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}¢`);

const RULE_META: Record<LinkRule, { label: string; badge: "GO" | "PARTIAL" | "MUTED"; blurb: string }> = {
  EQUIVALENT: { label: "Same outcome", badge: "GO", blurb: "Resolves identically on Kalshi, compare the price" },
  MUTEX: { label: "Rival outcome", badge: "MUTED", blurb: "Mutually exclusive with your bet, context only" },
  SUBSET: { label: "Contains your bet", badge: "PARTIAL", blurb: "Your win implies this one" },
  SUPERSET: { label: "Implied by", badge: "PARTIAL", blurb: "This implies your bet" },
  SAME_EVENT: { label: "Same event", badge: "MUTED", blurb: "Same game, different question" },
  SAME_ENTITY: { label: "Same team", badge: "MUTED", blurb: "Correlated, not implied" },
  NARRATIVE: { label: "Narrative", badge: "MUTED", blurb: "Broadcast / colour, not a hedge" },
};

function LinkCard({ link }: { link: CrossVenueLink }) {
  const meta = RULE_META[link.rule];
  // "hedge" uses are stripped upstream (no shorting your own bet); only same-direction amplify is actionable.
  const actionable = link.provenance === "ANALYTIC" && link.uses.includes("amplify");
  return (
    <div className="card" style={{ borderColor: actionable ? "var(--go)" : "var(--border)" }}>
      <div className="legtop" style={{ alignItems: "baseline", gap: 8 }}>
        <span className={`badge ${meta.badge === "MUTED" ? "" : meta.badge}`} style={meta.badge === "MUTED" ? { background: "var(--surface-2, #f4f4f3)", color: "var(--muted)" } : undefined}>
          {meta.label}
        </span>
        <strong style={{ color: "var(--ink)" }}>{link.kalshiLabel}</strong>
        <VenueTag venue={link.venue} short />
        <span className="muted">· {link.kalshiMarketTitle}</span>
        <span className="muted" style={{ marginLeft: "auto" }}>{cents(link.kalshiYesMid)}</span>
      </div>
      <p className="sub" style={{ marginTop: 8, marginBottom: 8 }}>{link.why}</p>
      {link.priceNote && <div className="note-box" style={{ marginBottom: 8 }}>{link.priceNote}</div>}
      <div className="kv">
        <span className="k">How to act</span>
        <span className="v">
          {actionable ? (
            // Amplify is always the same-direction (YES) side; the stored kalshiSide is the old hedge cover side.
            <>
              Buy <strong>YES</strong> on Kalshi {link.rule === "EQUIVALENT" ? "if it is cheaper than Polymarket" : "for more of the same exposure"}
            </>
          ) : (
            <span className="muted">Related context, not an action</span>
          )}
        </span>
      </div>
      <div className="toolbar" style={{ marginTop: 6, alignItems: "center", gap: 10 }}>
        <span className="muted" style={{ fontSize: 12 }}>{link.kalshiTicker}</span>
        <a className="ghostbtn" target="_blank" rel="noreferrer" href={link.kalshiDeepLink} style={{ marginLeft: "auto" }}>
          Open on Kalshi <ArrowSquareOut size={14} />
        </a>
      </div>
    </div>
  );
}

export default function LinkPage() {
  const [query, setQuery] = useState("Spain wins next match");
  const [stake, setStake] = useState("20");
  const [data, setData] = useState<RelateResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q.trim(), stakeUsd: Number(stake) || 20 }),
      });
      const json: RelateResult = await res.json();
      if (!res.ok) throw new Error(json.error || "Cross-venue lookup failed");
      setData(json);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Cross-venue lookup failed");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [stake]);

  useEffect(() => {
    run(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const structural = useMemo(() => (data?.links ?? []).filter((l) => l.provenance === "ANALYTIC"), [data]);
  const speculative = useMemo(() => (data?.links ?? []).filter((l) => l.provenance === "SPECULATIVE"), [data]);
  const equivalent = useMemo(() => (data?.links ?? []).find((l) => l.rule === "EQUIVALENT"), [data]);
  const pm = data?.pm;
  // Net-of-mid cheaper venue for buying YES (the comparison hero). Both venues priced ⇒ pick the lower.
  const cheaperYes = pm?.yesMid != null && equivalent?.kalshiYesMid != null
    ? (equivalent.kalshiYesMid < pm.yesMid ? "kalshi" : equivalent.kalshiYesMid > pm.yesMid ? "polymarket" : "aligned")
    : null;

  return (
    <div className="page">
      <div className="topbar">
        <div>
          <div className="section-kicker">Cross-venue</div>
          <h1 style={{ margin: 0 }}>Polymarket ↔ Kalshi links</h1>
        </div>
        <div className="right"><span className="livebadge"><span className="livedot" /> Live Polymarket + Kalshi</span></div>
      </div>

      <div className="card">
        <p className="sub" style={{ marginTop: 0 }}>
          Enter a Polymarket bet. We find the same outcome on Kalshi and compare the mid price across venues, so you can place
          your YES where the mid is cheaper (a mid comparison, before each venue's fees). Related and narrative markets are
          surfaced as labeled context. This is an execution comparison, not a hedge: we never recommend shorting your own bet.
        </p>
        <form
          className="formrow"
          onSubmit={(e) => { e.preventDefault(); run(query); }}
          style={{ alignItems: "flex-start", gap: 12 }}
        >
          <label className="combo-label" style={{ flex: 2.4, minWidth: 280 }}>
            Polymarket bet
            <div className="inputwrap">
              <span className="pre"><MagnifyingGlass size={15} /></span>
              <input className="has-pre" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. Spain wins next match" />
            </div>
            <span className="combo-hint">Try “Spain wins next match” or “Spain to win the World Cup”.</span>
          </label>
          <label className="combo-label" style={{ flex: 1 }}>
            Stake
            <div className="inputwrap"><span className="pre">$</span>
              <input className="has-pre" value={stake} onChange={(e) => setStake(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" />
            </div>
            <span className="combo-hint" aria-hidden>&nbsp;</span>
          </label>
          <label className="combo-label" style={{ flex: 0 }}>
            &nbsp;
            <button className="primarybtn" type="submit" disabled={loading}><LinkSimple size={15} /> Link</button>
            <span className="combo-hint" aria-hidden>&nbsp;</span>
          </label>
        </form>
      </div>

      {err && <div className="card err">Could not link this bet: {err}</div>}
      {loading && <div className="card"><span className="muted">Resolving your bet and scanning live Kalshi markets…</span></div>}

      {data?.status === "ambiguous" && (
        <div className="card">
          <div className="headline">Which exact market?</div>
          {data.candidates?.map((c) => (
            <button key={c.title} className="chip" type="button" onClick={() => { setQuery(c.title); run(c.title); }}>{c.title}</button>
          ))}
        </div>
      )}
      {data?.status === "not_found" && (
        <div className="card err">
          <div className="headline">No matching team found</div>
          <div className="muted">Try a team name, e.g. {(data.suggestions ?? ["Spain", "France", "Brazil"]).slice(0, 4).join(", ")}.</div>
        </div>
      )}

      {pm && (
        <>
          <div className="section-head" style={{ marginTop: 4 }}>
            <div>
              <div className="section-kicker">Your bet</div>
              <h2 style={{ margin: "2px 0 0", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {pm.claim} <VenueTag venue="polymarket" />
              </h2>
              <p className="sub" style={{ marginTop: 6, marginBottom: 0 }}>
                {pm.eventTitle} · YES {cents(pm.yesMid)} · stake ${pm.stakeUsd}
              </p>
            </div>
            <a className="ghostbtn" target="_blank" rel="noreferrer" href={pm.deepLink}>Open on Polymarket <ArrowSquareOut size={14} /></a>
          </div>

          <div className="metric-strip">
            <div className="metric"><div className="label">Claim type</div><div className="value">{pm.claimKind === "match" ? "Single match" : pm.claimKind === "champion" ? "Tournament" : "General"}</div><div className="detail">how your bet resolves</div></div>
            <div className="metric"><div className="label">Same outcome on Kalshi</div><div className="value">{equivalent ? cents(equivalent.kalshiYesMid) : "—"}</div><div className="detail">{equivalent ? "YES price to compare" : "no equivalent found"}</div></div>
            <div className="metric"><div className="label">Related markets</div><div className="value">{(data?.links ?? []).length}</div><div className="detail">classified Kalshi markets</div></div>
          </div>

          {equivalent && (
            <div className="card" style={{ borderColor: "var(--go)", marginTop: 4 }}>
              <div className="section-head" style={{ marginBottom: 6 }}>
                <h2 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
                  <ArrowsLeftRight size={18} color="var(--go)" weight="bold" /> Cheaper venue for your bet
                </h2>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {cheaperYes === "aligned"
                    ? <span className="badge" style={{ background: "var(--surface-2, #f4f4f3)", color: "var(--muted)" }}>Aligned</span>
                    : <span className="badge GO">{cheaperYes === "kalshi" ? "Cheaper on Kalshi" : "Cheaper on Polymarket"}</span>}
                </span>
              </div>
              <p className="sub" style={{ marginTop: 0 }}>
                The same outcome trades on both venues. Buy your <strong>YES</strong> where the mid is cheaper (before fees). This
                is an execution comparison: it places your bet at a better mid price, it does not short your position.
              </p>
              <div className="metric-strip" style={{ marginTop: 4 }}>
                <div className="metric"><div className="label">YES on Polymarket</div><div className={`value ${cheaperYes === "polymarket" ? "pnl-pos" : ""}`}>{cents(pm.yesMid)}</div><div className="detail">your current venue</div></div>
                <div className="metric"><div className="label">YES on Kalshi</div><div className={`value ${cheaperYes === "kalshi" ? "pnl-pos" : ""}`}>{cents(equivalent.kalshiYesMid)}</div><div className="detail">{equivalent.kalshiLabel}</div></div>
                <div className="metric"><div className="label">Cheaper venue</div><div className="value">{cheaperYes === "aligned" ? "Either" : cheaperYes === "kalshi" ? "Kalshi" : cheaperYes === "polymarket" ? "Polymarket" : "—"}</div><div className="detail">for buying YES</div></div>
              </div>
              {equivalent.priceNote && <div className="note-box" style={{ marginTop: 8 }}>{equivalent.priceNote}</div>}
              <div className="toolbar" style={{ marginTop: 8 }}>
                <a className="primarybtn" target="_blank" rel="noreferrer" href={equivalent.kalshiDeepLink}>Open the Kalshi market <ArrowSquareOut size={14} /></a>
                <a className="ghostbtn" target="_blank" rel="noreferrer" href={pm.deepLink}>Open on Polymarket <ArrowSquareOut size={14} /></a>
              </div>
            </div>
          )}

          {structural.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="section-head"><h2 style={{ margin: 0 }}>Structural links</h2><span className="muted">exact same-outcome and related markets</span></div>
              <div className="card-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12, marginTop: 10 }}>
                {structural.map((l) => <LinkCard key={l.kalshiTicker + l.rule} link={l} />)}
              </div>
            </div>
          )}

          {speculative.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="section-head"><h2 style={{ margin: 0 }}>Related context</h2><span className="muted">speculative, correlated colour, not an action</span></div>
              <div className="card-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12, marginTop: 10 }}>
                {speculative.map((l) => <LinkCard key={l.kalshiTicker + l.rule} link={l} />)}
              </div>
            </div>
          )}
        </>
      )}

      <div className="disclaimer">
        Not financial advice. Prices are live market-implied mids, not forecasts. The cross-venue comparison helps you buy
        the same outcome at a better price; it is not a hedge and never shorts your own bet. Related and narrative links are
        correlated context and may move independently of your bet. Execution stays on each venue; HedgeAdvisor never holds
        funds or keys.
      </div>
    </div>
  );
}
