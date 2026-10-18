/**
 * Settings → Agent config in a DOM (agent profiles spec §5.4): the per-agent
 * global config editor, moved out of the rail, renders as a Settings page —
 * reached by its own id and by the old panel's ids — and its editor opens over
 * Settings, where Escape closes the editor and leaves Settings open.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { AgentProfileAgentId, AgentProfileSnapshot, ProfileItem } from "@orquester/api";

import { OrquesterProvider } from "../../context/orquester-context";
import type { ApiClient } from "../../lib/api-client";
import { useAppStore } from "../../store/app";
import { openAgentProfileEditor } from "../right-rail/agent-profile/editor-bridge";

// Loaded once the DOM globals exist: react-dom decides at load time which DOM events it can use
// (the editor's text fields need the `input` event).
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let SettingsModal: typeof import("./SettingsModal").SettingsModal;
let AGENT_CONFIG_INTRO: string;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Element", "Node", "navigator", "KeyboardEvent", "MouseEvent", "Event", "localStorage"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  // A desktop viewport: `useIsDesktop` reads `(min-width: 768px)`.
  (dom.window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: query === "(min-width: 768px)",
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  });
  // JSDOM does no layout: the modal scrolls a new page to its top.
  (dom.window.HTMLElement.prototype as unknown as { scrollTo: () => void }).scrollTo = () => undefined;
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
  ({ SettingsModal } = await import("./SettingsModal"));
  ({ AGENT_CONFIG_INTRO } = await import("./AgentConfigSettings"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const mcp: ProfileItem = {
  id: "mcp:jira", kind: "mcp", name: "jira", enabled: true, toggleable: true, editable: true, deletable: true,
  locked: false, source: { type: "user", label: "User" }, revision: "r1", warnings: []
};

function snapshot(agent: AgentProfileAgentId): AgentProfileSnapshot {
  return {
    agent, installed: true, revision: `s-${agent}`, items: agent === "claude" ? [mcp] : [], fileErrors: [],
    readAt: "2026-10-18T00:00:00Z",
    instructions: { path: "/h/.claude/CLAUDE.md", exists: true, bytes: 5, lines: 1, revision: "i1", warnings: [] }
  };
}

const fakeApi = {
  getAgentProfileOverview: async () => ({
    agents: (["claude", "codex", "grok", "opencode"] as const).map((agent) => ({ agent, installed: agent === "claude", counts: {} }))
  }),
  getAgentProfile: async (agent: AgentProfileAgentId) => snapshot(agent),
  getDaemonMcpServers: async () => ({ servers: [] })
} as unknown as ApiClient;

describe("Settings → Agent config", () => {
  let root: Root;
  const initial = { ...useAppStore.getState() };

  beforeEach(() => {
    // Modals and the editor hand focus back on a timer after they close: run those here, not after the DOM is gone.
    mock.timers.enable({ apis: ["setTimeout"] });
    const mount = document.createElement("div");
    document.body.replaceChildren(mount);
    root = createRoot(mount);
  });

  afterEach(() => {
    act(() => root.unmount());
    mock.timers.runAll();
    mock.timers.reset();
    useAppStore.setState(initial, true);
  });

  const open = async (section: string) => {
    useAppStore.setState({
      connectionStatus: "connected",
      settingsOpen: true,
      settingsSection: section,
      loadAgentAccounts: async () => undefined
    } as never);
    await act(async () => {
      root.render(
        createElement(OrquesterProvider, {
          runtime: "web",
          api: fakeApi,
          useTitlebar: false,
          children: createElement(SettingsModal)
        })
      );
    });
    // The overview, the snapshot and the daemon-pointing read each settle on their own promise.
    for (let i = 0; i < 5; i += 1) await act(async () => undefined);
  };

  const navButton = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('nav[aria-label="Settings sections"] button')].find(
      (button) => button.textContent?.trim() === label
    );

  for (const section of ["agent-config", "profile", "agent-profile"]) {
    it(`opens on Agent config for "${section}", with the editor's list in it`, async () => {
      await open(section);
      const heading = document.querySelector("h2");
      assert.equal(heading?.textContent, "Agent config");
      assert.ok(document.body.textContent?.includes(AGENT_CONFIG_INTRO));
      assert.equal(navButton("Agent config")?.getAttribute("aria-current"), "page");
      assert.ok(document.querySelector('[data-profile-item="mcp:jira"]'), "Claude's MCP server is listed");
      assert.ok(document.querySelector('input[aria-label="Search Claude\'s config"]'), "the search names the config");
    });
  }

  it("is listed under Agents and found by a search for skills or MCP", async () => {
    await open("general");
    assert.ok(navButton("Agent config"), "in the nav");
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    for (const query of ["skills", "mcp", "CLAUDE.md"]) {
      await act(async () => {
        setter.call(search, query);
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      assert.ok(navButton("Agent config"), `"${query}" finds it`);
    }
  });

  it("opens the editor over Settings; Escape closes the editor and leaves Settings open", async () => {
    await open("agent-config");
    // What "+ Add" → MCP server asks for; the page mounts the editor's host.
    let opened = false;
    await act(async () => {
      opened = openAgentProfileEditor({ mode: "create", agent: "claude", kind: "mcp" });
    });
    assert.equal(opened, true, "Settings → Agent config hosts the editor");
    const dialogs = () => document.querySelectorAll('[role="dialog"][aria-modal="true"]').length;
    assert.equal(dialogs(), 2, "the editor is open over Settings");

    await act(async () => {
      document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(dialogs(), 1, "only the editor closed");
    assert.equal(useAppStore.getState().settingsOpen, true);
  });
});
