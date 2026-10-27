/** Public app-event routing and plugin lifecycle; share the app store's module startup. */

import assert from "node:assert/strict";
import { describe, it, afterEach, beforeEach } from "node:test";
import {
  AGENT_PROFILE_CHANNEL,
  BOXES_CHANGED_EVENT,
  BOXES_CHANNEL,
  DAEMON_EVENTS_CHANNEL,
  DAEMON_STOPPING_EVENT,
  DEVICES_PLUGIN_ID,
  KNOWLEDGE_CHANNEL,
  KNOWLEDGE_STATUS_EVENT,
  type AgentProfileAgentId,
  type AgentProfileSnapshot,
  type EventMessage,
  type PluginInfo,
  type ProjectSummary,
  type SecretVaultDetail,
  type SessionSummary
} from "@orquester/api";
import { serverViewOpen, useAppStore } from "../store/app.ts";
import { agentProfileStore, loadAgentProfile, resetAgentProfile, type AgentProfileApi } from "./agent-profile/store.ts";
import type { ApiClient } from "./api-client.ts";
import { boxesStore, resetBoxes } from "./boxes/store.ts";
import { box, change, kind, provider } from "./boxes/fixtures.test-helpers.ts";
import { knowledgeStore, resetKnowledge } from "./knowledge/store.ts";
import { collections, knowledgePlugin, status } from "./knowledge/fixtures.test-helpers.ts";
import { repoIdentitiesStore, resetRepoIdentities } from "./repo-identities/store.ts";
import { resetSavedPrompts, savedPromptsStore } from "./saved-prompts/store.ts";
import { getSecretVault, resetSecretFiles } from "./secret-files/store.ts";
import { getConnectionLog, resetConnectionLog } from "./connection/connection-log.ts";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const event = (channel: string, type: string, payload: unknown) => ({
  id: `${channel}:${type}`,
  channel,
  type,
  payload,
  createdAt: "2026-10-20T10:00:00.000Z"
});

const initialAppState = useAppStore.getState();
afterEach(async () => {
  // Restore tabs/project selection too: these suites formerly had separate processes.
  useAppStore.setState(initialAppState, true);
  await settle();
  resetAgentProfile();
  resetBoxes();
  resetKnowledge();
  resetRepoIdentities();
  resetSavedPrompts();
  resetSecretFiles();
  resetConnectionLog();
});

// agent-profile: only shared app routing is exercised here; the feature store owns its state rules.
{
  /** App-store channel routing; store.test.ts owns cache/reset behavior. */

  function snapshot(revision: string): AgentProfileSnapshot {
    return {
      agent: "claude",
      installed: true,
      revision,
      instructions: { path: "/h/.claude/CLAUDE.md", exists: false, bytes: 0, lines: 0, revision: "", warnings: [] },
      items: [],
      fileErrors: [],
      readAt: "2026-09-28T00:00:00.000Z"
    };
  }

  function fakeApi(): AgentProfileApi & { gets: AgentProfileAgentId[]; revision: string } {
    const api = {
      connection: { id: "local" },
      gets: [] as AgentProfileAgentId[],
      revision: "r1",
      async getAgentProfile(agent: AgentProfileAgentId) {
        api.gets.push(agent);
        return snapshot(api.revision);
      },
      getAgentProfileOverview: async () => ({ agents: [] }),
      setAgentProfileItemEnabled: async () => ({ snapshot: snapshot(api.revision), itemIds: [], notes: [] }),
      deleteAgentProfileItem: async () => ({ snapshot: snapshot(api.revision), itemIds: [], notes: [] }),
      copyAgentProfileItem: async () => ({ snapshot: snapshot(api.revision), itemIds: [], notes: [] }),
      trustAgentProfileItem: async () => ({ snapshot: snapshot(api.revision), itemIds: [], notes: [] })
    };
    return api;
  }

  describe("the app store routes agent-profile events", () => {
    it("agentProfile.changed on the agent-profile channel refetches the loaded agent", async () => {
      resetAgentProfile();
      const api = fakeApi();
      await loadAgentProfile(api, "claude");
      api.revision = "r2";
      useAppStore.getState().applyEvent(event(AGENT_PROFILE_CHANNEL, "agentProfile.changed", { agent: "claude", revision: "r2" }));
      await settle();
      assert.deepEqual(api.gets, ["claude", "claude"]);
      assert.equal(agentProfileStore.getState().agents.claude.snapshot?.revision, "r2");
    });

    it("the same message on another channel does not", async () => {
      resetAgentProfile();
      const api = fakeApi();
      await loadAgentProfile(api, "claude");
      useAppStore.getState().applyEvent(event("elsewhere", "agentProfile.changed", { agent: "claude", revision: "r2" }));
      await settle();
      assert.deepEqual(api.gets, ["claude"]);
    });

  });
}

// boxes: only shared app routing is exercised here; the feature store owns its state rules.
{
  const TOTALS = { activeCount: 1, hourlyUsd: 0.0119, monthEstimatedUsd: 1 };

  const plugin = (enabled: boolean): PluginInfo => ({
    id: "ephemeral-vms",
    name: "Ephemeral AI VMs",
    description: "",
    source: { label: "Built in", url: "" },
    provider: "Orquester",
    scope: "global",
    updates: false,
    platform: "supported",
    enabled,
    enabledWorkspaces: [],
    current: null,
    previous: null,
    skippedVersion: null,
    lastCheckAt: null,
    lastError: null,
    job: "idle"
  });

  function fakeApi() {
    const calls: string[] = [];
    const api = {
      connection: { id: "c1" },
      listBoxes: async () => (calls.push("boxes"), { boxes: [box()], totals: TOTALS }),
      listBoxProviders: async () => (calls.push("providers"), { providers: [provider()] }),
      listBoxKinds: async () => (calls.push("kinds"), { kinds: [kind()] }),
      listBoxConfigChanges: async () => (calls.push("changes"), { changes: [change()] })
    };
    return { api: api as unknown as ApiClient, calls };
  }

  describe("the app store wires the boxes store to the plugin", () => {
    let saved: { api: ApiClient | null; plugins: PluginInfo[] | null };

    beforeEach(() => {
      const state = useAppStore.getState();
      saved = { api: state.api, plugins: state.plugins };
      useAppStore.setState({ plugins: null });
      resetBoxes();
    });

    afterEach(() => {
      useAppStore.setState(saved);
      resetBoxes();
    });

    it("ignores boxes events until the plugins list is known", () => {
      useAppStore.getState().applyEvent(event(BOXES_CHANNEL, BOXES_CHANGED_EVENT, { boxes: [box()], totals: TOTALS }));
      assert.equal(boxesStore.getState().boxes, null);
    });

    it("with the plugin off, holds the boxes events report still running, and only those", () => {
      useAppStore.setState({ plugins: [plugin(false)] });
      useAppStore.getState().applyEvent(event(BOXES_CHANNEL, BOXES_CHANGED_EVENT, { boxes: [box({ state: "destroyed" })], totals: TOTALS }));
      assert.equal(boxesStore.getState().boxes, null);
      useAppStore.getState().applyEvent(event(BOXES_CHANNEL, BOXES_CHANGED_EVENT, { boxes: [box()], totals: TOTALS }));
      assert.deepEqual(boxesStore.getState().boxes?.map((entry) => entry.id), ["b1"]);
    });

    it("loads when the plugin turns on, routes events, and keeps only the running boxes when it turns off", async () => {
      const fake = fakeApi();
      useAppStore.setState({ api: fake.api, plugins: [plugin(true)] });
      await settle();
      assert.deepEqual([...fake.calls].sort(), ["boxes", "changes", "kinds", "providers"]);
      assert.deepEqual(boxesStore.getState().boxes?.map((entry) => entry.id), ["b1"]);

      useAppStore.getState().applyEvent(event(BOXES_CHANNEL, BOXES_CHANGED_EVENT, { boxes: [box({ id: "b2" })], totals: TOTALS }));
      assert.deepEqual(boxesStore.getState().boxes?.map((entry) => entry.id), ["b2"]);
      // Another channel's event of the same type is not this store's.
      useAppStore.getState().applyEvent(event("elsewhere", BOXES_CHANGED_EVENT, { boxes: [], totals: TOTALS }));
      assert.deepEqual(boxesStore.getState().boxes?.map((entry) => entry.id), ["b2"]);

      // Another plugin list with it still on: no reload.
      const before = fake.calls.length;
      useAppStore.setState({ plugins: [plugin(true)] });
      await settle();
      assert.equal(fake.calls.length, before);

      // Off: b2 still runs (and bills) — it stays; nothing else does.
      useAppStore.setState({ plugins: [plugin(false)] });
      assert.deepEqual(boxesStore.getState().boxes?.map((entry) => entry.id), ["b2"]);
      assert.equal(boxesStore.getState().providers, null);
      assert.equal(boxesStore.getState().kinds, null);
      // Destroyed: nothing is left running, so nothing is held.
      useAppStore.getState().applyEvent(event(BOXES_CHANNEL, BOXES_CHANGED_EVENT, { boxes: [box({ id: "b2", state: "destroyed" })], totals: TOTALS }));
      assert.equal(boxesStore.getState().boxes, null);
    });

    it("turning off with nothing running forgets everything", async () => {
      const fake = fakeApi();
      (fake.api as { listBoxes: unknown }).listBoxes = async () => ({ boxes: [box({ state: "destroyed" })], totals: TOTALS });
      useAppStore.setState({ api: fake.api, plugins: [plugin(true)] });
      await settle();
      assert.equal(boxesStore.getState().boxes?.length, 1);
      useAppStore.setState({ plugins: [plugin(false)] });
      assert.equal(boxesStore.getState().boxes, null);
      assert.equal(boxesStore.getState().providers, null);
    });

    it("a connection switch's empty plugin list forgets the boxes", async () => {
      const fake = fakeApi();
      useAppStore.setState({ api: fake.api, plugins: [plugin(true)] });
      await settle();
      assert.ok(boxesStore.getState().boxes);
      useAppStore.setState({ plugins: null });
      assert.equal(boxesStore.getState().boxes, null);
    });
  });
}

// knowledge: only shared app routing is exercised here; the feature store owns its state rules.
{
  /**
   * The app store and the Knowledge Graph plugin: the knowledge store loads when
   * the plugin turns on, takes `knowledge` events only while it is on, and
   * forgets everything when it turns off; the server-level Knowledge view opens
   * over the main area with or without a project, carries the item it was asked
   * to show, and leaves when the user goes to a project, a tab or a tool.
   */

  function fakeApi() {
    const calls: string[] = [];
    const api = {
      connection: { id: "c1" },
      getKnowledgeStatus: async () => (calls.push("status"), status()),
      listKnowledgeCollections: async () => (calls.push("collections"), collections())
    };
    return { api: api as unknown as ApiClient, calls };
  }

  describe("the app store wires the knowledge store to the plugin", () => {
    let saved: { api: ApiClient | null; plugins: PluginInfo[] | null };

    beforeEach(() => {
      const state = useAppStore.getState();
      saved = { api: state.api, plugins: state.plugins };
      useAppStore.setState({ plugins: null });
      resetKnowledge();
    });

    afterEach(() => {
      useAppStore.setState(saved);
      resetKnowledge();
    });

    it("ignores knowledge events while the plugin is off", () => {
      useAppStore.setState({ plugins: [knowledgePlugin(false)] });
      useAppStore.getState().applyEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_STATUS_EVENT, status()));
      assert.equal(knowledgeStore.getState().status, null);
    });

    it("loads when the plugin turns on, routes its events, and forgets everything when it turns off", async () => {
      const fake = fakeApi();
      useAppStore.setState({ api: fake.api, plugins: [knowledgePlugin(true)] });
      await settle();
      assert.deepEqual([...fake.calls].sort(), ["collections", "status"]);
      assert.equal(knowledgeStore.getState().status?.entries, 2);

      useAppStore.getState().applyEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_STATUS_EVENT, status({ entries: 8 })));
      assert.equal(knowledgeStore.getState().status?.entries, 8);
      // Another channel's event of the same type is not this store's.
      useAppStore.getState().applyEvent(event("elsewhere", KNOWLEDGE_STATUS_EVENT, status({ entries: 1 })));
      assert.equal(knowledgeStore.getState().status?.entries, 8);

      // Another plugin list with it still on: no reload.
      const before = fake.calls.length;
      useAppStore.setState({ plugins: [knowledgePlugin(true)] });
      await settle();
      assert.equal(fake.calls.length, before);

      useAppStore.setState({ plugins: [knowledgePlugin(false)] });
      assert.equal(knowledgeStore.getState().status, null);
      assert.equal(knowledgeStore.getState().collections, null);
    });
  });

  describe("the Knowledge view", () => {
    const P = "/w/acme/app";
    const project = (path: string) => ({ name: path.split("/").pop(), workspace: "acme", path }) as ProjectSummary;
    const store = () => useAppStore.getState();

    beforeEach(() => {
      useAppStore.setState({
        api: null,
        currentProject: project(P),
        knowledgeView: { open: false, focus: null },
        whiteboardTabsByProject: {},
        gitTabsByProject: {},
        activeTabByProject: {},
        sessions: [],
        browsers: [],
        desktops: []
      });
    });

    it("opens over the main area without touching the project's tabs, and closes", () => {
      useAppStore.setState({ sidebarDrawerOpen: true });
      store().openKnowledge();
      assert.deepEqual(store().knowledgeView, { open: true, focus: null });
      assert.equal(store().sidebarDrawerOpen, false, "opened from the phone's drawer, the drawer closes");
      assert.deepEqual(store().activeTabByProject, {}, "no project tab is made or activated");

      store().closeKnowledge();
      assert.equal(store().knowledgeView.open, false);
    });

    it("opens with no project open", () => {
      useAppStore.setState({ currentProject: null, currentWorkspace: null });
      store().openKnowledgeEntry("ke_aaaaaaaaaaaa");
      assert.equal(store().knowledgeView.open, true);
      assert.equal(store().knowledgeView.focus?.id, "ke_aaaaaaaaaaaa");
    });

    it("openKnowledgeEntry selects the entry, with a new nonce each time; a plain open keeps it", () => {
      store().openKnowledgeEntry("ke_aaaaaaaaaaaa");
      const first = store().knowledgeView.focus;
      assert.equal(first?.kind, "entry");
      assert.equal(first?.id, "ke_aaaaaaaaaaaa");
      store().openKnowledgeEntry("ke_aaaaaaaaaaaa");
      const second = store().knowledgeView.focus;
      assert.ok(second && first && second.nonce > first.nonce, "the same citation clicked again asks again");

      store().openKnowledgeConcept("tactic-alternatives");
      assert.equal(store().knowledgeView.focus?.kind, "concept");
      const concept = store().knowledgeView.focus;
      // Closing and opening again keeps what the view was showing (same request, same nonce).
      store().closeKnowledge();
      store().openKnowledge();
      assert.equal(store().knowledgeView.focus, concept);
    });

    it("going to the project, a tab or a tool leaves it, keeping its focus", () => {
      const leaves: Array<[string, () => void]> = [
        ["openProject (the same project)", () => store().openProject(project(P))],
        ["activateTab", () => store().activateTab("tab-1")],
        ["openGit", () => store().openGit()],
        ["openFileBrowser", () => store().openFileBrowser()],
        ["openWhiteboard", () => store().openWhiteboard(`${P}/whiteboards/Plan.excalidraw`)],
        ["openWorkflowTab", () => store().openWorkflowTab(P, "wf_1", { title: "Flow" })]
      ];
      for (const [name, leave] of leaves) {
        store().openKnowledgeEntry("ke_aaaaaaaaaaaa");
        const focus = store().knowledgeView.focus;
        leave();
        assert.equal(store().knowledgeView.open, false, name);
        assert.equal(store().knowledgeView.focus, focus, `${name} keeps the focus`);
      }
    });

    it("a chat turn ending under it stays unread until closing it reveals the chat", () => {
      const done = "2026-10-26T10:00:00.000Z";
      const chat = { id: "c1", kind: "agent-chat", projectPath: P, latestTurn: { completedAt: done } } as unknown as SessionSummary;
      useAppStore.setState({ activeTabByProject: { [P]: "c1" }, threadVisits: {} });
      store().openKnowledge();
      store().applyEvent({ channel: "sessions", type: "session.updated", payload: chat } as EventMessage);
      assert.equal(store().sessions[0]?.id, "c1");
      assert.equal(store().threadVisits.c1, undefined, "hidden under the view, the finished turn is not seen");
      store().closeKnowledge();
      assert.equal(store().threadVisits.c1, done, "closing the view shows the chat: that is the visit");
    });

    it("a workflow opened in another project leaves it showing", () => {
      store().openKnowledge();
      store().openWorkflowTab("/w/acme/site", "wf_1", { title: "Flow" });
      assert.equal(store().knowledgeView.open, true);
    });

    it("closes when a loaded plugins list says the plugin is off, not while the list is unknown", () => {
      useAppStore.setState({ plugins: [knowledgePlugin(true)] });
      store().openKnowledgeEntry("ke_aaaaaaaaaaaa");
      useAppStore.setState({ plugins: null });
      assert.equal(store().knowledgeView.open, true, "a list not loaded yet says nothing");
      useAppStore.setState({ plugins: [knowledgePlugin(false)] });
      assert.deepEqual(store().knowledgeView, { open: false, focus: null });
    });

    it("closes and forgets its focus on a connection switch", async () => {
      store().openKnowledgeEntry("ke_aaaaaaaaaaaa");
      // The connection switched to gets an inert injected transport (no socket opens).
      const target = { id: "target", name: "Target", kind: "local", endpoint: "unix:/x", status: "disconnected" } as const;
      useAppStore.setState({ connect: async () => undefined, connectionStatus: "disconnected" });
      await store().initConnections({ localConnection: target, localTransporter: { kind: "stub" } as never, defaultUseTitlebar: false });
      useAppStore.setState({
        activeConnectionId: "previous",
        connections: [target, { ...target, id: "previous" }],
        knowledgeView: { open: true, focus: { kind: "entry", id: "ke_aaaaaaaaaaaa", nonce: 1 } }
      });
      await store().selectConnection("target");
      assert.deepEqual(store().knowledgeView, { open: false, focus: null });
    });
  });

  describe("the Devices fleet view", () => {
    const P = "/w/acme/app";
    const project = (path: string) => ({ name: path.split("/").pop(), workspace: "acme", path }) as ProjectSummary;
    const store = () => useAppStore.getState();
    const devicesPlugin = (enabled: boolean): PluginInfo => ({ ...knowledgePlugin(enabled), id: DEVICES_PLUGIN_ID, name: "Device simulators" });

    beforeEach(() => {
      useAppStore.setState({
        api: null,
        currentProject: project(P),
        knowledgeView: { open: false, focus: null },
        devicesFleetOpen: false,
        whiteboardTabsByProject: {},
        gitTabsByProject: {},
        activeTabByProject: {},
        sessions: [],
        browsers: [],
        desktops: []
      });
    });

    it("opens over the main area in Knowledge's place, and the other way round", () => {
      useAppStore.setState({ sidebarDrawerOpen: true });
      store().openKnowledgeEntry("ke_aaaaaaaaaaaa");
      const focus = store().knowledgeView.focus;
      store().openDevicesFleet();
      assert.equal(store().devicesFleetOpen, true);
      assert.equal(store().knowledgeView.open, false, "one server-level view at a time");
      assert.equal(store().knowledgeView.focus, focus, "Knowledge keeps what it showed");
      assert.equal(store().sidebarDrawerOpen, false);
      assert.equal(serverViewOpen(store()), true);
      store().openKnowledge();
      assert.equal(store().devicesFleetOpen, false);
      assert.equal(store().knowledgeView.open, true);
      store().closeKnowledge();
      assert.equal(serverViewOpen(store()), false);
    });

    it("going to the project, a tab, a tool or a session leaves it", () => {
      const leaves: Array<[string, () => void]> = [
        ["openProject (the same project)", () => store().openProject(project(P))],
        ["activateTab", () => store().activateTab("tab-1")],
        ["openGit", () => store().openGit()],
        ["openFileBrowser", () => store().openFileBrowser()],
        ["openWorkflowTab", () => store().openWorkflowTab(P, "wf_1", { title: "Flow" })]
      ];
      for (const [name, leave] of leaves) {
        store().openDevicesFleet();
        leave();
        assert.equal(store().devicesFleetOpen, false, name);
      }
    });

    it("a chat turn ending under it stays unread until closing it reveals the chat", () => {
      const done = "2026-10-26T10:00:00.000Z";
      const chat = { id: "c1", kind: "agent-chat", projectPath: P, latestTurn: { completedAt: done } } as unknown as SessionSummary;
      useAppStore.setState({ activeTabByProject: { [P]: "c1" }, threadVisits: {} });
      store().openDevicesFleet();
      store().applyEvent({ channel: "sessions", type: "session.updated", payload: chat } as EventMessage);
      assert.equal(store().threadVisits.c1, undefined, "hidden under the view, the finished turn is not seen");
      store().closeDevicesFleet();
      assert.equal(store().devicesFleetOpen, false);
      assert.equal(store().threadVisits.c1, done, "closing the view shows the chat: that is the visit");
    });

    it("closes when a loaded plugins list says the plugin is off, not while the list is unknown", () => {
      useAppStore.setState({ plugins: [devicesPlugin(true)] });
      store().openDevicesFleet();
      useAppStore.setState({ plugins: null });
      assert.equal(store().devicesFleetOpen, true, "a list not loaded yet says nothing");
      useAppStore.setState({ plugins: [devicesPlugin(false)] });
      assert.equal(store().devicesFleetOpen, false);
    });

    it("closes on a connection switch", async () => {
      const target = { id: "target", name: "Target", kind: "local", endpoint: "unix:/x", status: "disconnected" } as const;
      useAppStore.setState({ connect: async () => undefined, connectionStatus: "disconnected" });
      await store().initConnections({ localConnection: target, localTransporter: { kind: "stub" } as never, defaultUseTitlebar: false });
      useAppStore.setState({ activeConnectionId: "previous", connections: [target, { ...target, id: "previous" }], devicesFleetOpen: true });
      await store().selectConnection("target");
      assert.equal(store().devicesFleetOpen, false);
    });
  });
}

// repo-identities: only shared app routing is exercised here; the feature store owns its state rules.
{
  const KEY = "github.com/jasperraccoon/jasperengine";
  const record = { repoKey: KEY, label: "Engine", updatedAt: "2026-10-18T10:00:00.000Z" };

  describe("the app store routes repo identity events", () => {
    it("a change and a delete on the repo-identities channel reach the store", () => {
      resetRepoIdentities();
      useAppStore.getState().applyEvent(event("repo-identities", "repoIdentity.changed", { identity: record }));
      assert.equal(repoIdentitiesStore.getState().identities.get(KEY)?.label, "Engine");
      useAppStore.getState().applyEvent(event("repo-identities", "repoIdentity.changed", { repoKey: KEY, deleted: true }));
      assert.equal(repoIdentitiesStore.getState().identities.get(KEY), undefined);
    });

    it("the same message on another channel does not", () => {
      resetRepoIdentities();
      useAppStore.getState().applyEvent(event("elsewhere", "repoIdentity.changed", { identity: record }));
      assert.equal(repoIdentitiesStore.getState().identities.get(KEY), undefined);
    });
  });
}

// saved-prompts: only shared app routing is exercised here; the feature store owns its state rules.
{
  const record = {
    id: "wired",
    title: "Wired",
    description: "",
    body: "Body",
    tags: [],
    projectPath: null,
    pinned: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    lastUsedAt: null,
    useCount: 0
  };

  describe("the app store routes saved-prompt events", () => {
    it("an upsert and a delete on the saved-prompts channel reach the store", () => {
      resetSavedPrompts();
      useAppStore.getState().applyEvent(event("saved-prompts", "savedPrompt.upserted", record));
      assert.equal(savedPromptsStore.getState().prompts.get("wired")?.title, "Wired");
      useAppStore
        .getState()
        .applyEvent(event("saved-prompts", "savedPrompt.deleted", { id: "wired", projectPath: null }));
      assert.equal(savedPromptsStore.getState().prompts.has("wired"), false);
    });

    it("the same message on another channel does not", () => {
      resetSavedPrompts();
      useAppStore.getState().applyEvent(event("elsewhere", "savedPrompt.upserted", record));
      assert.equal(savedPromptsStore.getState().prompts.size, 0);
    });
  });
}

// secret-files: only shared app routing is exercised here; the feature store owns its state rules.
{
  const WS = "jaspersito";
  const KEY = "github.com/jasperraccoon/matssmile";

  const vault: SecretVaultDetail = {
    workspace: WS,
    repoKey: KEY,
    fileCount: 0,
    clonesNeedingAttention: 0,
    newCandidates: 0,
    updatedAt: "2026-10-19T10:00:00.000Z",
    files: [],
    excluded: [],
    candidates: [],
    clones: []
  };

  const plugin = (enabled: boolean): PluginInfo => ({
    id: "secret-files",
    name: "Secret files",
    description: "",
    source: { label: "Built in", url: "" },
    provider: "Orquester",
    scope: "global",
    updates: false,
    platform: "supported",
    enabled,
    enabledWorkspaces: [],
    current: null,
    previous: null,
    skippedVersion: null,
    lastCheckAt: null,
    lastError: null,
    job: "idle"
  });

  function fakeApi() {
    const calls: string[] = [];
    const api = {
      connection: { id: "c1" },
      listSecretVaults: async () => {
        calls.push("list");
        return { vaults: [{ workspace: WS, repoKey: KEY }] };
      },
      getSecretVault: async () => {
        calls.push("get");
        return { vault };
      }
    };
    return { api: api as unknown as ApiClient, calls };
  }

  describe("the app store wires the secret-files store to the plugin", () => {
    let saved: { api: ApiClient | null; plugins: PluginInfo[] | null };

    beforeEach(() => {
      const state = useAppStore.getState();
      saved = { api: state.api, plugins: state.plugins };
      useAppStore.setState({ plugins: null });
      resetSecretFiles();
    });

    afterEach(() => {
      useAppStore.setState(saved);
      resetSecretFiles();
    });

    it("ignores secret-files events while the plugin is off", () => {
      useAppStore.getState().applyEvent(event("secret-files", "secretFiles.changed", { vault }));
      assert.equal(getSecretVault(WS, KEY), undefined);
    });

    it("loads the vaults when the plugin turns on, routes events, and forgets them when it turns off", async () => {
      const fake = fakeApi();
      useAppStore.setState({ api: fake.api, plugins: [plugin(true)] });
      await settle();
      assert.deepEqual(fake.calls, ["list", "get"]);
      assert.ok(getSecretVault(WS, KEY));

      useAppStore.getState().applyEvent(event("secret-files", "secretFiles.changed", { workspace: WS, repoKey: KEY, deleted: true }));
      assert.equal(getSecretVault(WS, KEY), undefined);
      useAppStore.getState().applyEvent(event("secret-files", "secretFiles.changed", { vault: { ...vault, updatedAt: "2026-10-19T11:00:00.000Z" } }));
      assert.ok(getSecretVault(WS, KEY));
      useAppStore.getState().applyEvent(event("elsewhere", "secretFiles.changed", { workspace: WS, repoKey: KEY, deleted: true }));
      assert.ok(getSecretVault(WS, KEY));

      // Another plugin list with it still on: no reload.
      useAppStore.setState({ plugins: [plugin(true)] });
      await settle();
      assert.equal(fake.calls.length, 2);

      useAppStore.setState({ plugins: [plugin(false)] });
      assert.equal(getSecretVault(WS, KEY), undefined);
    });

    it("a connection switch's empty plugin list forgets the vaults", async () => {
      const fake = fakeApi();
      useAppStore.setState({ api: fake.api, plugins: [plugin(true)] });
      await settle();
      assert.ok(getSecretVault(WS, KEY));
      useAppStore.setState({ plugins: null });
      assert.equal(getSecretVault(WS, KEY), undefined);
    });
  });
}

describe("the app store routes daemon announcements", () => {
  beforeEach(() => resetConnectionLog());
  it("the store notes a daemon's stop announcement from the event stream", () => {
    useAppStore.getState().applyEvent({
      id: "daemon:1",
      channel: DAEMON_EVENTS_CHANNEL,
      type: DAEMON_STOPPING_EVENT,
      createdAt: "2026-10-22T10:00:00.000Z",
      payload: { reason: "shutdown" }
    });
    assert.ok(getConnectionLog().stoppingAt !== null);
  });
});
