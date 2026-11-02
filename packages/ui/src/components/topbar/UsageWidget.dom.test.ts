/**
 * The top-bar popover's Cost tab in a DOM: an answer taken mid-scan is asked for once more with
 * `refresh=1`, and when both the history and the older token-rows route fail it says so with a
 * Retry rather than loading forever.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { UsageHistoryResponse, UsageResponse, UsageTokensResponse } from "@orquester/api";

import type { ApiClient } from "../../lib/api-client";

// Loaded once the DOM globals exist: react-dom decides at load time which DOM events it can use.
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let UsageWidget: typeof import("./UsageWidget").UsageWidget;
let useAppStore: typeof import("../../store/app").useAppStore;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Element", "Node", "navigator", "KeyboardEvent", "MouseEvent", "Event", "localStorage"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
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
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ UsageWidget } = await import("./UsageWidget"));
  ({ useAppStore } = await import("../../store/app"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function history(over: Partial<UsageHistoryResponse> = {}): UsageHistoryResponse {
  return {
    range: "14d",
    resolution: "day",
    timeZone: "UTC",
    since: "2026-10-20T00:00:00.000Z",
    until: "2026-11-03T00:00:00.000Z",
    periods: ["2026-11-01", "2026-11-02"],
    buckets: [],
    projectBuckets: [],
    sessions: { total: 0, byAgent: {}, byModel: {}, byProject: {}, byProjectAgent: {} },
    sources: [],
    recordedSince: null,
    scanning: false,
    asOf: "2026-11-02T12:00:00.000Z",
    costSource: "api_equivalent",
    ...over
  };
}

const usage: UsageResponse = {
  agents: [{ id: "claude", available: true, stale: false, session: { percent: 12 }, weekly: null, asOf: new Date().toISOString() }]
};

interface Fake {
  /** `force` per history request. */
  historyCalls: boolean[];
  /** The next answers, in order; the last one repeats. */
  histories: Array<UsageHistoryResponse | Error>;
  tokens: Array<UsageTokensResponse | Error>;
}

function fakeApi(histories: Fake["histories"], tokens: Fake["tokens"] = []): Fake & ApiClient {
  const next = <T>(list: T[]): T => (list.length > 1 ? list.shift()! : list[0]!);
  const fake: Fake & Record<string, unknown> = {
    historyCalls: [],
    histories,
    tokens,
    async getUsageHistory(_range: string, _timeZone: string, force?: boolean) {
      fake.historyCalls.push(force === true);
      const answer = next(fake.histories);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async getUsageTokens() {
      const answer = next(fake.tokens);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async getUsage() {
      return usage;
    }
  };
  return fake as unknown as Fake & ApiClient;
}

describe("the popover's Cost tab", () => {
  let root: Root;
  let initial: ReturnType<typeof useAppStore.getState>;

  beforeEach(() => {
    initial = useAppStore.getState();
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    useAppStore.setState(initial, true);
    await settle();
  });

  const click = async (element: Element) => {
    await act(async () => {
      (element as HTMLElement).click();
      await settle();
    });
  };
  const buttonNamed = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name) ?? null;

  const openCostTab = async (api: ApiClient) => {
    useAppStore.setState({ api, usage, usageTokens: null });
    await act(async () => {
      root.render(createElement(UsageWidget));
      await settle();
    });
    const chip = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("12%"))!;
    await click(chip);
    const cost = [...document.querySelectorAll('[role="radiogroup"][aria-label="Usage view"] [role="radio"]')].find(
      (b) => b.textContent?.trim() === "Cost"
    )!;
    await click(cost);
  };

  it("asks once more with refresh=1 for an answer taken mid-scan", async () => {
    const api = fakeApi([history({ scanning: true })]);
    await openCostTab(api);
    assert.deepEqual(api.historyCalls, [false, true], "the forced answer is still scanning: no third ask");
  });

  it("says it couldn't load when the history and the fallback both fail, and Retry recovers", async () => {
    const down = new Error("connection refused");
    const api = fakeApi([down, history()], [down, { rows: [], asOf: "2026-11-02T12:00:00.000Z" }]);
    await openCostTab(api);
    assert.match(document.body.textContent ?? "", /Couldn't load costs\./);
    assert.doesNotMatch(document.body.textContent ?? "", /Loading…/);

    await click(buttonNamed("Retry")!);
    assert.doesNotMatch(document.body.textContent ?? "", /Couldn't load costs\./);
    assert.match(document.body.textContent ?? "", /No agent usage recorded yet/);
  });
});
