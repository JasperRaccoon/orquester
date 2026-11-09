/**
 * Settings → Plugins → GPT Image in a DOM: Save sends what changed, the quota is the account in
 * use's from the usage the app already holds, and with no Codex account the pane opens Accounts.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { AgentAccountsResponse, GptImageSettingsResponse, UpdateGptImageSettingsRequest, UsageResponse } from "@orquester/api";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let useAppStore: typeof import("../../store/app").useAppStore;
let GptImagePluginSection: typeof import("./GptImagePluginSection").GptImagePluginSection;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "HTMLInputElement", "Node", "navigator", "MouseEvent", "Event"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value: (dom.window as unknown as Record<string, unknown>)[name], configurable: true, writable: true });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ useAppStore } = await import("../../store/app"));
  ({ GptImagePluginSection } = await import("./GptImagePluginSection"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const codex = (id: string, label: string) => ({ id, agent: "codex" as const, label, email: null, plan: "plus", needsReauth: false, createdAt: "", importedAt: "" });
const ACCOUNTS: AgentAccountsResponse = { accounts: [codex("a", "first"), codex("b", "second")], defaults: { claude: null, codex: null, grok: null } };

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const USAGE: UsageResponse = {
  agents: [
    {
      id: "codex",
      available: true,
      stale: false,
      session: { percent: 90 },
      weekly: { percent: 90 },
      accounts: [
        { id: "a", available: true, stale: false, session: { percent: 90, resetsAt: FUTURE }, weekly: { percent: 95 } },
        { id: "b", available: true, stale: false, session: { percent: 42, resetsAt: FUTURE }, weekly: { percent: 10 } }
      ]
    }
  ]
};

describe("the GPT Image plugin section", () => {
  let root: Root;
  let puts: UpdateGptImageSettingsRequest[];
  let answer: GptImageSettingsResponse;
  let initial: ReturnType<typeof useAppStore.getState>;

  const api = {
    getGptImageSettings: async () => answer,
    updateGptImageSettings: async (req: UpdateGptImageSettingsRequest) => {
      puts.push(req);
      answer = { ...answer, settings: { ...answer.settings, ...req } };
      return answer;
    }
  };

  beforeEach(() => {
    initial = { ...useAppStore.getState() };
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    puts = [];
    answer = {
      settings: { account: "auto", saveTo: { kind: "chat" } },
      accounts: [
        { id: "a", label: "first", email: null, plan: "plus" },
        { id: "b", label: "second", email: null, plan: "pro" }
      ],
      // "a" is out of quota, so Auto uses "b".
      activeAccountId: "b"
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    useAppStore.setState(initial, true);
  });

  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
  };

  const show = async () => {
    useAppStore.setState({ api: api as never, connectionStatus: "connected", agentAccounts: ACCOUNTS, usage: USAGE, settingsOpen: true });
    await act(async () => root.render(createElement(GptImagePluginSection, { enabled: true })));
    await settle();
  };

  const doc = () => dom.window.document;
  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await settle();
  };
  const button = (name: string): HTMLButtonElement => {
    const found = [...doc().querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
    assert.ok(found, `a button "${name}"`);
    return found as HTMLButtonElement;
  };

  it("saves only what changed, and shows the quota of the account in use", async () => {
    await show();
    const meters = [...doc().querySelectorAll('[role="meter"]')].map((m) => m.getAttribute("aria-valuenow"));
    assert.deepEqual(meters, ["42", "10"], "the 5-hour and weekly usage of the account Auto uses now");

    await click(button("Project folder"));
    await click(button("Save"));
    assert.deepEqual(puts, [{ saveTo: { kind: "project", folder: "assets/generated" } }]);
  });

  it("with no Codex account connected, the pane opens Settings → Accounts", async () => {
    answer = { ...answer, accounts: [], activeAccountId: null };
    await show();
    await click(button("Connect a ChatGPT account"));
    assert.equal(useAppStore.getState().settingsSection, "accounts");
    assert.equal(doc().querySelectorAll('[role="meter"]').length, 0, "no quota without an account");
  });
});
