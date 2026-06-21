/**
 * lib/polymarket/text.ts — shared text normalization for fuzzy matching/discovery.
 * One definition so resolve / resolveAny / search can't drift apart.
 */

/**
 * Lowercase, FOLD DIACRITICS (é→e, ñ→n, ü→u…), strip punctuation to spaces, collapse whitespace.
 * Diacritic folding is essential for matching player/team names across sources: "Mbappé" must
 * normalize to "mbappe", not "mbapp" (the old behavior dropped the accented char to a space).
 */
export function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks left by NFD
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
