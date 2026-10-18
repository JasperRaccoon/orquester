/**
 * Filling an Agent Profile in a DOM (agent profiles spec §4.5, §5.1, §5.2):
 * the editor's quick actions open their dialogs; Import from Global asks
 * Replace / Keep both / Skip for a pick that exists and sends the profile's
 * revision; a stale revision reloads and says so; Git scans then takes with a
 * scope; Copy from profile and Add plugin send their sources; "⋯ → Export"
 * downloads the zip; the library's "+ New → Import profile from file" uploads
 * the file and opens the new profile.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { SessionProfileDetail, SessionProfileItem, SessionProfileSummary } from "@orquester/api";

import { OrquesterProvider } from "../../../context/orquester-context";
import type { ApiClient } from "../../../lib/api-client";
import { resetSessionProfiles } from "../../../lib/session-profiles/store";
import { useAppStore } from "../../../store/app";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let SessionProfilesPanel: typeof import("./SessionProfilesPanel").SessionProfilesPanel;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Element", "Node", "navigator", "KeyboardEvent", "MouseEvent", "Event", "localStorage"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  (dom.window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: query === "(min-width: 768px)" || query === "(min-width: 640px)",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined
  });
  (dom.window.HTMLElement.prototype as unknown as { scrollTo: () => void }).scrollTo = () => undefined;
  (dom.window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined;
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
  ({ SessionProfilesPanel } = await import("./SessionProfilesPanel"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const zero = { total: 0, enabled: 0 };
const preparation = (["claude", "codex", "grok", "opencode"] as const).map((agent) => ({ agent, state: "ready" as const, updatedAt: "t" }));

const items: SessionProfileItem[] = [{ id: "s1", kind: "skill", name: "review", enabled: true, agents: "all", description: "Review" }];

function summary(id: string, name: string, revision: string): SessionProfileSummary {
  return {
    id,
    name,
    description: "",
    revision,
    createdAt: "t",
    updatedAt: "t",
    counts: { mcp: zero, skill: { total: 1, enabled: 1 }, plugin: zero, hook: zero, command: zero },
    hasInstructions: id === "p2",
    preparation
  };
}

function detail(id: string, name: string, revision: string, extra: SessionProfileItem[] = []): SessionProfileDetail {
  return {
    ...summary(id, name, revision),
    settings: { hideBuiltinSkills: { claude: true, codex: true, grok: true, opencode: true }, claudeWorkflowTool: true },
    items: id === "p1" ? [...items, ...extra] : [{ id: "x1", kind: "command", name: "ship", enabled: true, agents: ["claude"] }],
    itemErrors: []
  };
}

interface Server {
  revision: string;
  calls: { method: string; args: unknown[] }[];
  conflictNext: boolean;
  gets: number;
}

function fakeApi(server: Server): ApiClient {
  const record = (method: string, args: unknown[]) => server.calls.push({ method, args });
  const imported = (extra: SessionProfileItem[], notes: string[] = []) => {
    server.revision = String(Number(server.revision) + 1);
    return { profile: detail("p1", "Developer", server.revision, extra), itemIds: extra.map((item) => item.id), notes };
  };
  const conflict = () => {
    server.conflictNext = false;
    server.revision = "7";
    throw Object.assign(new Error("conflict"), { status: 409, body: { error: { code: "PROFILE_CONFLICT", message: "stale" } } });
  };
  return {
    connection: { id: "c1" },
    listSessionProfiles: async () => ({ profiles: [summary("p1", "Developer", server.revision), summary("p2", "Editor", "1")], errors: [] }),
    getSessionProfile: async (profileId: string) => {
      server.gets += 1;
      return profileId === "p1" ? detail("p1", "Developer", server.revision) : detail("p2", "Editor", "1");
    },
    getSessionProfileGlobalSource: async (...args: unknown[]) => {
      record("globalSource", args);
      return {
        agent: args[1],
        installed: true,
        instructions: { exists: true, bytes: 10 },
        items: [
          { id: "skill:review", kind: "skill", name: "review", exists: true },
          { id: "mcp:jira", kind: "mcp", name: "jira", exists: false },
          { id: "skill:p:brainstorm", kind: "skill", name: "p:brainstorm", exists: false, unavailable: "It comes with the plugin p: add the plugin instead." }
        ]
      };
    },
    importSessionProfileFromGlobal: async (...args: unknown[]) => {
      record("importFromGlobal", args);
      if (server.conflictNext) conflict();
      return imported([{ id: "n1", kind: "skill", name: "review-2", enabled: true, agents: "all" }], ['Added the skill "review" as "review-2": the profile already has one.']);
    },
    scanSessionProfileGitImport: async (...args: unknown[]) => {
      record("scanGit", args);
      return { importId: "imp1", candidates: [{ ref: "commands/ship.md", kind: "command", name: "ship", exists: false }], notes: [] };
    },
    takeSessionProfileImport: async (...args: unknown[]) => {
      record("take", args);
      return imported([{ id: "n2", kind: "command", name: "ship", enabled: true, agents: ["claude", "codex"] }]);
    },
    copySessionProfileItems: async (...args: unknown[]) => {
      record("copy", args);
      return imported([{ id: "n3", kind: "command", name: "ship", enabled: true, agents: ["claude"] }]);
    },
    getAgentProfile: async (agent: string) => ({
      agent,
      installed: true,
      revision: "r",
      instructions: { path: "", exists: false, bytes: 0, lines: 0, revision: "", warnings: [] },
      items: [
        {
          id: "marketplace:acme",
          kind: "marketplace",
          name: "acme",
          enabled: true,
          toggleable: false,
          editable: false,
          deletable: true,
          locked: false,
          source: { type: "user", label: "User" },
          revision: "r",
          warnings: []
        }
      ],
      fileErrors: [],
      readAt: "t"
    }),
    listAgentProfileMarketplacePlugins: async () => ({ plugins: [{ name: "superpowers", description: "Skills", version: "2.0.0", installed: false }] }),
    addSessionProfilePlugin: async (...args: unknown[]) => {
      record("addPlugin", args);
      return imported([
        { id: "n4", kind: "plugin", name: "superpowers", enabled: true, agents: ["claude"], plugin: { name: "superpowers", marketplace: "acme", cached: true } }
      ]);
    },
    exportSessionProfile: async (...args: unknown[]) => {
      record("export", args);
      return new Uint8Array([80, 75, 5, 6]).buffer;
    },
    importSessionProfile: async (...args: unknown[]) => {
      record("importProfile", args);
      return { profile: detail("p2", "Editor", "1"), notes: ['Secret values are never exported: enter them again for "jira".'] };
    }
  } as unknown as ApiClient;
}

describe("Agent Profiles — filling a profile", () => {
  let root: Root;
  let server: Server;
  const initial = { ...useAppStore.getState() };

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    resetSessionProfiles();
    server = { revision: "1", calls: [], conflictNext: false, gets: 0 };
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

  const flush = async () => {
    for (let i = 0; i < 8; i += 1) await act(async () => undefined);
  };

  const render = async () => {
    useAppStore.setState({ connectionStatus: "connected" } as never);
    await act(async () => {
      root.render(
        createElement(OrquesterProvider, {
          runtime: "web",
          api: fakeApi(server),
          useTitlebar: false,
          children: createElement(SessionProfilesPanel, { sessionId: null, projectPath: "", variant: "docked" })
        })
      );
    });
    await flush();
  };

  const click = async (element: Element | null | undefined) => {
    assert.ok(element, "the element exists");
    await act(async () => {
      (element as HTMLElement).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flush();
  };

  const buttonByText = (text: string, within: ParentNode = document) =>
    [...within.querySelectorAll("button")].find((button) => button.textContent?.trim() === text);
  const dialog = () => document.querySelector('[role="dialog"]');
  const calls = (method: string) => server.calls.filter((call) => call.method === method);
  const notice = () => document.querySelector("[data-session-profiles-notice]")?.textContent ?? "";

  const openDeveloper = async () => {
    await render();
    await click(document.querySelector('[data-profile-card="p1"]'));
    await click(document.querySelector('[data-kind-cell="skill"]'));
  };

  const typeInto = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };

  it("shows the quick actions, and the Plugins tab's Add plugin", async () => {
    await openDeveloper();
    const group = document.querySelector("[data-profile-import-actions]");
    assert.ok(group, "the quick actions row is drawn");
    assert.deepEqual(
      [...group!.querySelectorAll("button")].map((button) => button.textContent?.trim()),
      ["Import from Global", "Git", ".zip", "Copy from profile"]
    );
    await click(document.querySelector('[data-kind-cell="plugin"]'));
    assert.ok(buttonByText("Add plugin"));
  });

  it("Import from Global: unavailable rows are disabled, an existing pick asks first, the revision is sent", async () => {
    await openDeveloper();
    await click(buttonByText("Import from Global"));
    assert.ok(dialog(), "the dialog opened");
    assert.deepEqual(calls("globalSource")[0]!.args, ["p1", "claude", calls("globalSource")[0]!.args[2]]);
    const plugin = dialog()!.querySelector<HTMLInputElement>('[data-pick="skill:p:brainstorm"]')!;
    assert.equal(plugin.disabled, true);
    await click(dialog()!.querySelector('[data-pick="skill:review"]'));
    await click(buttonByText("Import 1", dialog()!));
    assert.equal(calls("importFromGlobal").length, 0, "nothing is sent before the conflict is answered");
    assert.match(dialog()!.textContent ?? "", /review is already in this profile/);
    await click(buttonByText("Keep both", dialog()!));
    const [profileId, body] = calls("importFromGlobal")[0]!.args as [string, Record<string, unknown>];
    assert.equal(profileId, "p1");
    assert.deepEqual(body, { revision: "1", agent: "claude", itemIds: ["skill:review"], agents: "all", onConflict: "keep-both" });
    assert.equal(dialog(), null, "it closed");
    assert.match(notice(), /Added 1 item\. Added the skill "review" as "review-2"/);
    assert.ok(document.querySelector('[data-session-profile-item="n1"]'), "the new item is listed");
  });

  it("a stale revision reloads the profile and says so; the retry carries the fresh one", async () => {
    await openDeveloper();
    await click(buttonByText("Import from Global"));
    await click(dialog()!.querySelector('[data-pick="mcp:jira"]'));
    server.conflictNext = true;
    const before = server.gets;
    await click(buttonByText("Import 1", dialog()!));
    assert.ok(server.gets > before, "the profile was read again");
    assert.match(dialog()!.textContent ?? "", /changed elsewhere and has been reloaded/);
    await click(buttonByText("Import 1", dialog()!));
    const last = calls("importFromGlobal").at(-1)!.args[1] as { revision: string; onConflict: string };
    assert.equal(last.revision, "7");
    assert.equal(last.onConflict, "fail");
  });

  it("Git: scans, then takes the picks with the chosen scope", async () => {
    await openDeveloper();
    await click(buttonByText("Git"));
    await typeInto(dialog()!.querySelector<HTMLInputElement>('input[type="url"]')!, "https://github.com/acme/repo");
    await click(buttonByText("Scan", dialog()!));
    assert.deepEqual(calls("scanGit")[0]!.args, ["p1", { url: "https://github.com/acme/repo" }]);
    assert.match(dialog()!.textContent ?? "", /ship/);
    await click(buttonByText("Import 1", dialog()!));
    assert.deepEqual(calls("take")[0]!.args, ["p1", "imp1", { revision: "1", picks: ["commands/ship.md"], agents: "all", onConflict: "fail" }]);
  });

  it("Copy from profile: picks another profile's items", async () => {
    await openDeveloper();
    await click(buttonByText("Copy from profile"));
    await click(dialog()!.querySelector('[data-pick="x1"]'));
    await click(buttonByText("Copy 1", dialog()!));
    assert.deepEqual(calls("copy")[0]!.args, ["p1", { revision: "1", fromProfileId: "p2", itemIds: ["x1"], onConflict: "fail" }]);
  });

  it("Add plugin: a marketplace's plugin into the profile", async () => {
    await openDeveloper();
    await click(document.querySelector('[data-kind-cell="plugin"]'));
    await click(buttonByText("Add plugin"));
    await click(dialog()!.querySelector('[data-plugin="superpowers"]'));
    await click(buttonByText("Add to profile", dialog()!));
    assert.deepEqual(calls("addPlugin")[0]!.args, [
      "p1",
      { revision: "1", agent: "claude", source: { type: "marketplace", marketplace: "acme", plugin: "superpowers" }, onConflict: "fail" }
    ]);
  });

  it("⋯ → Export downloads the profile's zip", async () => {
    const downloads: string[] = [];
    const anchorClick = mock.method(dom.window.HTMLAnchorElement.prototype, "click", function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    const urls = mock.method(URL, "createObjectURL", () => "blob:x");
    const revoke = mock.method(URL, "revokeObjectURL", () => undefined);
    try {
      await openDeveloper();
      await click([...document.querySelectorAll("button")].find((button) => button.textContent?.includes("More actions for Developer")));
      await click([...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.trim() === "Export…"));
      assert.deepEqual(calls("export")[0]!.args.slice(0, 1), ["p1"]);
      assert.deepEqual(downloads, ["developer.agent-profile.zip"]);
      assert.match(notice(), /Exported Developer/);
    } finally {
      anchorClick.mock.restore();
      urls.mock.restore();
      revoke.mock.restore();
    }
  });

  it("the library's + New → Import profile from file uploads the zip and opens the new profile", async () => {
    await render();
    await click(document.querySelector("[data-profile-new]"));
    await click([...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.trim() === "Import profile from file"));
    const input = dialog()!.querySelector<HTMLInputElement>("[data-upload-input]")!;
    const file = new dom.window.File([new Uint8Array([80, 75, 3, 4])], "editor.agent-profile.zip", { type: "application/zip" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await flush();
    assert.equal(calls("importProfile")[0]!.args[0], "editor.agent-profile.zip");
    assert.equal(dialog(), null);
    assert.ok(document.querySelector("[data-profile-instructions]"), "the new profile is open");
    assert.match(notice(), /Imported Editor\. Secret values are never exported/);
  });
});
