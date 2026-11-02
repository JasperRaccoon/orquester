/**
 * `loadUsage` / `loadUsageTokens` answer after a wait: when the app has moved to another daemon
 * meanwhile, the previous daemon's late answer must not land in the store.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { UsageResponse, UsageTokensResponse } from "@orquester/api";

import type { ApiClient } from "../lib/api-client.ts";
import { useAppStore } from "./app.ts";

const storage = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key)
};

const store = () => useAppStore.getState();

describe("usage loads", () => {
  it("drop a late answer from the daemon the app has left", async () => {
    let answerUsage!: (value: UsageResponse) => void;
    let answerTokens!: (value: UsageTokensResponse) => void;
    const previous = {
      getUsage: () => new Promise<UsageResponse>((resolve) => (answerUsage = resolve)),
      getUsageTokens: () => new Promise<UsageTokensResponse>((resolve) => (answerTokens = resolve))
    } as unknown as ApiClient;
    useAppStore.setState({ api: previous, usage: null, usageReceivedAt: null, usageTokens: null });

    const usage = store().loadUsage(true);
    const tokens = store().loadUsageTokens(true);
    useAppStore.setState({ api: {} as ApiClient });
    answerUsage({ agents: [{ id: "claude", available: true, stale: false, session: { percent: 90 }, weekly: null }] });
    answerTokens({ rows: [], asOf: "2026-11-02T12:00:00.000Z" });
    await Promise.all([usage, tokens]);

    assert.equal(store().usage, null);
    assert.equal(store().usageReceivedAt, null);
    assert.equal(store().usageTokens, null);
  });
});
