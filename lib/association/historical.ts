export interface HistoricalAssociationSample {
  sampleKey: string;
  clusterKey: string;
  anchorMarketId: string;
  candidateMarketId: string;
  anchorPaysYes: boolean;
  candidateYes: boolean;
  resolvedAt: string;
  /** Timestamp of the archived forecast/price, never an ingestion timestamp invented after settlement. */
  observedAt: string;
  anchorProbYes: number;
  candidatePrice: number;
}

export interface HistoricalRejectedSample {
  sampleKey: string;
  reason: string;
}

const validTime = (value: string) => Number.isFinite(Date.parse(value));

/** Fail-closed validation for archived samples. A missing historical timestamp or price cannot be
 * repaired with today's value because that would introduce look-ahead bias. */
export function validateHistoricalAssociationSamples(
  input: HistoricalAssociationSample[],
  minLeadHours = 24,
): { accepted: HistoricalAssociationSample[]; rejected: HistoricalRejectedSample[] } {
  const leadMs = Math.max(0, minLeadHours) * 3_600_000;
  const accepted: HistoricalAssociationSample[] = [];
  const rejected: HistoricalRejectedSample[] = [];
  const seen = new Set<string>();
  for (const row of input) {
    let reason = "";
    if (!row.sampleKey || !row.clusterKey || !row.anchorMarketId || !row.candidateMarketId) reason = "missing stable identity";
    else if (seen.has(row.sampleKey)) reason = "duplicate sample key";
    else if (!validTime(row.observedAt) || !validTime(row.resolvedAt)) reason = "invalid timestamp";
    else if (Date.parse(row.observedAt) > Date.parse(row.resolvedAt) - leadMs) reason = "insufficient pre-resolution lead";
    else if (!(row.anchorProbYes > 0 && row.anchorProbYes < 1)) reason = "invalid historical anchor probability";
    else if (!(row.candidatePrice > 0 && row.candidatePrice < 1)) reason = "invalid historical candidate price";
    if (reason) rejected.push({ sampleKey: row.sampleKey || "(missing)", reason });
    else {
      seen.add(row.sampleKey);
      accepted.push(row);
    }
  }
  accepted.sort((a, b) => Date.parse(a.resolvedAt) - Date.parse(b.resolvedAt) || a.sampleKey.localeCompare(b.sampleKey));
  return { accepted, rejected };
}

/** Chronological cluster split for offline model selection. A cluster is never divided between train
 * and holdout, and the holdout always resolves after the training set. */
export function chronologicalClusterSplit(
  rows: HistoricalAssociationSample[],
  holdoutFraction = 0.2,
): { train: HistoricalAssociationSample[]; holdout: HistoricalAssociationSample[]; cutoff: string | null } {
  const fraction = Math.min(0.5, Math.max(0.05, holdoutFraction));
  const clusters = new Map<string, HistoricalAssociationSample[]>();
  for (const row of rows) clusters.set(row.clusterKey, [...(clusters.get(row.clusterKey) ?? []), row]);
  const ordered = [...clusters.entries()].sort((a, b) => {
    const ta = Math.max(...a[1].map((row) => Date.parse(row.resolvedAt)));
    const tb = Math.max(...b[1].map((row) => Date.parse(row.resolvedAt)));
    return ta - tb || a[0].localeCompare(b[0]);
  });
  if (ordered.length < 2) return { train: rows, holdout: [], cutoff: null };
  const holdoutClusters = Math.max(1, Math.ceil(ordered.length * fraction));
  const splitAt = ordered.length - holdoutClusters;
  const train = ordered.slice(0, splitAt).flatMap((entry) => entry[1]);
  const holdout = ordered.slice(splitAt).flatMap((entry) => entry[1]);
  const cutoff = holdout.length ? new Date(Math.min(...holdout.map((row) => Date.parse(row.resolvedAt)))).toISOString() : null;
  return { train, holdout, cutoff };
}

