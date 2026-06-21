/**
 * components/VenueTag.tsx — a small, reusable badge marking which venue a market/bet is from.
 * Used everywhere market content renders so the source (Polymarket vs Kalshi) is always explicit.
 */
export type Venue = "polymarket" | "kalshi";

const LABEL: Record<Venue, string> = { polymarket: "Polymarket", kalshi: "Kalshi" };
const SHORT: Record<Venue, string> = { polymarket: "PM", kalshi: "KS" };

export default function VenueTag({ venue, short = false }: { venue: Venue; short?: boolean }) {
  return (
    <span className={`venuetag ${venue}`} title={`Source: ${LABEL[venue]}`}>
      <span className="vdot" aria-hidden />
      {short ? SHORT[venue] : LABEL[venue]}
    </span>
  );
}
