import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { UsageHistoryResponse } from "@orquester/api";

import {
  initialUsageHistoryState,
  needsForcedRefetch,
  usageHistoryLoading,
  usageHistoryReducer as reduce,
  usageHistoryUpdating,
  type UsageHistoryState
} from "./usage-history-data.ts";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");

function answer(range: string, over: Partial<UsageHistoryResponse> = {}): UsageHistoryResponse {
  return {
    range,
    resolution: range === "24h" ? "hour" : "day",
    timeZone: "UTC",
    since: "2026-10-04T00:00:00.000Z",
    until: "2026-11-03T00:00:00.000Z",
    periods: [],
    buckets: [],
    projectBuckets: [],
    sessions: { total: 0, byAgent: {}, byModel: {}, byProject: {} },
    sources: [],
    recordedSince: null,
    scanning: false,
    asOf: new Date(NOW - 5_000).toISOString(),
    costSource: "api_equivalent",
    ...over
  };
}

const request = (state: UsageHistoryState, id: number, range: string, force = false) =>
  reduce(state, { type: "request", request: { id, range, force } });

describe("usage history data", () => {
  it("keeps the last answer on screen, dimmed, while another range loads", () => {
    let state = request(initialUsageHistoryState, 1, "30d");
    assert.equal(state.data, null, "first load: nothing to show yet");
    state = reduce(state, { type: "answer", id: 1, data: answer("30d") });
    assert.equal(usageHistoryLoading(state, "30d"), false);

    state = request(state, 2, "7d");
    assert.equal(state.data?.range, "30d", "the 30-day answer stays until the 7-day one arrives");
    assert.equal(usageHistoryLoading(state, "7d"), true);
    state = reduce(state, { type: "answer", id: 2, data: answer("7d") });
    assert.equal(state.data?.range, "7d");
    assert.equal(usageHistoryLoading(state, "7d"), false);
  });

  it("ignores a late answer or failure for a request that is no longer current", () => {
    let state = request(initialUsageHistoryState, 1, "30d");
    state = request(state, 2, "7d");
    state = reduce(state, { type: "answer", id: 1, data: answer("30d") });
    assert.equal(state.data, null, "the 30-day answer came after the 7-day request");
    state = reduce(state, { type: "fail", id: 1, status: 500 });
    assert.equal(state.error, null);
    state = reduce(state, { type: "answer", id: 2, data: answer("7d") });
    assert.equal(state.data?.range, "7d");
  });

  it("a failure keeps the last data; a 404 says the daemon is too old", () => {
    let state = reduce(request(initialUsageHistoryState, 1, "30d"), { type: "answer", id: 1, data: answer("30d") });
    state = reduce(request(state, 2, "30d"), { type: "fail", id: 2, status: 502 });
    assert.equal(state.error, "failed");
    assert.equal(state.data?.range, "30d");
    state = reduce(request(state, 3, "30d"), { type: "answer", id: 3, data: answer("30d") });
    assert.equal(state.error, null, "a later answer clears it");

    const old = reduce(request(initialUsageHistoryState, 1, "30d"), { type: "fail", id: 1, status: 404 });
    assert.equal(old.error, "too-old");
  });

  it("a scanning or old answer asks once for a forced refetch, shown as updating", () => {
    for (const stale of [answer("30d", { scanning: true }), answer("30d", { asOf: new Date(NOW - 61_000).toISOString() })]) {
      let state = reduce(request(initialUsageHistoryState, 1, "30d"), { type: "answer", id: 1, data: stale });
      assert.equal(needsForcedRefetch(state, NOW), true);
      state = request(state, 2, "30d", true);
      assert.equal(needsForcedRefetch(state, NOW), false, "not while one runs");
      assert.equal(usageHistoryUpdating(state), true);
      assert.equal(usageHistoryLoading(state, "30d"), true);
      state = reduce(state, { type: "answer", id: 2, data: stale });
      assert.equal(needsForcedRefetch(state, NOW), false, "a forced answer is never forced again");
      assert.equal(usageHistoryUpdating(state), false);
    }
    const fresh = reduce(request(initialUsageHistoryState, 1, "30d"), { type: "answer", id: 1, data: answer("30d") });
    assert.equal(needsForcedRefetch(fresh, NOW), false);
  });

  it("an unforced poll of the same range neither dims nor shows updating", () => {
    let state = reduce(request(initialUsageHistoryState, 1, "30d"), { type: "answer", id: 1, data: answer("30d") });
    state = request(state, 2, "30d");
    assert.equal(usageHistoryLoading(state, "30d"), false);
    assert.equal(usageHistoryUpdating(state), false);
  });

  it("a reset (another daemon) drops the data and makes any answer in flight late", () => {
    let state = reduce(request(initialUsageHistoryState, 1, "30d"), { type: "answer", id: 1, data: answer("30d") });
    state = request(state, 2, "30d");
    state = reduce(state, { type: "reset" });
    assert.equal(state.data, null);
    state = reduce(state, { type: "answer", id: 2, data: answer("30d") });
    assert.equal(state.data, null, "the previous daemon's answer never shows");
  });
});
