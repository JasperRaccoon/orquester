/**
 * The right rail's Agent Profiles panel in a DOM (agent profiles spec §5.1,
 * §5.2): the library with Global first, drilling into a profile, the kind
 * bar, a toggle carrying the revision, a stale revision reloading with a
 * notice, the readiness line following `/events`, and the MCP editor keeping
 * secret values masked (set / keep).
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { SessionProfileDetail, SessionProfileItem, SessionProfileSummary } from "@orquester/api";

import { OrquesterProvider } from "../../../context/orquester-context";
import type { ApiClient } from "../../../lib/api-client";
import { applySessionProfileEvent, resetSessionProfiles } from "../../../lib/session-profiles/store";
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
const preparation = (codex: "ready" | "preparing" | "failed" = "ready") =>
  (["claude", "codex", "grok", "opencode"] as const).map((agent) => ({
    agent,
    state: agent === "codex" ? codex : ("ready" as const),
    updatedAt: "t"
  }));

const items: SessionProfileItem[] = [
  {
    id: "m1",
    kind: "mcp",
    name: "jira",
    enabled: true,
    agents: "all",
    mcp: { name: "jira", transport: "stdio", command: "npx", args: ["jira-mcp"], env: [{ key: "JIRA_TOKEN", set: true }] }
  },
  { id: "s1", kind: "skill", name: "review-pr", enabled: true, agents: ["claude"], description: "Review a PR" },
  { id: "s2", kind: "skill", name: "cut-video", enabled: false, agents: ["claude", "codex"] }
];

function summary(revision: string, codex: "ready" | "preparing" | "failed" = "preparing"): SessionProfileSummary {
  return {
    id: "p1",
    name: "Developer",
    icon: "💻",
    description: "Coding work",
    revision,
    createdAt: "t",
    updatedAt: "t",
    counts: { mcp: { total: 1, enabled: 1 }, skill: { total: 2, enabled: 1 }, plugin: zero, hook: zero, command: zero },
    hasInstructions: true,
    preparation: preparation(codex)
  };
}

function detail(revision: string, codex: "ready" | "preparing" | "failed" = "preparing"): SessionProfileDetail {
  return {
    ...summary(revision, codex),
    settings: { hideBuiltinSkills: { claude: true, codex: true, grok: true, opencode: true }, claudeWorkflowTool: true },
    items,
    itemErrors: []
  };
}

interface Server {
  /** The workflows the delete guard lists, per answer (the last one repeats). */
  uses: { workflowId: string; name: string; workspace?: string }[][];
  deletes: { revision: string; options: unknown }[];
  /** Refuse the next delete with 409 WORKFLOW_USES_CHANGED. */
  usesChangedNext: boolean;
  revision: string;
  toggles: { itemId: string; revision: string; enabled: boolean }[];
  updates: { itemId: string; body: unknown }[];
  gets: number;
  conflictNext: boolean;
}

function fakeApi(server: Server): ApiClient {
  return {
    connection: { id: "c1" },
    listSessionProfiles: async () => ({
      profiles: [summary(server.revision), { ...summary("1"), id: "p2", name: "Editor", icon: undefined, description: "Video editing", preparation: preparation("ready") }],
      errors: []
    }),
    getSessionProfile: async () => {
      server.gets += 1;
      return detail(server.revision);
    },
    setSessionProfileItemEnabled: async (_profileId: string, itemId: string, revision: string, enabled: boolean) => {
      if (server.conflictNext) {
        server.conflictNext = false;
        server.revision = "9";
        throw Object.assign(new Error("conflict"), {
          status: 409,
          body: { error: { code: "PROFILE_CONFLICT", message: "stale" } }
        });
      }
      server.toggles.push({ itemId, revision, enabled });
      server.revision = String(Number(server.revision) + 1);
      return { profile: detail(server.revision), itemId };
    },
    getSessionProfileItem: async (_profileId: string, itemId: string) => {
      const item = items.find((candidate) => candidate.id === itemId)!;
      return item.kind === "mcp" ? { kind: "mcp", item, mcp: item.mcp } : { kind: item.kind, item, document: { frontmatter: {}, body: "x" } };
    },
    getProfileWorkflowReferences: async (profileId: string) => {
      const workflows = (server.uses.length > 1 ? server.uses.shift() : server.uses[0]) ?? [];
      return { version: 1, profileId, workflows: workflows.map((use) => ({ ...use, enabled: true, revision: 1, project: { kind: "existing", projectPath: "/w/a/b" }, nodes: [] })) };
    },
    deleteSessionProfile: async (profileId: string, revision: string, options?: unknown) => {
      server.deletes.push({ revision, options });
      if (server.usesChangedNext) {
        server.usesChangedNext = false;
        throw Object.assign(new Error("changed"), {
          status: 409,
          body: { error: { code: "WORKFLOW_USES_CHANGED", message: 'The workflows that use this profile changed (now: "Nightly", "Weekly"); nothing was deleted.' } }
        });
      }
      return { profileId, deleted: true };
    },
    updateSessionProfileItem: async (_profileId: string, itemId: string, body: unknown) => {
      server.updates.push({ itemId, body });
      return { profile: detail(server.revision), itemId };
    }
  } as unknown as ApiClient;
}

describe("Agent Profiles panel", () => {
  let root: Root;
  let server: Server;
  const initial = { ...useAppStore.getState() };

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    resetSessionProfiles();
    server = { uses: [[]], deletes: [], usesChangedNext: false, revision: "1", toggles: [], updates: [], gets: 0, conflictNext: false };
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
    for (let i = 0; i < 6; i += 1) await act(async () => undefined);
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

  const buttonByText = (text: string) =>
    [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === text);

  /** Into Developer, on its MCP tab (the shown kind per profile outlives a remount). */
  const openDeveloper = async () => {
    await render();
    await click(document.querySelector('[data-profile-card="p1"]'));
    await click(document.querySelector('[data-kind-cell="mcp"]'));
  };

  it("lists Global first, then each profile with its counts and status pill", async () => {
    await render();
    const cards = [...document.querySelectorAll("[data-profile-card]")].map((card) => card.getAttribute("data-profile-card"));
    assert.deepEqual(cards, ["global", "p1", "p2"]);
    const developer = document.querySelector('[data-profile-card="p1"]')!;
    assert.match(developer.textContent ?? "", /2 skills/);
    assert.match(developer.textContent ?? "", /1 MCP(?!s)/);
    assert.match(developer.textContent ?? "", /0 plugins/);
    assert.equal(developer.querySelector("[data-profile-status]")?.textContent, "Preparing Codex…");
    assert.equal(document.querySelector('[data-profile-card="p2"] [data-profile-status]'), null);
    assert.ok(buttonByText("Settings → Agent config"), "Global links to Agent config");

    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(search, "video");
      search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    const shown = [...document.querySelectorAll("[data-profile-card]")].map((card) => card.getAttribute("data-profile-card"));
    assert.deepEqual(shown, ["p2"]);
    // The search outlives a remount (module memory): leave it empty for the next test.
    await act(async () => {
      setter.call(search, "");
      search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  });

  it("drills into a profile, switches kinds on the bar, and goes back", async () => {
    await openDeveloper();
    assert.equal(document.querySelector("[data-profile-card]"), null, "the library is not beside the editor");
    assert.ok(document.querySelector("[data-profile-instructions]"));
    const mcpCell = document.querySelector('[data-kind-cell="mcp"]')!;
    assert.equal(mcpCell.getAttribute("aria-selected"), "true");
    assert.match(mcpCell.textContent ?? "", /1/);
    assert.ok(document.querySelector('[data-session-profile-item="m1"]'));
    assert.equal(document.querySelector('[data-session-profile-item="s1"]'), null);

    await click(document.querySelector('[data-kind-cell="skill"]'));
    assert.equal(document.querySelector('[data-kind-cell="skill"]')?.getAttribute("aria-selected"), "true");
    assert.ok(document.querySelector('[data-session-profile-item="s1"]'));
    assert.equal(document.querySelector("[data-enabled-line]")?.textContent, "1 of 2 on");
    const tags = [...document.querySelectorAll("[data-scope-tag]")].map((tag) => tag.textContent);
    assert.deepEqual(tags, ["Claude only", "Claude, Codex"]);
    assert.ok(buttonByText("Add skill"));

    await click(document.querySelector('button[title="Back to all profiles"]'));
    assert.ok(document.querySelector('[data-profile-card="p1"]'));
  });

  it("a toggle sends the profile's revision; a stale one reloads and says so", async () => {
    await openDeveloper();
    const toggle = () => document.querySelector('[data-session-profile-item="m1"] [role="switch"]');
    await click(toggle());
    assert.deepEqual(server.toggles, [{ itemId: "m1", revision: "1", enabled: false }]);

    server.conflictNext = true;
    const before = server.gets;
    await click(toggle());
    assert.ok(server.gets > before, "the profile was read again");
    const notice = document.querySelector('[data-session-profiles-notice="error"]');
    assert.match(notice?.textContent ?? "", /changed elsewhere/);
    await click(toggle());
    assert.equal(server.toggles.at(-1)?.revision, "9", "the next change carries the reloaded revision");
  });

  it("the readiness line follows prepare-status events, the reason on hover", async () => {
    await openDeveloper();
    const codex = () => document.querySelector('[data-readiness="codex"]')!;
    assert.equal(codex().getAttribute("data-state"), "preparing");
    await act(async () => {
      applySessionProfileEvent({
        type: "sessionProfile.prepareStatus",
        payload: {
          profileId: "p1",
          revision: "1",
          agents: [{ agent: "codex", state: "failed", reason: "codex app-server did not start", updatedAt: "t" }]
        }
      });
    });
    assert.equal(codex().getAttribute("data-state"), "failed");
    assert.match(codex().getAttribute("title") ?? "", /did not start/);
  });

  it("the MCP editor shows a secret only as set, and keeps it unless replaced", async () => {
    await openDeveloper();
    const menu = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("More actions for jira")
    );
    await click(menu);
    await click([...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.trim() === "Edit"));
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog, "the editor opened");
    const row = dialog!.querySelector('[data-secret-row="existing"]');
    assert.ok(row, "the env entry is listed");
    assert.match(row!.textContent ?? "", /JIRA_TOKEN/);
    assert.match(row!.textContent ?? "", /set/);
    assert.equal(row!.querySelector("input"), null, "no value is shown or prefilled");

    await click(buttonByText("Save"));
    assert.equal(server.updates.length, 1);
    const body = server.updates[0]!.body as { revision: string; draft: { kind: string; agents: unknown; mcp: { env?: unknown } } };
    assert.equal(body.revision, "1");
    assert.equal(body.draft.kind, "mcp");
    assert.equal(body.draft.agents, "all");
    assert.deepEqual(body.draft.mcp.env, [{ key: "JIRA_TOKEN", keep: true }]);
  });

  const openDeleteDialog = async () => {
    await openDeveloper();
    await click([...document.querySelectorAll("button")].find((button) => button.textContent?.includes("More actions for Developer")));
    await click([...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.trim() === "Delete…"));
  };

  it("delete guard (§5.5): the confirmation lists the workflows using the profile, and their ids ride the delete", async () => {
    server.uses = [[{ workflowId: "wf_1", name: "Nightly", workspace: "acme" }]];
    await openDeleteDialog();
    const line = document.querySelector("[data-profile-delete-workflows]");
    assert.equal(line?.getAttribute("data-profile-delete-workflows"), "used");
    assert.match(line?.textContent ?? "", /1 workflow launches agents with it; its runs fail/);
    assert.match(document.querySelector('[data-profile-delete-workflow="wf_1"]')?.textContent ?? "", /Nightly · acme/);
    await click(buttonByText("Delete anyway"));
    assert.deepEqual(server.deletes, [{ revision: "1", options: { expectWorkflowUses: ["wf_1"] } }]);
    assert.equal(document.querySelector("[data-profile-delete-workflows]"), null, "the dialog closed");
  });

  it("delete guard: no workflow says so and sends an empty expectation; a change meanwhile reopens the confirmation with the new list", async () => {
    server.uses = [[], [{ workflowId: "wf_1", name: "Nightly" }, { workflowId: "wf_2", name: "Weekly" }]];
    server.usesChangedNext = true;
    await openDeleteDialog();
    assert.equal(document.querySelector("[data-profile-delete-workflows]")?.getAttribute("data-profile-delete-workflows"), "none");
    await click(buttonByText("Delete"));
    assert.deepEqual(server.deletes[0], { revision: "1", options: { expectWorkflowUses: [] } });
    assert.equal(document.querySelector("[data-profile-delete-workflows]")?.getAttribute("data-profile-delete-workflows"), "used", "reopened with the uses read again");
    assert.ok(document.querySelector('[data-profile-delete-workflow="wf_2"]'));
    assert.match(document.querySelector('[data-session-profiles-notice="error"]')?.textContent ?? "", /now: "Nightly", "Weekly"/);
    await click(buttonByText("Delete anyway"));
    assert.deepEqual(server.deletes[1], { revision: "1", options: { expectWorkflowUses: ["wf_1", "wf_2"] } });
  });
});
