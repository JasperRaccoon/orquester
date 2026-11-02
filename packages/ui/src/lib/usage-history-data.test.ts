/**
 * `useUsageHistory` in a DOM with a stub client whose answers the test hands out: the last
 * answer stays while another loads, late answers never replace newer ones, failures keep the
 * data, a scanning answer is refetched once with `refresh=1`, and another daemon drops it all.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { UsageHistoryResponse } from "@orquester/api";

import { ApiError, type ApiClient } from "./api-client.ts";
import { useUsageHistory, usageHistoryLoading, usageHistoryUpdating, type UsageHistoryHandle } from "./usage-history-data.ts";

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Element", "Node", "navigator"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(() => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value: (dom.window as unknown as Record<string, unknown>)[name],
      configurable: true,
      writable: true
    });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

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
    sessions: { total: 0, byAgent: {}, byModel: {}, byProject: {}, byProjectAgent: {} },
    sources: [],
    recordedSince: null,
    scanning: false,
    asOf: new Date().toISOString(),
    costSource: "api_equivalent",
    ...over
  };
}

interface Call {
  range: string;
  force: boolean;
  resolve: (data: UsageHistoryResponse) => void;
  reject: (error: unknown) => void;
}

/** A client whose history requests wait until the test answers them. */
function stubApi(): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const api = {
    getUsageHistory: (range: string, _timeZone: string, force?: boolean) =>
      new Promise<UsageHistoryResponse>((resolve, reject) => calls.push({ range, force: force === true, resolve, reject }))
  } as unknown as ApiClient;
  return { api, calls };
}

describe("useUsageHistory", () => {
  let root: Root;
  let handle: UsageHistoryHandle;
  /** Read through a call, so one assertion's narrowing never sticks to the next render's state. */
  const state = () => handle.state;

  const Probe = (props: { api: ApiClient; scope: string; range: string }) => {
    handle = useUsageHistory(props.api, props.scope, props.range, "UTC", false);
    return null;
  };
  const render = async (api: ApiClient, range: string, scope = "c1") => {
    await act(async () => root.render(createElement(Probe, { api, scope, range })));
  };
  const settle = async (fn: () => void) => {
    await act(async () => {
      fn();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  it("keeps the last answer on screen, dimmed, while another range loads, and drops a late answer", async () => {
    const { api, calls } = stubApi();
    await render(api, "30d");
    assert.equal(state().data, null, "first load: nothing to show yet");
    await settle(() => calls[0]!.resolve(answer("30d")));
    assert.equal(usageHistoryLoading(state(), "30d"), false);

    await render(api, "7d");
    assert.equal(state().data?.range, "30d", "the 30-day answer stays until the 7-day one arrives");
    assert.equal(usageHistoryLoading(state(), "7d"), true);

    await render(api, "24h");
    await settle(() => calls[1]!.resolve(answer("7d")));
    assert.equal(state().data?.range, "30d", "the 7-day answer came after the 24-hour request");
    await settle(() => calls[2]!.resolve(answer("24h")));
    assert.equal(state().data?.range, "24h");
    assert.equal(usageHistoryLoading(state(), "24h"), false);
  });

  it("a failure keeps the last data and a later answer clears it; a 404 says the daemon is too old", async () => {
    const { api, calls } = stubApi();
    await render(api, "30d");
    await settle(() => calls[0]!.resolve(answer("30d")));

    await settle(() => handle.refetch(false));
    assert.equal(usageHistoryLoading(state(), "30d"), false, "an unforced poll of the same range does not dim");
    assert.equal(usageHistoryUpdating(state()), false);
    await settle(() => calls[1]!.reject(new Error("connection refused")));
    assert.equal(state().error, "failed");
    assert.equal(state().data?.range, "30d");
    await settle(() => handle.refetch(false));
    await settle(() => calls[2]!.resolve(answer("30d")));
    assert.equal(state().error, null);

    const old = stubApi();
    await render(old.api, "30d", "c2");
    await settle(() => old.calls[0]!.reject(new ApiError(404, "GET", "/api/usage/history")));
    assert.equal(state().error, "too-old");
  });

  it("refetches a scanning answer once with refresh=1, and never forces one only because its asOf looks old", async () => {
    const { api, calls } = stubApi();
    await render(api, "30d");
    await settle(() => calls[0]!.resolve(answer("30d", { scanning: true })));
    assert.deepEqual(calls.map((c) => c.force), [false, true]);
    assert.equal(usageHistoryUpdating(state()), true);
    assert.equal(usageHistoryLoading(state(), "30d"), true);
    await settle(() => calls[1]!.resolve(answer("30d", { scanning: true })));
    assert.equal(calls.length, 2, "a forced answer is never forced again");
    assert.equal(usageHistoryUpdating(state()), false);

    // The daemon's clock is not this device's: an asOf ten minutes "ago" is no reason to rescan.
    const skewed = stubApi();
    await render(skewed.api, "30d", "c2");
    await settle(() => skewed.calls[0]!.resolve(answer("30d", { asOf: new Date(Date.now() - 600_000).toISOString() })));
    assert.deepEqual(skewed.calls.map((c) => c.force), [false]);
    assert.equal(usageHistoryUpdating(state()), false);
  });

  it("another daemon drops the data, and the previous one's late answer never shows", async () => {
    const first = stubApi();
    await render(first.api, "30d");
    await settle(() => first.calls[0]!.resolve(answer("30d")));
    await settle(() => handle.refetch(false));

    const second = stubApi();
    await render(second.api, "30d", "c2");
    assert.equal(state().data, null);
    await settle(() => first.calls[1]!.resolve(answer("30d")));
    assert.equal(state().data, null);
  });
});
