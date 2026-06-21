export const ANALYSIS_HISTORY_KEY = "hedgeadvisor.analysis.history.v1";

export type AnalysisType = "Protect" | "Plan" | "Combo";

export interface AnalysisHistoryRecord {
  id: string;
  createdAt: string;
  type: AnalysisType;
  market: string;
  position: string;
  stakeUsd: number;
  recommendation: string;
  maxLossBeforeUsd: number;
  maxLossAfterUsd: number;
  estimatedCostUsd: number;
  status: "Analyzed" | "Executed";
  href: string;
}

export function readAnalysisHistory(): AnalysisHistoryRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ANALYSIS_HISTORY_KEY);
    return raw ? (JSON.parse(raw) as AnalysisHistoryRecord[]) : [];
  } catch {
    return [];
  }
}

export function writeAnalysisHistory(record: AnalysisHistoryRecord) {
  if (typeof window === "undefined") return;
  try {
    const existing = readAnalysisHistory();
    const deduped = existing.filter((item) => !(item.type === record.type && item.market === record.market && item.position === record.position && Math.abs(new Date(item.createdAt).getTime() - new Date(record.createdAt).getTime()) < 30_000));
    window.localStorage.setItem(ANALYSIS_HISTORY_KEY, JSON.stringify([record, ...deduped].slice(0, 100)));
  } catch {
    // Local history is optional and must not interrupt pricing.
  }
}
