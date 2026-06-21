export { GAMMA, CLOB, DATA, PolymarketError } from "./client";
export { normalizeBook, CannotPriceError, type RawBook } from "./book";
export {
  fetchEventBundle,
  resolvePosition,
  teamQuery,
  tokenSetScore,
  type EventBundle,
  type ResolveResult,
} from "./resolve";
export { resolveAnyPosition, type AnyResolveResult } from "./resolveAny";
export { searchEvents, searchFixtures, searchOutcomes, type MarketSuggestion } from "./search";
export { fetchBook, fetchBooks, fetchMidpoints, fetchPricesHistory, buildOutcomes, topRivals } from "./discovery";
export {
  fetchFixtures,
  resolveBet,
  resolveBetAgainst,
  resolveExactScoreCell,
  resolveExactScoreGrid,
  parseBetIntent,
  parseProp,
  resolvePropMarket,
  type PropSpec,
  type Fixture,
  type FixtureOutcome,
  type BetIntent,
  type BetType,
  type ResolveBetResult,
  type ExactScoreCell,
  type ExactScoreGrid,
} from "./fixtures";
