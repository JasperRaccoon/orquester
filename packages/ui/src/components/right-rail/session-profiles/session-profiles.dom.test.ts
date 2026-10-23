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

function detail(revision: string, codex: "ready" | "preparing" | "failed" = "preparing", shown: SessionProfileItem[] = items): SessionProfileDetail {
  return {
    ...summary(revision, codex),
    settings: { hideBuiltinSkills: { claude: true, codex: true, grok: true, opencode: true }, claudeWorkflowTool: true },
    items: shown,
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
  creates: { body: unknown }[];
  /** Refuse the next item create / update with 409 PROFILE_CONFLICT, the profile moved to this revision. */
  writeConflictNext: string | null;
  /** What the profile's items read as (another client's change). */
  items: SessionProfileItem[];
  /** What the profile's settings read as (another client's change); null = the defaults of `detail`. */
  settings: SessionProfileDetail["settings"] | null;
  profileUpdates: unknown[];
}

/** A write carrying another revision than the server's is refused, as the daemon does. */
function writeCheck(server: Server, body: unknown): void {
  if (server.writeConflictNext !== null) {
    server.revision = server.writeConflictNext;
    server.writeConflictNext = null;
  }
  if ((body as { revision: string }).revision !== server.revision) {
    throw Object.assign(new Error("conflict"), { status: 409, body: { error: { code: "PROFILE_CONFLICT", message: "The profile changed." } } });
  }
  server.revision = String(Number(server.revision) + 1);
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
      const read = detail(server.revision, "preparing", server.items);
      return server.settings ? { ...read, settings: server.settings } : read;
    },
    updateSessionProfile: async (_profileId: string, body: unknown) => {
      server.profileUpdates.push(body);
      writeCheck(server, body);
      const read = detail(server.revision, "preparing", server.items);
      return server.settings ? { ...read, settings: server.settings } : read;
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
      writeCheck(server, body);
      return { profile: detail(server.revision, "preparing", server.items), itemId };
    },
    createSessionProfileItem: async (_profileId: string, body: unknown) => {
      server.creates.push({ body });
      writeCheck(server, body);
      return { profile: detail(server.revision, "preparing", server.items), itemId: "new" };
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
    server = { uses: [[]], deletes: [], usesChangedNext: false, revision: "1", toggles: [], updates: [], gets: 0, conflictNext: false, creates: [], writeConflictNext: null, items, settings: null, profileUpdates: [] };
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
    // boxes: with the Ephemeral AI VMs plugin off, no "Run in box" switch, and the draft leaves it as it is.
    assert.equal(dialog!.querySelector("[data-mcp-run-in-box]"), null);
    assert.equal("runInBox" in (body.draft.mcp as object), false);
  });

  // boxes: the MCP item's "Run in box" switch, while the Ephemeral AI VMs plugin is on.
  it("the MCP editor offers Run in box with the plugin on, and sends the switch with the item", async () => {
    useAppStore.setState({
      plugins: [
        {
          id: "ephemeral-vms",
          name: "Ephemeral AI VMs",
          description: "",
          source: { label: "Built in", url: "" },
          provider: "Orquester",
          scope: "global",
          updates: false,
          platform: "supported",
          enabled: true,
          enabledWorkspaces: [],
          current: null,
          previous: null,
          skippedVersion: null,
          lastCheckAt: null,
          lastError: null,
          job: "idle"
        }
      ]
    } as never);
    await openDeveloper();
    await openJiraEditor();
    const row = document.querySelector('[role="dialog"] [data-mcp-run-in-box]');
    assert.ok(row, "the switch is offered");
    assert.match(row!.textContent ?? "", /its secrets will be present in the VM while it runs/);
    const toggle = row!.querySelector<HTMLButtonElement>('[role="switch"]');
    assert.equal(toggle?.getAttribute("aria-checked"), "false");
    await click(toggle);
    assert.equal(toggle?.getAttribute("aria-checked"), "true");

    await click(buttonByText("Save"));
    assert.equal(server.updates.length, 1);
    const body = server.updates[0]!.body as { draft: { mcp: { runInBox?: boolean } } };
    assert.equal(body.draft.mcp.runInBox, true);
  });

  const type = async (selector: string, value: string) => {
    const input = document.querySelector<HTMLInputElement>(selector);
    assert.ok(input, `${selector} exists`);
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await flush();
  };

  const moveProfile = async (revision: string, shown: SessionProfileItem[] = items) => {
    server.revision = revision;
    server.items = shown;
    await act(async () => {
      applySessionProfileEvent({ type: "sessionProfile.changed", payload: { profileId: "p1", revision } });
    });
    await flush();
  };

  const openJiraEditor = async () => {
    await click([...document.querySelectorAll("button")].find((button) => button.textContent?.includes("More actions for jira")));
    await click([...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.trim() === "Edit"));
    assert.ok(document.querySelector('[role="dialog"]'), "the editor opened");
  };

  it("a new item carries the revision held when it is sent; after a 409 the draft stays and the next save carries the reloaded one", async () => {
    await openDeveloper();
    await click([...document.querySelectorAll("button")].find((button) => /Add MCP/.test(button.textContent ?? "")));
    await type('[role="dialog"] input[placeholder="jira-cloud"]', "linear");
    await type('[role="dialog"] input[placeholder="npx"]', "linear-mcp");
    // Another change lands while the editor is open.
    await moveProfile("2");
    await click(buttonByText("Add server"));
    assert.deepEqual(server.creates.map((create) => (create.body as { revision: string }).revision), ["2"]);
    assert.equal(document.querySelector('[role="dialog"]'), null, "saved and closed");

    // The store missed a change: refused, reloaded, the draft kept, and saving again lands.
    await click([...document.querySelectorAll("button")].find((button) => /Add MCP/.test(button.textContent ?? "")));
    await type('[role="dialog"] input[placeholder="jira-cloud"]', "sentry");
    await type('[role="dialog"] input[placeholder="npx"]', "sentry-mcp");
    server.writeConflictNext = "7";
    await click(buttonByText("Add server"));
    assert.ok(document.querySelector('[role="dialog"]'), "still open");
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? "", /save again/i);
    assert.equal(document.querySelector<HTMLInputElement>('[role="dialog"] input[placeholder="jira-cloud"]')?.value, "sentry");
    await click(buttonByText("Add server"));
    assert.deepEqual(server.creates.map((create) => (create.body as { revision: string }).revision), ["2", "3", "7"]);
    assert.equal(document.querySelector('[role="dialog"]'), null, "saved and closed");
  });

  it("an edit survives a change to another item, but not a change to the item it edits", async () => {
    await openDeveloper();
    await openJiraEditor();
    await moveProfile("2", items.map((item) => (item.id === "s1" ? { ...item, enabled: false } : item)));
    await click(buttonByText("Save"));
    assert.equal((server.updates.at(-1)?.body as { revision: string }).revision, "2", "another item moved the revision: the draft applies");

    await openJiraEditor();
    server.writeConflictNext = "8";
    await click(buttonByText("Save"));
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? "", /save again/i, "another item's change: the draft stays");
    await click(buttonByText("Save"));
    assert.equal((server.updates.at(-1)?.body as { revision: string }).revision, "8");

    await openJiraEditor();
    await moveProfile("12", items.map((item) => (item.id === "m1" ? { ...item, name: "jira-2" } : item)));
    await click(buttonByText("Save"));
    assert.equal((server.updates.at(-1)?.body as { revision: string }).revision, "9", "this item changed: sent at the revision it was read at");
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? "", /Changed on disk/);
    assert.ok(buttonByText("Reload (discard my changes)"));
  });

  it("profile settings send only what the dialog changed, never undoing a change made elsewhere while it was open", async () => {
    await openDeveloper();
    await click(document.querySelector('button[title="Profile settings"]'));
    assert.ok(document.querySelector('form[aria-label="Profile settings"]'), "the settings dialog opened");
    // Elsewhere, while it is open: Claude's Workflow tool off, Codex's skills shown, a collection ticked.
    server.settings = {
      hideBuiltinSkills: { claude: true, codex: false, grok: true, opencode: true },
      claudeWorkflowTool: false,
      knowledgeCollections: ["kc_seo"]
    };
    await moveProfile("2");
    await type('form[aria-label="Profile settings"] input[placeholder="Developer, Editor, Research…"]', "Developer 2");
    await click(buttonByText("Save"));
    assert.deepEqual(server.profileUpdates, [{ name: "Developer 2", revision: "2" }]);
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
