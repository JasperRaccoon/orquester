import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { UsageHistoryBucket, UsageHistoryResponse, UsageTokenRow } from "@orquester/api";

import { popoverCostFromHistory, popoverCostFromTokenRows } from "./usage-cost.logic.ts";

/** Oct 20 … Nov 2: fourteen local days, today last. */
const periods = [...Array.from({ length: 12 }, (_, i) => `2026-10-${20 + i}`), "2026-11-01", "2026-11-02"];

function bucket(period: number, agent: string, model: string, costUsd: number | null, over: Partial<UsageHistoryBucket> = {}): UsageHistoryBucket {
  return {
    period,
    agent,
    model,
    speed: "standard",
    tokens: { input: 100, cacheRead: 50, cacheWrite: 10, cacheWrite1h: 0, output: 40, reasoning: 0 },
    requests: 1,
    costUsd,
    cost: costUsd === null ? null : { input: costUsd / 2, cacheRead: costUsd / 4, cacheWrite: 0, output: costUsd / 4 },
    costSource: costUsd === null ? "unpriced" : "estimated",
    cacheSavingsUsd: 0,
    unpricedTokens: costUsd === null ? 200 : 0,
    ...over
  };
}

function history(buckets: UsageHistoryBucket[]): UsageHistoryResponse {
  return {
    range: "14d",
    resolution: "day",
    timeZone: "Europe/Madrid",
    since: "2026-10-19T22:00:00.000Z",
    until: "2026-11-02T23:00:00.000Z",
    periods,
    buckets,
    projectBuckets: [],
    sessions: { total: 0, byAgent: {}, byModel: {}, byProject: {} },
    sources: [],
    recordedSince: null,
    scanning: false,
    asOf: "2026-11-02T12:00:00.000Z",
    costSource: "api_equivalent"
  };
}

describe("the popover's cost from the 14-day history", () => {
  it("today is the last period, 7 days the last seven, and the chart all fourteen", () => {
    const summary = popoverCostFromHistory(
      history([bucket(13, "claude", "claude-opus-5-5", 3), bucket(10, "codex", "gpt-6-sol", 2), bucket(2, "claude", "claude-opus-5-5", 50)])
    );
    assert.equal(summary.today, 3);
    assert.equal(summary.week, 5, "the period 11 days back is outside the week");
    assert.equal(summary.chart.length, 14);
    assert.equal(summary.chart.at(-1)?.day, "2026-11-02");
    assert.deepEqual(summary.days.map((d) => [d.day, d.label]), [["2026-11-02", "Today"], ["2026-10-30", "Oct 30"], ["2026-10-22", "Oct 22"]]);
  });

  it("lists every agent, one row per model across speeds, and leaves unpriced ones out of the totals", () => {
    const summary = popoverCostFromHistory(
      history([
        bucket(12, "grok", "grok-build", 1),
        bucket(12, "opencode", "mystery-model", null),
        bucket(12, "codex", "gpt-6-sol", 2),
        bucket(12, "codex", "gpt-6-sol", 4, { speed: "fast" })
      ])
    );
    const day = summary.days[0]!;
    assert.equal(day.label, "Yesterday");
    assert.deepEqual(day.rows.map((r) => [r.agent, r.costUsd]), [["codex", 6], ["grok", 1], ["opencode", null]]);
    assert.equal(day.total, 7);
    assert.equal(day.rows[0]!.cache, 120, "cache reads and writes of both speeds");
    assert.equal(summary.hasUnpriced, true);
  });
});

describe("the popover's cost from an older daemon's token rows", () => {
  it("reads UTC days ending today", () => {
    const row = (day: string, costUsd: number | null): UsageTokenRow => ({
      agent: "claude",
      model: "claude-opus-5-5",
      day,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd,
      costSource: "api_equivalent"
    });
    const summary = popoverCostFromTokenRows([row("2026-11-02", 1.5), row("2026-10-27", 2), row("2026-10-20", 9)], Date.parse("2026-11-02T10:00:00Z"));
    assert.equal(summary.today, 1.5);
    assert.equal(summary.week, 3.5);
    assert.equal(summary.chart[0]?.day, "2026-10-20");
    assert.equal(summary.hasUnpriced, false);
  });
});
