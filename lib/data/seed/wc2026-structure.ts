/**
 * lib/data/seed/wc2026-structure.ts — hand-curated structural seed.
 *
 * The MVP within-event complement hedge does NOT need this (mutual exclusivity is
 * auto-derived from negRiskMarketId). It is the extension point for the cross-event
 * hedges in the spec (e.g. "a European team wins" superset, bracket-path edges):
 * map each team → confederation, and (once the draw/bracket is known) group + half.
 *
 * Confederations are stable; GROUPS and BRACKET HALVES are draw-dependent and must
 * be filled in once the 2026 fixtures are set — left as TODO rather than guessed.
 */

export type Confederation = "UEFA" | "CONMEBOL" | "CONCACAF" | "CAF" | "AFC" | "OFC";

export interface TeamStructure {
  team: string; // must match groupItemTitle on Polymarket
  confederation: Confederation;
  group?: string; // TODO: fill from the 2026 draw
  bracketHalf?: "left" | "right"; // TODO: fill once the bracket forms
}

/** Major contenders by confederation. Extend to the full 48-team field as needed. */
export const WC2026_TEAMS: TeamStructure[] = [
  // UEFA
  { team: "Spain", confederation: "UEFA" },
  { team: "France", confederation: "UEFA" },
  { team: "England", confederation: "UEFA" },
  { team: "Germany", confederation: "UEFA" },
  { team: "Portugal", confederation: "UEFA" },
  { team: "Netherlands", confederation: "UEFA" },
  { team: "Italy", confederation: "UEFA" },
  { team: "Belgium", confederation: "UEFA" },
  { team: "Croatia", confederation: "UEFA" },
  { team: "Denmark", confederation: "UEFA" },
  { team: "Switzerland", confederation: "UEFA" },
  // CONMEBOL
  { team: "Brazil", confederation: "CONMEBOL" },
  { team: "Argentina", confederation: "CONMEBOL" },
  { team: "Uruguay", confederation: "CONMEBOL" },
  { team: "Colombia", confederation: "CONMEBOL" },
  { team: "Ecuador", confederation: "CONMEBOL" },
  // CONCACAF (incl. hosts)
  { team: "United States", confederation: "CONCACAF" },
  { team: "Mexico", confederation: "CONCACAF" },
  { team: "Canada", confederation: "CONCACAF" },
  // CAF
  { team: "Morocco", confederation: "CAF" },
  { team: "Senegal", confederation: "CAF" },
  { team: "Nigeria", confederation: "CAF" },
  // AFC
  { team: "Japan", confederation: "AFC" },
  { team: "South Korea", confederation: "AFC" },
  { team: "Iran", confederation: "AFC" },
  { team: "Australia", confederation: "AFC" },
];

const byTeam = new Map(WC2026_TEAMS.map((t) => [t.team.toLowerCase(), t]));

export function confederationOf(team: string): Confederation | null {
  return byTeam.get(team.toLowerCase())?.confederation ?? null;
}

/** Teams sharing a confederation with `team` (the "a European team wins" basket source). */
export function sameConfederation(team: string): string[] {
  const conf = confederationOf(team);
  if (!conf) return [];
  return WC2026_TEAMS.filter((t) => t.confederation === conf).map((t) => t.team);
}
