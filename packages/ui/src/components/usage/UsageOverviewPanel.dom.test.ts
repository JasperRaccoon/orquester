/**
 * The Usage overview's model drill-down in a DOM: a breakdown row opens the model's dialog,
 * and its "Set price" hands the model to the price editor and closes the dialog.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import { bucket, historyResponse, tokens } from "./fixtures.test-helpers";

// Loaded once the DOM globals exist: react-dom decides at load time which DOM events it can use.
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let UsageOverviewPanel: typeof import("./UsageOverviewPanel").UsageOverviewPanel;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Element", "Node", "navigator", "KeyboardEvent", "MouseEvent", "Event"] as const;
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
  ({ UsageOverviewPanel } = await import("./UsageOverviewPanel"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const data = historyResponse({
  buckets: [
    bucket({ period: 2, agent: "claude", model: "claude-opus-5", tokens: tokens({ input: 1000, output: 100 }), costUsd: 4 }),
    bucket({
      period: 4,
      agent: "codex",
      model: "gpt-6-mystery",
      tokens: tokens({ input: 5000 }),
      costUsd: null,
      costSource: "unpriced",
      unpricedTokens: 5000
    })
  ],
  sessions: { total: 3, byAgent: { claude: 2, codex: 1 }, byModel: { "claude:claude-opus-5": 2, "codex:gpt-6-mystery": 1 }, byProject: {}, byProjectAgent: {} }
});

function render(onSetPrice: (model: string) => void): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      createElement(UsageOverviewPanel, {
        data,
        metric: "cost",
        hiddenAgents: [],
        loading: false,
        breakdown: "model",
        onBreakdownChange: () => {},
        onSetPrice
      })
    )
  );
  return container;
}

/** A closed Modal gives focus back to its opener a tick later; let that run while the DOM exists. */
const modalFocusRestore = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const buttonNamed = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text) ?? null;

describe("UsageOverviewPanel chart", () => {
  it("reads an agent's unknown cost in the hover readout as Unpriced, not $0.00", () => {
    const container = render(() => {});
    const plot = container.querySelector('svg[role="img"]')!.parentElement!;
    plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 200, right: 600, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
    // Period 4 of 7: only Codex's unpriced model ran.
    act(() => {
      plot.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 400, clientY: 50 }));
    });
    const tooltip = plot.querySelector(".pointer-events-none")?.textContent ?? "";
    assert.match(tooltip, /CodexUnpriced/);
    assert.match(tooltip, /TotalUnpriced/, "Claude did nothing then; the period's only cost is unknown");
  });
});

describe("UsageOverviewPanel model dialog", () => {
  it("opens on a model row and hands the model to the price editor from Set price", async () => {
    const prices: string[] = [];
    const container = render((model) => prices.push(model));
    assert.equal(dialog(), null);

    const row = buttonNamed(container.querySelector("tbody")!, "gpt-6-mystery");
    assert.ok(row, "the unpriced model has a row");
    act(() => row.click());
    assert.match(dialog()?.textContent ?? "", /gpt-6-mystery/);

    act(() => buttonNamed(dialog()!, "Set price")!.click());
    assert.deepEqual(prices, ["gpt-6-mystery"]);
    assert.equal(dialog(), null);
    await modalFocusRestore();
  });
});
