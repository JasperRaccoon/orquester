import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type {
  AgentProfileAgentId,
  AgentProfileOverviewResponse,
  AgentProfileSnapshot,
  CopyProfileItemRequest,
  ProfileItem,
  ProfileMutationResponse,
  SetProfileItemEnabledRequest,
  TrustProfileItemRequest
} from "@orquester/api";

import {
  agentProfileItemKey,
  agentProfileStore,
  applyAgentProfileEvent,
  applyAgentProfileSnapshot,
  copyAgentProfileItem,
  dismissAgentProfileNotice,
  lastAgentProfileAgent,
  lastAgentProfileTab,
  loadAgentProfile,
  loadAgentProfileOverview,
  markAgentProfileStale,
  parseAgentProfilePrefs,
  rememberAgentProfileAgent,
  rememberAgentProfileTab,
  removeAgentProfileItem,
  resetAgentProfile,
  sanitizeAgentProfileSnapshot,
  serializeAgentProfilePrefs,
  setAgentProfileItemEnabled,
  trustAgentProfileItem,
  type AgentProfileApi
} from "./store.ts";
import { sanitizeOverview, sanitizeProfileItem } from "./sanitize";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function item(overrides: Partial<ProfileItem> & { id: string }): ProfileItem {
  return {
    kind: "mcp",
    name: overrides.id.replace(/^\w+:/, ""),
    enabled: true,
    toggleable: true,
    editable: true,
    deletable: true,
    locked: false,
    source: { type: "user", label: "User" },
    revision: `rev-${overrides.id}`,
    warnings: [],
    ...overrides
  };
}

function snapshot(agent: AgentProfileAgentId, revision: string, items: ProfileItem[] = []): AgentProfileSnapshot {
  return {
    agent,
    installed: true,
    version: "1.0.0",
    revision,
    instructions: { path: `/home/.${agent}/AGENTS.md`, exists: true, bytes: 10, lines: 2, revision: "i1", warnings: [] },
    items,
    fileErrors: [],
    readAt: "2026-09-28T10:00:00.000Z"
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every queued microtask and promise continuation run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** An `ApiError` as the client throws it: a status and the daemon's `{error: {code, message}}` body. */
class FakeApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown
  ) {
    super(`failed with status ${status}`);
  }
}

const refusal = (status: number, code: string, message: string) => new FakeApiError(status, { error: { code, message } });

/** A fake daemon: `server` holds each agent's snapshot; each route can be held or failed per test. */
class FakeApi implements AgentProfileApi {
  connection = { id: "local" };
  server = new Map<AgentProfileAgentId, unknown>();
  overview: unknown = {
    agents: [
      { agent: "claude", installed: true, version: "2.1", counts: { mcp: 1 } },
      { agent: "codex", installed: true, counts: {} },
      { agent: "grok", installed: false, counts: {} },
      { agent: "opencode", installed: true, counts: {} }
    ]
  };
  gets: AgentProfileAgentId[] = [];
  overviewGets = 0;
  held: Deferred<void> | null = null;
  failGet: unknown = null;
  failMutation: unknown = null;
  mutations: { route: string; agent: AgentProfileAgentId; id: string; body: unknown }[] = [];
  /** What a mutation answers; defaults to the agent's server snapshot. */
  answer: ((agent: AgentProfileAgentId) => unknown) | null = null;

  async getAgentProfile(agent: AgentProfileAgentId): Promise<AgentProfileSnapshot> {
    this.gets.push(agent);
    if (this.held !== null) await this.held.promise;
    if (this.failGet !== null) throw this.failGet;
    return this.server.get(agent) as AgentProfileSnapshot;
  }

  async getAgentProfileOverview(): Promise<AgentProfileOverviewResponse> {
    this.overviewGets += 1;
    return this.overview as AgentProfileOverviewResponse;
  }

  private async mutation(
    route: string,
    agent: AgentProfileAgentId,
    id: string,
    body: unknown,
    answers: AgentProfileAgentId = agent
  ): Promise<ProfileMutationResponse> {
    this.mutations.push({ route, agent, id, body });
    if (this.failMutation !== null) throw this.failMutation;
    const snap = this.answer ? this.answer(answers) : this.server.get(answers);
    return { snapshot: snap as AgentProfileSnapshot, itemIds: [id], notes: [] };
  }

  setAgentProfileItemEnabled(agent: AgentProfileAgentId, id: string, req: SetProfileItemEnabledRequest) {
    return this.mutation("enabled", agent, id, req);
  }
  deleteAgentProfileItem(agent: AgentProfileAgentId, id: string, revision: string) {
    return this.mutation("delete", agent, id, { revision });
  }
  copyAgentProfileItem(agent: AgentProfileAgentId, id: string, req: CopyProfileItemRequest) {
    return this.mutation("copy", agent, id, req, req.toAgent);
  }
  trustAgentProfileItem(agent: AgentProfileAgentId, id: string, req: TrustProfileItemRequest) {
    return this.mutation("trust", agent, id, req);
  }
}

const JIRA = item({ id: "mcp:jira", description: "Jira tools" });

let api: FakeApi;

beforeEach(() => {
  resetAgentProfile();
  api = new FakeApi();
  api.server.set("claude", snapshot("claude", "r1", [JIRA]));
  api.server.set("codex", snapshot("codex", "c1"));
});

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

describe("wire snapshots are sanitized field by field", () => {
  it("keeps a well-formed snapshot as it is", () => {
    const clean = snapshot("claude", "r1", [JIRA]);
    assert.deepEqual(sanitizeAgentProfileSnapshot(clean), clean);
  });

  it("refuses a snapshot that names no known agent", () => {
    for (const bad of [null, 7, "claude", [], {}, { agent: "gemini" }, { agent: 3 }]) {
      assert.equal(sanitizeAgentProfileSnapshot(bad), null, JSON.stringify(bad));
    }
  });

  it("drops malformed items rather than failing the snapshot, and keeps the first of a duplicate id", () => {
    const raw = {
      ...snapshot("claude", "r1"),
      items: [
        JIRA,
        null,
        "mcp:x",
        { id: "", kind: "mcp" },
        { id: "agent:x", kind: "agent" },
        { ...JIRA, name: "second jira" },
        item({ id: "skill:review", kind: "skill" })
      ]
    };
    const clean = sanitizeAgentProfileSnapshot(raw);
    assert.deepEqual(
      clean?.items.map((entry) => [entry.id, entry.name]),
      [
        ["mcp:jira", "jira"],
        ["skill:review", "review"]
      ]
    );
  });

  it("fails permissions closed and locks everything on a locked item", () => {
    const loose = sanitizeProfileItem({ id: "hook:a", kind: "hook", toggleable: "yes", editable: 1 });
    assert.equal(loose?.toggleable, false);
    assert.equal(loose?.editable, false);
    assert.equal(loose?.deletable, false);
    assert.equal(loose?.name, "hook:a", "a missing name reads as the id");
    assert.equal(loose?.enabled, true, "on unless it says off");
    const locked = sanitizeProfileItem({ ...JIRA, locked: true });
    assert.deepEqual([locked?.toggleable, locked?.editable, locked?.deletable], [false, false, false]);
  });

  it("repairs the source, the warnings and the meta", () => {
    const repaired = sanitizeProfileItem({
      ...JIRA,
      source: { type: "martian", label: 5, ownerAgent: "gemini", pluginId: "" },
      warnings: ["Plugin cache missing", { message: "Not trusted", action: "trust", code: "untrusted" }, { code: "x" }, 4, { message: "odd", action: "launch" }],
      meta: { transport: "stdio", bad: 3 }
    });
    assert.equal(repaired?.source.type, "user");
    assert.equal(repaired?.source.ownerAgent, undefined);
    assert.equal(repaired?.source.pluginId, undefined);
    assert.deepEqual(repaired?.warnings, [
      { code: "warning", message: "Plugin cache missing" },
      { code: "untrusted", message: "Not trusted", action: "trust" },
      { code: "warning", message: "odd" }
    ]);
    assert.deepEqual(repaired?.meta, { transport: "stdio" });
    const inherited = sanitizeProfileItem({ ...JIRA, source: { type: "inherited", label: "From Claude", ownerAgent: "claude" } });
    assert.deepEqual(inherited?.source, { type: "inherited", label: "From Claude", ownerAgent: "claude" });
  });

  it("repairs the instructions and the file errors, and tolerates a missing list", () => {
    const clean = sanitizeAgentProfileSnapshot({
      agent: "codex",
      instructions: { path: "/h/.codex/AGENTS.md", exists: true, lines: -3, bytes: "9", mtime: "yesterday", warning: "Shadowed by AGENTS.override.md" },
      fileErrors: [{ path: "/h/.codex/config.toml", message: "bad TOML" }, { message: "no path" }, null],
      items: "nope"
    });
    assert.ok(clean);
    assert.deepEqual(clean.items, []);
    assert.equal(clean.installed, true);
    assert.equal(clean.revision, "");
    assert.deepEqual(clean.instructions, {
      path: "/h/.codex/AGENTS.md",
      exists: true,
      bytes: 0,
      lines: 0,
      revision: "",
      warnings: [{ code: "warning", message: "Shadowed by AGENTS.override.md" }]
    });
    assert.deepEqual(clean.fileErrors, [{ path: "/h/.codex/config.toml", message: "bad TOML" }]);
  });

  it("sanitizes the overview: known agents once, counts of known kinds only", () => {
    assert.equal(sanitizeOverview({ agents: "x" }), null);
    assert.deepEqual(
      sanitizeOverview({
        agents: [
          { agent: "claude", installed: true, counts: { mcp: 2, agent: 4, skill: -1 } },
          { agent: "claude", installed: false, counts: {} },
          { agent: "gemini", installed: true },
          { agent: "grok", installed: "yes" }
        ]
      }),
      [
        { agent: "claude", installed: true, counts: { mcp: 2, skill: 0 } },
        { agent: "grok", installed: false, counts: {} }
      ]
    );
  });
});

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

describe("loads", () => {
  it("loads a snapshot, and a second unforced load asks nothing", async () => {
    await loadAgentProfile(api, "claude");
    const entry = agentProfileStore.getState().agents.claude;
    assert.equal(entry.status, "ready");
    assert.equal(entry.snapshot?.revision, "r1");
    await loadAgentProfile(api, "claude");
    assert.deepEqual(api.gets, ["claude"]);
  });

  it("is single-flight: concurrent callers share one request", async () => {
    api.held = deferred<void>();
    const first = loadAgentProfile(api, "claude");
    const second = loadAgentProfile(api, "claude");
    await settle();
    assert.equal(agentProfileStore.getState().agents.claude.status, "loading");
    api.held.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(api.gets, ["claude"]);
  });

  it("a forced load during one in flight asks once more after it — shared by every forced caller", async () => {
    api.held = deferred<void>();
    const first = loadAgentProfile(api, "claude");
    const forcedA = loadAgentProfile(api, "claude", { force: true });
    const forcedB = loadAgentProfile(api, "claude", { force: true });
    api.held.resolve();
    api.held = null;
    await Promise.all([first, forcedA, forcedB]);
    assert.deepEqual(api.gets, ["claude", "claude"]);
  });

  it("a first load that fails is an error; a refresh that fails keeps the snapshot beside the error", async () => {
    api.failGet = refusal(500, "AGENT_PROFILE_ERROR", "disk on fire");
    await loadAgentProfile(api, "claude");
    assert.deepEqual(
      [agentProfileStore.getState().agents.claude.status, agentProfileStore.getState().agents.claude.error],
      ["error", "disk on fire"]
    );
    api.failGet = null;
    await loadAgentProfile(api, "claude", { force: true });
    assert.equal(agentProfileStore.getState().agents.claude.status, "ready");
    api.failGet = refusal(500, "AGENT_PROFILE_ERROR", "again");
    await loadAgentProfile(api, "claude", { force: true });
    const entry = agentProfileStore.getState().agents.claude;
    assert.equal(entry.status, "ready");
    assert.equal(entry.snapshot?.revision, "r1", "the snapshot stays on screen");
    assert.equal(entry.error, "again");
  });

  it("keeps the daemon's refusal code for a not-installed agent", async () => {
    api.failGet = refusal(404, "AGENT_NOT_INSTALLED", "Grok is not installed");
    await loadAgentProfile(api, "grok");
    assert.equal(agentProfileStore.getState().agents.grok.errorCode, "AGENT_NOT_INSTALLED");
  });

  it("an answer for another agent or in a bad shape is an error, not state", async () => {
    api.server.set("codex", snapshot("claude", "r9"));
    await loadAgentProfile(api, "codex");
    assert.equal(agentProfileStore.getState().agents.codex.status, "error");
    assert.equal(agentProfileStore.getState().agents.claude.snapshot, null, "never lands on the agent it names");
  });

  it("loads the overview, sanitized", async () => {
    await loadAgentProfileOverview(api);
    const overview = agentProfileStore.getState().overview;
    assert.equal(overview.status, "ready");
    assert.deepEqual(
      overview.agents?.map((summary) => [summary.agent, summary.installed]),
      [
        ["claude", true],
        ["codex", true],
        ["grok", false],
        ["opencode", true]
      ]
    );
    await loadAgentProfileOverview(api);
    assert.equal(api.overviewGets, 1);
  });

  it("marks everything loaded stale on a reconnect, and a load crossing it asks again", async () => {
    await loadAgentProfile(api, "claude");
    await loadAgentProfileOverview(api);
    markAgentProfileStale();
    assert.equal(agentProfileStore.getState().agents.claude.stale, true);
    assert.equal(agentProfileStore.getState().overview.stale, true);
    await loadAgentProfile(api, "claude");
    assert.equal(agentProfileStore.getState().agents.claude.stale, false);

    api.held = deferred<void>();
    const crossing = loadAgentProfile(api, "claude", { force: true });
    await settle();
    markAgentProfileStale();
    api.held.resolve();
    api.held = null;
    await crossing;
    await settle();
    await settle();
    assert.equal(api.gets.length, 4, "the answer may predate the reconnect: asked once more");
    assert.equal(agentProfileStore.getState().agents.claude.stale, false);
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe("agentProfile.changed", () => {
  const changed = (agent: string, revision: unknown) => ({ type: "agentProfile.changed", payload: { agent, revision } });

  it("refetches a loaded agent whose revision moved", async () => {
    await loadAgentProfile(api, "claude");
    api.server.set("claude", snapshot("claude", "r2", [JIRA]));
    applyAgentProfileEvent(changed("claude", "r2"));
    await settle();
    await settle();
    assert.deepEqual(api.gets, ["claude", "claude"]);
    assert.equal(agentProfileStore.getState().agents.claude.snapshot?.revision, "r2");
  });

  it("does nothing for the revision already held", async () => {
    await loadAgentProfile(api, "claude");
    applyAgentProfileEvent(changed("claude", "r1"));
    await settle();
    assert.deepEqual(api.gets, ["claude"]);
    assert.equal(agentProfileStore.getState().agents.claude.stale, false);
  });

  it("does not fetch an agent that was never loaded", async () => {
    await loadAgentProfile(api, "claude");
    applyAgentProfileEvent(changed("codex", "c2"));
    await settle();
    assert.deepEqual(api.gets, ["claude"]);
    assert.equal(agentProfileStore.getState().agents.codex.status, "idle");
  });

  it("refreshes a loaded overview too", async () => {
    await loadAgentProfile(api, "claude");
    await loadAgentProfileOverview(api);
    applyAgentProfileEvent(changed("claude", "r2"));
    await settle();
    await settle();
    assert.equal(api.overviewGets, 2);
  });

  it("a change during an agent's FIRST load asks once more after it (that answer may predate the change)", async () => {
    api.held = deferred<void>();
    const first = loadAgentProfile(api, "claude");
    await settle();
    applyAgentProfileEvent(changed("claude", "r2"));
    api.server.set("claude", snapshot("claude", "r2", [JIRA]));
    api.held.resolve();
    api.held = null;
    await first;
    await settle();
    await settle();
    assert.deepEqual(api.gets, ["claude", "claude"]);
    assert.equal(agentProfileStore.getState().agents.claude.snapshot?.revision, "r2");
  });

  it("ignores a malformed payload or another type without a throw", async () => {
    await loadAgentProfile(api, "claude");
    assert.doesNotThrow(() => {
      applyAgentProfileEvent({ type: "agentProfile.changed", payload: null });
      applyAgentProfileEvent({ type: "agentProfile.changed", payload: { agent: "gemini", revision: "x" } });
      applyAgentProfileEvent({ type: "agentProfile.changed", payload: { agent: "claude", revision: 4 } });
      applyAgentProfileEvent({ type: "agentProfile.deleted", payload: { agent: "claude", revision: "x" } });
    });
    await settle();
    assert.deepEqual(api.gets, ["claude"]);
  });
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

describe("mutations", () => {
  it("replaces the snapshot with the answer's and says so, the change carrying the item's revision", async () => {
    await loadAgentProfile(api, "claude");
    api.server.set("claude", snapshot("claude", "r2", [{ ...JIRA, enabled: false, revision: "rev-2" }]));
    const pending = setAgentProfileItemEnabled(api, "claude", JIRA, false);
    assert.equal(agentProfileStore.getState().pending.has(agentProfileItemKey("claude", "mcp:jira")), true);
    const result = await pending;
    assert.equal(result.ok, true);
    assert.deepEqual(api.mutations[0], {
      route: "enabled",
      agent: "claude",
      id: "mcp:jira",
      body: { revision: "rev-mcp:jira", enabled: false }
    });
    assert.equal(agentProfileStore.getState().agents.claude.snapshot?.items[0]?.enabled, false);
    assert.equal(agentProfileStore.getState().pending.size, 0);
    assert.equal(agentProfileStore.getState().notice?.tone, "ok");
  });

  it("the daemon's notes become the notice", async () => {
    api.answer = (agent) => api.server.get(agent);
    const original = api.setAgentProfileItemEnabled.bind(api);
    api.setAgentProfileItemEnabled = async (agent, id, req) => ({
      ...(await original(agent, id, req)),
      notes: ["OpenCode servers restart when idle."]
    });
    await setAgentProfileItemEnabled(api, "claude", JIRA, true);
    assert.ok(agentProfileStore.getState().notice?.text.includes("OpenCode servers restart when idle."));
  });

  it("a 409 PROFILE_CONFLICT refetches the agent and says it changed on disk", async () => {
    await loadAgentProfile(api, "claude");
    api.failMutation = refusal(409, "PROFILE_CONFLICT", "Stale revision");
    const result = await removeAgentProfileItem(api, "claude", JIRA);
    await settle();
    await settle();
    assert.deepEqual(result, { ok: false, error: "Stale revision", code: "PROFILE_CONFLICT", status: 409 });
    assert.equal(agentProfileStore.getState().notice?.tone, "error");
    assert.deepEqual(api.gets, ["claude", "claude"]);
  });

  it("another refusal becomes the notice in the daemon's words", async () => {
    api.failMutation = refusal(403, "ITEM_LOCKED", "Orquester's own hook is locked");
    await trustAgentProfileItem(api, "claude", JIRA);
    assert.equal(agentProfileStore.getState().notice?.tone, "error");
    assert.ok(agentProfileStore.getState().notice?.text.includes("Orquester's own hook is locked"));
    dismissAgentProfileNotice();
    assert.equal(agentProfileStore.getState().notice, null);
  });

  it("AGENT_NOT_INSTALLED refetches the agent and the overview (the picker learns it)", async () => {
    await loadAgentProfile(api, "claude");
    await loadAgentProfileOverview(api);
    api.failMutation = refusal(404, "AGENT_NOT_INSTALLED", "Claude is not installed on this host.");
    await setAgentProfileItemEnabled(api, "claude", JIRA, false);
    await settle();
    await settle();
    assert.deepEqual(api.gets, ["claude", "claude"]);
    assert.equal(api.overviewGets, 2);
    assert.equal(agentProfileStore.getState().notice?.tone, "error");
  });

  it("a copy lands the TARGET's snapshot on the target", async () => {
    await loadAgentProfile(api, "claude");
    await loadAgentProfile(api, "codex");
    api.server.set("codex", snapshot("codex", "c2", [item({ id: "mcp:jira" })]));
    const result = await copyAgentProfileItem(api, "claude", JIRA, "codex");
    assert.equal(result.ok, true);
    assert.deepEqual(api.mutations[0]?.body, { toAgent: "codex" });
    assert.equal(agentProfileStore.getState().agents.codex.snapshot?.revision, "c2");
    assert.equal(agentProfileStore.getState().agents.claude.snapshot?.revision, "r1", "the source is untouched");
    assert.equal(agentProfileStore.getState().notice?.tone, "ok");
  });

  it("a copy whose name is taken answers ITEM_EXISTS quietly; the retry carries onConflict", async () => {
    api.failMutation = refusal(409, "ITEM_EXISTS", "Codex already has jira");
    const first = await copyAgentProfileItem(api, "claude", JIRA, "codex");
    assert.equal(first.ok, false);
    assert.equal(!first.ok && first.code, "ITEM_EXISTS");
    assert.equal(agentProfileStore.getState().notice, null, "the caller asks Replace / Keep both / Cancel");
    api.failMutation = null;
    const retry = await copyAgentProfileItem(api, "claude", JIRA, "codex", "keep-both");
    assert.equal(retry.ok, true);
    assert.deepEqual(api.mutations[1]?.body, { toAgent: "codex", onConflict: "keep-both" });
  });

  it("an answer whose snapshot does not parse refetches instead", async () => {
    await loadAgentProfile(api, "claude");
    api.answer = () => ({ nonsense: true });
    const result = await setAgentProfileItemEnabled(api, "claude", JIRA, false);
    await settle();
    await settle();
    assert.equal(result.ok, true);
    assert.deepEqual(api.gets, ["claude", "claude"]);
  });

  it("a load that started before a mutation answered does not overwrite the mutation's snapshot", async () => {
    await loadAgentProfile(api, "claude");
    api.held = deferred<void>();
    const load = loadAgentProfile(api, "claude", { force: true });
    await settle();
    applyAgentProfileSnapshot(snapshot("claude", "r5"));
    api.held.resolve();
    api.held = null;
    await load;
    assert.equal(agentProfileStore.getState().agents.claude.snapshot?.revision, "r5");
  });
});

// ---------------------------------------------------------------------------
// Reset and connections
// ---------------------------------------------------------------------------

describe("reset", () => {
  it("forgets everything, and an answer in flight across it is dropped", async () => {
    await loadAgentProfile(api, "codex");
    api.held = deferred<void>();
    const load = loadAgentProfile(api, "claude");
    await settle();
    resetAgentProfile();
    api.held.resolve();
    await load;
    assert.equal(agentProfileStore.getState().agents.claude.snapshot, null);
    assert.equal(agentProfileStore.getState().agents.claude.status, "idle");
    assert.equal(agentProfileStore.getState().agents.codex.snapshot, null);
    assert.equal(agentProfileStore.getState().notice, null);
  });

  it("a client of another connection resets first", async () => {
    await loadAgentProfile(api, "claude");
    const other = new FakeApi();
    other.connection = { id: "remote" };
    other.server.set("codex", snapshot("codex", "x1"));
    await loadAgentProfile(other, "codex");
    assert.equal(agentProfileStore.getState().agents.claude.snapshot, null, "the other daemon's profile is gone");
    assert.equal(agentProfileStore.getState().agents.codex.snapshot?.revision, "x1");
  });

  it("after a reset an event refetches nothing (no client bound)", async () => {
    await loadAgentProfile(api, "claude");
    resetAgentProfile();
    applyAgentProfileEvent({ type: "agentProfile.changed", payload: { agent: "claude", revision: "r9" } });
    await settle();
    assert.deepEqual(api.gets, ["claude"]);
  });
});

// ---------------------------------------------------------------------------
// The last picked agent and each agent's tab (localStorage)
// ---------------------------------------------------------------------------

class MemoryStorage {
  constructor(public value: string | null = null) {}
  getItem(key: string): string | null {
    return key === "orquester:agent-profile" ? this.value : null;
  }
  setItem(key: string, value: string): void {
    if (key === "orquester:agent-profile") {
      this.value = value;
    }
  }
}

describe("the last picked agent and each agent's tab", () => {
  const NONE = { agent: null, tabs: {} };

  it("parses field by field, and anything unusable is no pick", () => {
    for (const raw of [null, undefined, "", "{", "null", "[]", "42", '"claude"', '{"agent":"gemini"}', '{"agent":4}']) {
      assert.deepEqual(parseAgentProfilePrefs(raw), NONE, String(raw));
    }
    assert.deepEqual(parseAgentProfilePrefs('{"v":7,"agent":"grok","future":true}'), { agent: "grok", tabs: {} });
  });

  it("keeps a tab only for a known agent that has that kind", () => {
    assert.deepEqual(
      parseAgentProfilePrefs(
        JSON.stringify({
          agent: "claude",
          tabs: { claude: "skill", codex: "command", opencode: "hook", grok: 7, gemini: "mcp" }
        })
      ),
      { agent: "claude", tabs: { claude: "skill", codex: "command" } },
      "OpenCode has no hooks; a number is no kind; gemini is no agent"
    );
    for (const tabs of ["skill", ["skill"], null, 3]) {
      assert.deepEqual(parseAgentProfilePrefs(JSON.stringify({ agent: "codex", tabs })), { agent: "codex", tabs: {} });
    }
    assert.deepEqual(parseAgentProfilePrefs('{"tabs":{"grok":"marketplace"}}'), { agent: null, tabs: { grok: "marketplace" } });
  });

  it("serializes over what another bundle stored, keeping its fields and tabs", () => {
    assert.deepEqual(JSON.parse(serializeAgentProfilePrefs({ agent: "codex", tabs: {} })), { v: 1, agent: "codex", tabs: {} });
    assert.deepEqual(
      JSON.parse(serializeAgentProfilePrefs(
        { agent: "codex", tabs: { codex: "hook" } },
        '{"v":2,"agent":"grok","kinds":["mcp"],"tabs":{"gemini":"mcp","codex":"skill"}}'
      )),
      { v: 1, agent: "codex", kinds: ["mcp"], tabs: { gemini: "mcp", codex: "hook" } }
    );
    assert.deepEqual(JSON.parse(serializeAgentProfilePrefs({ agent: "codex", tabs: {} }, "garbage")), {
      v: 1, agent: "codex", tabs: {}
    });
    assert.deepEqual(JSON.parse(serializeAgentProfilePrefs({ agent: null, tabs: {} }, '{"tabs":"junk"}')), {
      v: 1, agent: null, tabs: {}
    });
  });

  it("reads stored selections, remembers each agent's tab, and keeps preferences across a reset", () => {
    const storage = new MemoryStorage('{"v":1,"agent":"opencode","tabs":{"claude":"plugin","opencode":"hook"}}');
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    try {
      assert.equal(lastAgentProfileAgent(), "opencode");
      assert.equal(lastAgentProfileTab("claude"), "plugin");
      assert.equal(lastAgentProfileTab("opencode"), null);
      assert.equal(lastAgentProfileTab("codex"), null);
      rememberAgentProfileAgent("codex");
      rememberAgentProfileTab("codex", "hook");
      rememberAgentProfileTab("claude", "command");
      rememberAgentProfileTab("opencode", "marketplace");
      assert.equal(lastAgentProfileTab("opencode"), null, "unsupported kinds stay unselected");
      assert.deepEqual(JSON.parse(storage.value ?? ""), {
        v: 1, agent: "codex", tabs: { claude: "command", opencode: "hook", codex: "hook" }
      }, "another bundle's unsupported tab value is preserved on disk");
      resetAgentProfile();
      assert.equal(lastAgentProfileAgent(), "codex");
      assert.equal(lastAgentProfileTab("claude"), "command");
      assert.equal(lastAgentProfileTab("codex"), "hook");
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("a storage that throws leaves the pick and the tabs in memory", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() { throw new Error("denied"); }
    });
    try {
      assert.doesNotThrow(() => rememberAgentProfileAgent("grok"));
      assert.doesNotThrow(() => rememberAgentProfileTab("grok", "hook"));
      assert.equal(lastAgentProfileAgent(), "grok");
      assert.equal(lastAgentProfileTab("grok"), "hook");
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});
