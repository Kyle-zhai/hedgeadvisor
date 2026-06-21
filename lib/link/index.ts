export { relateCrossVenue, type RelateRequest } from "./relate";
export { classify, type KalshiRole, type Classification, type ClassifyCtx } from "./classify";
export { relateGeneric, routeCategories, isWorldCupContext, partitionsAligned } from "./relate.generic";
export { refersTo, entityMatches, sameSubject, sameEntityStrict, opponentOf, parseEntityQuery, titleOverlap } from "./match";
export type {
  LinkRule,
  LinkProvenance,
  LinkUse,
  ClaimKind,
  Venue,
  CrossVenueLink,
  CrossVenueHedge,
  RelateResult,
} from "./types";
