/**
 * The price editor in a DOM over a stubbed client: "Set price" for an unpriced model opens with a
 * row for it, a save sends only the changed models and announces the change, and a draft the
 * daemon would reject is not sent.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { UsagePricesPatch, UsagePricesResponse } from "@orquester/api";

import type { ApiClient } from "../../lib/api-client";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let UsagePricesDialog: typeof import("./UsagePricesDialog").UsagePricesDialog;
let useAppStore: typeof import("../../store/app").useAppStore;
let onUsagePricesChanged: typeof import("../../lib/usage-prices-events").onUsagePricesChanged;

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
  ({ UsagePricesDialog } = await import("./UsagePricesDialog"));
  ({ useAppStore } = await import("../../store/app"));
  ({ onUsagePricesChanged } = await import("../../lib/usage-prices-events"));
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

const prices: UsagePricesResponse = {
  currency: "USD",
  unit: "per_million_tokens",
  builtin: [{ model: "claude-sonnet-4-5", rates: { input: 3, output: 15, cacheRead: 0.3 } }],
  overrides: { "gpt-6-astra": { input: 2, output: 8 } },
  aliases: { "my-proxy": "claude-sonnet-4-5" },
  seenModels: [
    { agent: "codex", model: "glm-5", status: "unpriced", pricingKey: null, aliasOf: null, tokens: 11_300_000_000 },
    { agent: "codex", model: "gpt-6-astra", status: "override", pricingKey: null, aliasOf: null, tokens: 5_000 }
  ]
};

describe("UsagePricesDialog", () => {
  let root: Root;
  let initial: ReturnType<typeof useAppStore.getState>;
  let sent: UsagePricesPatch[];
  let closed: number;

  beforeEach(() => {
    initial = useAppStore.getState();
    sent = [];
    closed = 0;
    const api = {
      getUsagePrices: async () => prices,
      updateUsagePrices: async (patch: UsagePricesPatch) => {
        sent.push(patch);
        return prices;
      }
    } as unknown as ApiClient;
    useAppStore.setState({ api });
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    useAppStore.setState(initial, true);
  });

  const open = async (initialModel?: string) => {
    await act(async () =>
      root.render(createElement(UsagePricesDialog, { open: true, onClose: () => void closed++, initialModel }))
    );
    await act(settle);
  };
  const field = (label: string) => {
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    assert.ok(input, `no field "${label}"`);
    return input;
  };
  const type = async (input: HTMLInputElement, value: string) => {
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const click = async (name: string) => {
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name
    );
    assert.ok(button, `no button "${name}"`);
    await act(async () => button.click());
    await act(settle);
  };

  it("sets a price for the model it was opened for and resets a mapping, sending only those", async () => {
    let announced = 0;
    const stop = onUsagePricesChanged(() => void announced++);
    try {
      await open("glm-5");
      const input = field("Input price for glm-5");
      assert.equal(document.activeElement, input);
      await type(input, "0,6");
      await type(field("Output price for glm-5"), "2.2");
      const resets = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Reset to automatic"]')];
      // Saved rows are listed by model id: gpt-6-astra, then my-proxy.
      await act(async () => resets[1]!.click());
      await click("Save changes");

      assert.deepEqual(sent, [{ overrides: { "glm-5": { input: 0.6, output: 2.2 } }, aliases: { "my-proxy": null } }]);
      assert.equal(announced, 1);
      assert.equal(closed, 1);
    } finally {
      stop();
    }
  });

  it("does not send a row the daemon would reject, and says what it needs", async () => {
    await open();
    await click("Add a model");
    await type(field("Model ID"), "kimi-k3");
    await type(field("Input price for kimi-k3"), "1");
    await click("Save changes");

    assert.deepEqual(sent, []);
    assert.equal(closed, 0);
    assert.ok(document.querySelector('[role="alert"]'));
  });
});
