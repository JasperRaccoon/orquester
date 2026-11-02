// Builders for Usage history responses in the Usage view's tests.

import type {
  UsageHistoryBucket,
  UsageHistoryProjectBucket,
  UsageHistoryResponse,
  UsageTokenTotals
} from "@orquester/api";

export function tokens(partial: Partial<UsageTokenTotals> = {}): UsageTokenTotals {
  return { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0, ...partial };
}

/** A priced bucket by default; pass `costUsd: null` (and `costSource: "unpriced"`) for an unpriced one. */
export function bucket(partial: Partial<UsageHistoryBucket> & Pick<UsageHistoryBucket, "period" | "agent" | "model">): UsageHistoryBucket {
  return {
    speed: "standard",
    tokens: tokens(),
    requests: 1,
    costUsd: 0,
    cost: null,
    costSource: "estimated",
    cacheSavingsUsd: 0,
    unpricedTokens: 0,
    ...partial
  };
}

export function projectBucket(
  partial: Partial<UsageHistoryProjectBucket> & Pick<UsageHistoryProjectBucket, "project" | "agent" | "model">
): UsageHistoryProjectBucket {
  return { tokens: tokens(), requests: 1, costUsd: 0, unpricedTokens: 0, ...partial };
}

export function historyResponse(partial: Partial<UsageHistoryResponse> = {}): UsageHistoryResponse {
  return {
    range: "7d",
    resolution: "day",
    timeZone: "UTC",
    since: "2026-10-27T00:00:00.000Z",
    until: "2026-11-03T00:00:00.000Z",
    periods: ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"],
    buckets: [],
    projectBuckets: [],
    sessions: { total: 0, byAgent: {}, byModel: {}, byProject: {}, byProjectAgent: {} },
    sources: [],
    recordedSince: null,
    scanning: false,
    asOf: "2026-11-02T12:00:00.000Z",
    costSource: "api_equivalent",
    ...partial
  };
}
