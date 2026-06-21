"use client";

import { ArrowSquareOut, LinkSimple, MagnifyingGlass, ShieldCheck } from "@phosphor-icons/react";
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
interface CrossVenueHedge {
  available: boolean;
  partition: "champion" | "match" | "generic";
  coverLabel: string;
  coverTicker: string;
  coverSide: "no";
  coverDeepLink: string;
  stakeUsd: number;
  keepFraction: number;
  spendUsd: number;
  keepIfWinUsd: number;
  lossIfFailUsd: number;
  unhedgedLossUsd: number;
  kalshiCoverPrice: number;
  polymarketCoverPrice: number | null;
  cheaperVenue: "polymarket" | "kalshi" | null;
  venueNote: string;
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
  hedge?: CrossVenueHedge;
  candidates?: { title: string; score: number }[];
  suggestions?: string[];
  pricedAt?: string;
  error?: string;
}

const cents = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}¢`);

const RULE_META: Record<LinkRule, { label: string; badge: "GO" | "PARTIAL" | "MUTED"; blurb: string }> = {
  EQUIVALENT: { label: "Same bet", badge: "GO", blurb: "Resolves identically on Kalshi" },
  MUTEX: { label: "Pays if you lose", badge: "GO", blurb: "Mutually exclusive with your bet" },
  SUBSET: { label: "Contains your bet", badge: "PARTIAL", blurb: "Your win implies this one" },
  SUPERSET: { label: "Implied by", badge: "PARTIAL", blurb: "This implies your bet" },
  SAME_EVENT: { label: "Same event", badge: "MUTED", blurb: "Same game, different question" },
  SAME_ENTITY: { label: "Same team", badge: "MUTED", blurb: "Correlated, not implied" },
  NARRATIVE: { label: "Narrative", badge: "MUTED", blurb: "Broadcast / colour, not a hedge" },
};

function LinkCard({ link }: { link: CrossVenueLink }) {
  const meta = RULE_META[link.rule];
  const actionable = link.provenance === "ANALYTIC" && (link.uses.includes("hedge") || link.uses.includes("amplify"));
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
            <>
              Take <strong>{link.kalshiSide.toUpperCase()}</strong> on Kalshi
              {link.uses.includes("hedge") && link.uses.includes("amplify") ? " (NO hedges · YES amplifies)" : ""}
            </>
          ) : (
            <span className="muted">Context only — not a hedge</span>
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
  const pm = data?.pm;

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
          Enter a Polymarket bet. We find the live Kalshi markets logically tied to it and label how each one relates —
          a real cross-venue hedge, an amplifier, or just related colour. Structural links are exact; thematic and
          narrative links are clearly marked speculative.
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
            <div className="metric"><div className="label">Cross-venue hedges</div><div className="value">{structural.filter((l) => l.uses.includes("hedge")).length}</div><div className="detail">Kalshi legs that pay if you lose</div></div>
            <div className="metric"><div className="label">Related markets</div><div className="value">{(data?.links ?? []).length}</div><div className="detail">classified Kalshi markets</div></div>
          </div>

          {data?.hedge?.available && (
            <div className="card" style={{ borderColor: "var(--go)", marginTop: 4 }}>
              <div className="section-head" style={{ marginBottom: 6 }}>
                <h2 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
                  <ShieldCheck size={18} color="var(--go)" weight="fill" /> Recommended cross-venue hedge
                </h2>
                {/* The cover leg you trade is ALWAYS a Kalshi market; the source tag reflects that.
                    cheaperVenue is a price signal, shown separately (never as the source). */}
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <VenueTag venue="kalshi" />
                  {data.hedge.cheaperVenue === "polymarket" && (
                    <span className="badge" style={{ background: "var(--accent-soft)", color: "var(--accent-strong)" }}>Cheaper on Polymarket</span>
                  )}
                </span>
              </div>
              <p className="sub" style={{ marginTop: 0 }}>
                Buy <strong>NO</strong> on <strong>{data.hedge.coverLabel}</strong> ({data.hedge.coverTicker}) — it pays in every
                state where your bet loses. Sized by the win-floor solver to keep at least {Math.round(data.hedge.keepFraction * 100)}% of your winnings.
              </p>
              <div className="metric-strip" style={{ marginTop: 4 }}>
                <div className="metric"><div className="label">Worst loss now</div><div className="value pnl-neg">${data.hedge.unhedgedLossUsd.toFixed(2)}</div><div className="detail">unhedged, if your bet fails</div></div>
                <div className="metric"><div className="label">Worst loss hedged</div><div className="value pnl-pos">${data.hedge.lossIfFailUsd.toFixed(2)}</div><div className="detail">after buying the cover leg</div></div>
                <div className="metric"><div className="label">Hedge spend</div><div className="value">${data.hedge.spendUsd.toFixed(2)}</div><div className="detail">live near-touch + fee</div></div>
                <div className="metric"><div className="label">Kept if you win</div><div className="value pnl-pos">${data.hedge.keepIfWinUsd.toFixed(2)}</div><div className="detail">winnings after the hedge</div></div>
              </div>
              <div className="note-box" style={{ marginTop: 8 }}>{data.hedge.venueNote}</div>
              <div className="toolbar" style={{ marginTop: 8 }}>
                <a className="primarybtn" target="_blank" rel="noreferrer" href={data.hedge.coverDeepLink}>Open the cover market on Kalshi <ArrowSquareOut size={14} /></a>
              </div>
            </div>
          )}

          {structural.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="section-head"><h2 style={{ margin: 0 }}>Structural links</h2><span className="muted">exact — usable as cross-venue hedges or amplifiers</span></div>
              <div className="card-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12, marginTop: 10 }}>
                {structural.map((l) => <LinkCard key={l.kalshiTicker + l.rule} link={l} />)}
              </div>
            </div>
          )}

          {speculative.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="section-head"><h2 style={{ margin: 0 }}>Related context</h2><span className="muted">speculative — correlated colour, not a hedge</span></div>
              <div className="card-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12, marginTop: 10 }}>
                {speculative.map((l) => <LinkCard key={l.kalshiTicker + l.rule} link={l} />)}
              </div>
            </div>
          )}
        </>
      )}

      <div className="disclaimer">
        Not financial advice. Prices are live market-implied mids, not forecasts. Only structural links (same-bet, mutually
        exclusive, containment) guarantee a payoff relationship; thematic and narrative links are correlated context and may
        move independently of your bet. Execution stays on each venue — HedgeAdvisor never holds funds or keys.
      </div>
    </div>
  );
}
