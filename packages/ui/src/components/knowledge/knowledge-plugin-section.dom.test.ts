/**
 * Settings → Plugins → Knowledge Graph in a DOM: only the indexing settings
 * while the plugin is off; Activity from the knowledge store (live on a `knowledge.status` event),
 * a worker chat's transcript opened read-only in place (never its folder as a project), the
 * rebuild confirmation with its estimate, "Open Knowledge tab"; and the
 * indexing settings saved with a PUT of what changed, showing the daemon's
 * refusal.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  KNOWLEDGE_CHANNEL,
  KNOWLEDGE_STATUS_EVENT,
  type AgentAccountsResponse,
  type KnowledgeSettings,
  type UpdateKnowledgeSettingsRequest
} from "@orquester/api";

import { event, status } from "../../lib/knowledge/fixtures.test-helpers";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let useAppStore: typeof import("../../store/app").useAppStore;
let knowledgeStore: typeof import("../../lib/knowledge/store").knowledgeStore;
let resetKnowledge: typeof import("../../lib/knowledge/store").resetKnowledge;
let applyKnowledgeEvent: typeof import("../../lib/knowledge/store").applyKnowledgeEvent;
let KnowledgePluginSection: typeof import("./KnowledgePluginSection").KnowledgePluginSection;
let OrquesterProvider: typeof import("../../context/orquester-context").OrquesterProvider;
let ApiError: typeof import("../../lib/api-client").ApiError;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Node", "navigator", "KeyboardEvent", "MouseEvent", "FocusEvent", "Event", "requestAnimationFrame", "cancelAnimationFrame", "localStorage"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value: (dom.window as unknown as Record<string, unknown>)[name], configurable: true, writable: true });
  }
  // The transcript's timeline scrolls its list; jsdom lays nothing out.
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ useAppStore } = await import("../../store/app"));
  ({ knowledgeStore, resetKnowledge, applyKnowledgeEvent } = await import("../../lib/knowledge/store"));
  ({ KnowledgePluginSection } = await import("./KnowledgePluginSection"));
  ({ OrquesterProvider } = await import("../../context/orquester-context"));
  ({ ApiError } = await import("../../lib/api-client"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const ACCOUNTS: AgentAccountsResponse = {
  accounts: [
    { id: "c1", agent: "claude", label: "me@example.com", email: null, plan: null, needsReauth: false, createdAt: "", importedAt: "" },
    { id: "c2", agent: "claude", label: "Work", email: null, plan: null, needsReauth: false, createdAt: "", importedAt: "" },
    { id: "x1", agent: "codex", label: "Codex", email: null, plan: null, needsReauth: false, createdAt: "", importedAt: "" }
  ],
  defaults: { claude: null, codex: null, grok: null }
};

const PROJECT = { name: "app", path: "/w/ws/app", workspace: "ws" };

describe("the Knowledge Graph plugin section", () => {
  let root: Root;
  let calls: string[];
  let puts: UpdateKnowledgeSettingsRequest[];
  let settings: KnowledgeSettings;
  let refuse: unknown;
  let initial: ReturnType<typeof useAppStore.getState>;
  let copied: string[];
  let streamed: string[];

  const pending = () => new Promise<never>(() => {});
  const agentChat = {
    stream: (sessionId: string) => {
      streamed.push(sessionId);
      return { lastSeq: 0, hostInstanceId: null, resetCursor: () => {}, retry: () => {}, close: () => {} };
    },
    command: pending,
    switchAccount: pending,
    switchProfile: pending,
    read: pending,
    readItem: pending,
    readHistory: pending,
    search: pending,
    turnDiff: pending,
    providers: async () => ({ providers: [], hostInstanceId: "h1" }),
    refreshProvider: pending,
    upload: pending,
    fetchAttachment: pending
  };

  const api = {
    connection: { id: "c1" },
    agentChat,
    getKnowledgeStatus: async () => (calls.push("status"), knowledgeStore.getState().status ?? status()),
    listKnowledgeCollections: async () => ({ collections: [], unfiledCount: 0, totalEntries: 0 }),
    getKnowledgeSettings: async () => (calls.push("settings"), settings),
    updateKnowledgeSettings: async (req: UpdateKnowledgeSettingsRequest) => {
      puts.push(req);
      if (refuse) throw refuse;
      settings = { ...settings, ...req };
      return settings;
    },
    getKnowledgeRebuildEstimate: async () => (calls.push("estimate"), { entries: 12, tasks: 340 }),
    rebuildKnowledge: async () => (calls.push("rebuild"), {})
  };

  beforeEach(() => {
    initial = { ...useAppStore.getState() };
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    calls = [];
    puts = [];
    copied = [];
    streamed = [];
    Object.defineProperty(dom.window.navigator, "clipboard", {
      value: { writeText: async (value: string) => void copied.push(value) },
      configurable: true
    });
    refuse = null;
    settings = { accountId: null, model: null, concurrency: 4 };
    resetKnowledge();
  });

  afterEach(() => {
    act(() => root.unmount());
    useAppStore.setState(initial, true);
    resetKnowledge();
  });

  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
  };

  const show = async (enabled = true) => {
    useAppStore.setState({
      api: api as never,
      agentAccounts: ACCOUNTS,
      currentProject: PROJECT as never,
      projects: [PROJECT] as never,
      workspaces: [{ name: "ws" }] as never,
      settingsOpen: true
    });
    knowledgeStore.setState({ status: status() });
    await act(async () =>
      root.render(
        createElement(OrquesterProvider, {
          runtime: "web",
          api: api as never,
          useTitlebar: false,
          children: createElement(KnowledgePluginSection, { enabled })
        })
      )
    );
    await settle();
  };

  const doc = () => dom.window.document;
  const text = () => doc().body.textContent ?? "";
  const buttonNamed = (name: string) => {
    const found = [...doc().querySelectorAll("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
    assert.ok(found, `a button "${name}"`);
    return found as HTMLButtonElement;
  };
  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await settle();
  };
  const field = <T extends HTMLElement>(label: string): T => {
    const element = [...doc().querySelectorAll("label")].find((l) => l.textContent?.trim() === label);
    assert.ok(element, `a field "${label}"`);
    return doc().getElementById(element.htmlFor) as T;
  };
  const type = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const choose = async (select: HTMLSelectElement, value: string) => {
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
  };

  it("while the plugin is off shows no activity, but the indexing settings to prepare it", async () => {
    await show(false);
    assert.doesNotMatch(text(), /Activity|Rebuild graph/);
    assert.ok(!calls.includes("status"), "no status read");
    assert.ok(calls.includes("settings"), "the settings are read (the daemon answers them while off)");
    await choose(field<HTMLSelectElement>("Indexing account"), "c2");
    await click(buttonNamed("Save"));
    assert.deepEqual(puts, [{ accountId: "c2" }]);
  });

  it("shows the activity and follows knowledge.status events", async () => {
    await show();
    assert.match(text(), /2 entries · 3 concepts · 2 collections/);
    assert.match(text(), /Linking idle/);
    assert.match(text(), /Last run\s*Never/);
    assert.match(text(), /Tokens this week\s*None yet/);

    await act(async () => {
      applyKnowledgeEvent(
        event(KNOWLEDGE_CHANNEL, KNOWLEDGE_STATUS_EVENT, {
          ...status({ entries: 7 }),
          linking: { state: "paused", reason: "usage-limit", message: "Every account is limited.", resumesAt: null, pendingEntries: 2 },
          lastRun: {
            id: "r1",
            mode: "update",
            startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
            finishedAt: null,
            durationMs: 252_000,
            entries: 3,
            tasks: 48,
            tokensIn: 1_234_567,
            tokensOut: 34_000,
            outcome: "ok",
            error: null
          },
          tokens: { week: { in: 2_000, out: 500 }, total: { in: 9_000_000, out: 1_000_000 } },
          lastError: { message: "myKG exited with 1", at: new Date().toISOString() }
        }) as never
      );
    });
    assert.match(text(), /7 entries/);
    assert.match(text(), /Linking paused: every Claude account is at its usage limit/);
    assert.match(text(), /Every account is limited\./);
    assert.match(text(), /Update · finished · 2h ago · took 4m/);
    assert.match(text(), /3 entries · 48 tasks · 1.2M in · 34k out/);
    assert.match(text(), /Tokens this week\s*2k in · 500 out/);
    assert.match(text(), /Tokens in total\s*9M in · 1M out/);
    assert.match(text(), /myKG exited with 1/);
  });

  it("opens a live worker's transcript read-only in place, never its folder as a project; a closed one offers its id", async () => {
    await show();
    // A worker chat's "project" is the plugin's workers folder (no workspace, no project).
    const workerChat = {
      id: "s-open",
      projectPath: "/appdir/daemon/plugins/knowledge-graph/workers",
      title: "Knowledge indexer",
      kind: "agent-chat",
      refId: "claude",
      owner: { kind: "knowledge-indexer", runId: "r1" }
    };
    useAppStore.setState({ sessions: [workerChat] as never });
    await act(async () => {
      knowledgeStore.setState({
        status: status({
          workers: [
            { sessionId: "s-open", accountId: "c1", runId: "r1", state: "running", tasks: 2, startedAt: new Date().toISOString(), finishedAt: null },
            { sessionId: "s-hidden", accountId: "c2", runId: "r1", state: "done", tasks: 5, startedAt: "2026-10-01T00:00:00Z", finishedAt: null }
          ]
        })
      });
    });
    const rows = [...doc().querySelectorAll("[data-knowledge-worker]")];
    assert.equal(rows.length, 2);
    assert.match(rows[0]!.textContent!, /Running · 2 tasks.*\bme\b/);
    assert.match(rows[1]!.textContent!, /Done · 5 tasks.*Work/);

    // A closed worker: its id, and a way to copy it.
    assert.equal(rows[1]!.querySelector("code")?.textContent, "s-hidden");
    await click(buttonNamed("Copy the session id of worker s-hidden"));
    assert.deepEqual(copied, ["s-hidden"]);

    const opened: string[] = [];
    const openProject = useAppStore.getState().openProject;
    useAppStore.setState({ openProject: ((project: { path: string }) => opened.push(project.path)) as never });
    try {
      await click(buttonNamed("Open the transcript of worker s-open"));
    } finally {
      useAppStore.setState({ openProject });
    }
    assert.deepEqual(opened, [], "no project is opened for a worker chat");
    assert.equal(useAppStore.getState().currentProject?.path, PROJECT.path);
    assert.equal(useAppStore.getState().settingsOpen, true, "Settings stays open under the transcript");
    const dialog = [...doc().querySelectorAll("[role=dialog]")].find((d) => /Worker transcript/.test(d.textContent ?? ""));
    assert.ok(dialog, "a transcript dialog");
    assert.match(dialog.textContent ?? "", /s-open/);
    assert.equal(dialog.querySelector("textarea"), null, "read-only: no composer");
    assert.deepEqual(streamed, ["s-open"], "the transcript is the worker thread's own stream");

    await click(buttonNamed("Close"));
    assert.equal([...doc().querySelectorAll("[role=dialog]")].some((d) => /Worker transcript/.test(d.textContent ?? "")), false);
  });

  it("confirms a rebuild with the estimate, then posts it", async () => {
    await show();
    await click(buttonNamed("Rebuild graph"));
    assert.ok(calls.includes("estimate"));
    assert.match(text(), /Rebuild the knowledge graph\?/);
    assert.match(text(), /about 340 tasks \(model calls\) for 12 entries/);
    assert.ok(!calls.includes("rebuild"), "nothing before the confirmation");
    await click(buttonNamed("Rebuild"));
    assert.ok(calls.includes("rebuild"));
  });

  it("shows the estimate of the latest confirmation, not one an earlier open asked for", async () => {
    await show();
    const original = api.getKnowledgeRebuildEstimate;
    const answers: Array<(value: { entries: number; tasks: number }) => void> = [];
    api.getKnowledgeRebuildEstimate = () => new Promise((resolve) => answers.push(resolve));
    try {
      await click(buttonNamed("Rebuild graph"));
      await click(buttonNamed("Cancel"));
      await click(buttonNamed("Rebuild graph"));
      assert.equal(answers.length, 2);
      await act(async () => answers[1]!({ entries: 12, tasks: 340 }));
      await settle();
      await act(async () => answers[0]!({ entries: 1, tasks: 5 }));
      await settle();
      assert.match(text(), /about 340 tasks \(model calls\) for 12 entries/);
      assert.doesNotMatch(text(), /about 5 tasks/);
    } finally {
      api.getKnowledgeRebuildEstimate = original;
    }
  });

  it("shows a refused rebuild's message", async () => {
    await show();
    const original = api.rebuildKnowledge;
    api.rebuildKnowledge = async () => {
      throw new ApiError(409, "POST", "/api/knowledge/rebuild", {}, { code: "KNOWLEDGE_BUSY", message: "A run is already going." });
    };
    try {
      await click(buttonNamed("Rebuild graph"));
      await click(buttonNamed("Rebuild"));
      assert.match(text(), /A run is already going\./);
    } finally {
      api.rebuildKnowledge = original;
    }
  });

  it("opens the Knowledge tab and closes Settings", async () => {
    await show();
    await click(buttonNamed("Open Knowledge tab"));
    assert.equal(useAppStore.getState().settingsOpen, false);
    assert.equal(useAppStore.getState().knowledgeTabsByProject[PROJECT.path]?.length, 1);
  });

  it("lists automatic and the Claude accounts, and saves only what changed", async () => {
    await show();
    const account = field<HTMLSelectElement>("Indexing account");
    assert.deepEqual(
      [...account.options].map((o) => o.textContent),
      ["Automatic (with failover)", "me", "Work"]
    );
    assert.equal(field<HTMLInputElement>("Indexing model").placeholder, "Default (Sonnet)");
    assert.ok(buttonNamed("Save").disabled, "nothing to save yet");

    await choose(account, "c2");
    await type(field<HTMLInputElement>("Concurrency"), "6");
    await click(buttonNamed("Save"));
    assert.deepEqual(puts, [{ accountId: "c2", concurrency: 6 }]);
    assert.match(text(), /Saved/);

    await type(field<HTMLInputElement>("Indexing model"), "opus");
    await choose(field<HTMLSelectElement>("Indexing account"), "");
    await click(buttonNamed("Save"));
    assert.deepEqual(puts[1], { accountId: null, model: "opus" });
  });

  it("refuses concurrency out of bounds before sending", async () => {
    await show();
    await type(field<HTMLInputElement>("Concurrency"), "12");
    assert.match(text(), /Concurrency is a whole number from 1 to 8\./);
    assert.ok(buttonNamed("Save").disabled);
    assert.deepEqual(puts, []);
  });

  it("shows the daemon's refusal and keeps the edit", async () => {
    await show();
    refuse = new ApiError(400, "PUT", "/api/knowledge/settings", {}, { code: "KNOWLEDGE_INVALID", message: "The indexing account must be a Claude account." });
    await type(field<HTMLInputElement>("Concurrency"), "2");
    await click(buttonNamed("Save"));
    assert.equal(puts.length, 1);
    assert.match(text(), /The indexing account must be a Claude account\./);
    assert.equal(field<HTMLInputElement>("Concurrency").value, "2");
  });
});
