/**
 * The agent-tools client store (unified MCP §7, §9): cards converge on the daemon through loads
 * and bus events, a closed card never comes back, every payload is parsed before it reaches state
 * (an older daemon's toolset fields ignored), and `agentTools.changed` re-reads what is shown.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { AgentToolsResponse, ThreadAgentToolsResponse } from "@orquester/api";

import {
  agentToolsStore,
  applyAgentToolsEvent,
  applyToolApprovalEvent,
  fetchToolApprovalDetail,
  loadAgentToolsSettings,
  loadThreadAgentTools,
  loadToolApprovals,
  markToolApprovalClosed,
  parseAgentToolGrant,
  parseAgentToolsResponse,
  parseThreadAgentToolsResponse,
  resetAgentTools,
  resetToolApprovals,
  revokeAgentToolGrant,
  toolApprovalsFor,
  toolApprovalsStore,
  watchAgentToolsSettings,
  watchThreadAgentTools,
  type AgentToolsApi,
  type ToolApprovalsApi
} from "./store";

function summary(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    approvalId: id,
    threadId: "s1",
    tool: "create_workflow",
    kind: "admin",
    family: "workflows",
    title: `Card ${id}`,
    scope: { label: "Project acme/web" },
    sections: [{ kind: "text", text: "hello" }],
    fullPreview: false,
    secretFields: [],
    grantOptions: ["chat"],
    requestedAt: "2026-10-15T10:00:00.000Z",
    expiresAt: "2026-10-15T10:30:00.000Z",
    ...extra
  };
}

const ids = (sessionId = "s1"): string[] => toolApprovalsFor(toolApprovalsStore.getState(), sessionId).map((card) => card.approvalId);

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body?: unknown
  ) {
    super(`HTTP ${status}`);
  }
}

describe("approval cards", () => {
  beforeEach(() => resetToolApprovals());

  it("opens and closes on the bus, oldest first; ignores malformed and foreign cards", () => {
    applyToolApprovalEvent({ type: "agentChat.toolApproval", payload: { threadId: "s1", opened: summary("b", { requestedAt: "2026-10-15T10:05:00.000Z" }) } });
    applyToolApprovalEvent({ type: "agentChat.toolApproval", payload: { threadId: "s1", opened: summary("a") } });
    assert.deepEqual(ids(), ["a", "b"]);
    applyToolApprovalEvent({ type: "agentChat.toolApproval", payload: { threadId: "s1", opened: { approvalId: "x" } } });
    applyToolApprovalEvent({ type: "agentChat.toolApproval", payload: { threadId: "other", opened: summary("c") } });
    applyToolApprovalEvent({ type: "agentChat.secretRequest", payload: { threadId: "s1", opened: summary("d") } });
    assert.deepEqual(ids(), ["a", "b"]);
    assert.deepEqual(ids("other"), []);
    applyToolApprovalEvent({ type: "agentChat.toolApproval", payload: { threadId: "s1", closed: { approvalId: "a", outcome: "approved" } } });
    assert.deepEqual(ids(), ["b"]);
    // A closed card is never revived by a late `opened`.
    applyToolApprovalEvent({ type: "agentChat.toolApproval", payload: { threadId: "s1", opened: summary("a") } });
    assert.deepEqual(ids(), ["b"]);
  });

  it("sanitises what reaches state", () => {
    applyToolApprovalEvent({ type: "agentChat.toolApproval", payload: { threadId: "s1", opened: summary("a", { title: "x‮y\nz" }) } });
    assert.equal(toolApprovalsFor(toolApprovalsStore.getState(), "s1")[0]!.title, "xy z");
  });

  it("a load keeps a card opened meanwhile and never revives one closed meanwhile", async () => {
    applyToolApprovalEvent({ type: "agentChat.toolApproval", payload: { threadId: "s1", opened: summary("old") } });
    let release!: () => void;
    const api: ToolApprovalsApi = {
      listToolApprovals: () =>
        new Promise((resolve) => {
          release = () => resolve({ approvals: [summary("old"), summary("listed")] as never });
        }),
      getToolApproval: async () => ({ approval: summary("x") as never }),
      answerToolApproval: async () => ({ ok: true, outcome: "approved" })
    };
    const load = loadToolApprovals(api, "s1");
    applyToolApprovalEvent({ type: "agentChat.toolApproval", payload: { threadId: "s1", opened: summary("fresh", { requestedAt: "2026-10-15T10:09:00.000Z" }) } });
    markToolApprovalClosed("s1", "old");
    release();
    await load;
    assert.deepEqual(ids(), ["listed", "fresh"]);
  });

  it("a reset drops a load answered for the previous connection", async () => {
    let release!: () => void;
    const api: ToolApprovalsApi = {
      listToolApprovals: () => new Promise((resolve) => (release = () => resolve({ approvals: [summary("a")] as never }))),
      getToolApproval: async () => ({ approval: summary("a") as never }),
      answerToolApproval: async () => ({ ok: true, outcome: "approved" })
    };
    const load = loadToolApprovals(api, "s1");
    resetToolApprovals();
    release();
    await load;
    assert.deepEqual(ids(), []);
  });

  it("the full preview is checked to be this card's; a gone card closes", async () => {
    applyToolApprovalEvent({ type: "agentChat.toolApproval", payload: { threadId: "s1", opened: summary("a") } });
    const api = (answer: () => Promise<unknown>): ToolApprovalsApi => ({
      listToolApprovals: async () => ({ approvals: [] }),
      getToolApproval: answer as ToolApprovalsApi["getToolApproval"],
      answerToolApproval: async () => ({ ok: true, outcome: "approved" })
    });
    assert.equal((await fetchToolApprovalDetail(api(async () => ({ approval: summary("a") })), "s1", "a"))?.approvalId, "a");
    assert.equal(await fetchToolApprovalDetail(api(async () => ({ approval: summary("zzz") })), "s1", "a"), null);
    await assert.rejects(fetchToolApprovalDetail(api(async () => Promise.reject(new HttpError(404))), "s1", "a"));
    assert.deepEqual(ids(), []);
  });
});

describe("parsers", () => {
  it("reads the settings' grants field-wise; an older daemon's toolset fields are ignored", () => {
    const grants = [{ id: "g1", family: "workflows", scope: "chat", projectPath: "/p", threadId: "t", workflowIds: ["w", 3], createdAt: "c" }, { id: 5 }];
    const parsed = parseAgentToolsResponse({ grants });
    assert.deepEqual(parsed?.grants.map((grant) => grant.workflowIds), [["w"]]);
    // What an older daemon sent (revision, master switch, toolsets matrix) still reads — as grants only.
    const older = parseAgentToolsResponse({ revision: 3, enabled: false, toolsets: [{ id: "notes", locked: false }], grants });
    assert.deepEqual(older, parsed);
    assert.deepEqual(Object.keys(older ?? {}), ["grants"]);
    assert.equal(parseAgentToolsResponse({ revision: 1, toolsets: [] }), null);
    assert.equal(parseAgentToolsResponse("nope"), null);
  });

  it("reads a chat's view for that chat only; an older daemon's toolset fields are ignored", () => {
    const raw = {
      threadId: "t1",
      agent: "codex",
      overrides: { notes: true },
      resolved: ["reads"],
      workflowOwned: true,
      appliesAtNextIdle: true,
      declines: { "workflow-authoring": "2026-10-15T11:00:00.000Z" },
      grants: [{ id: "g1", family: "desktops", scope: "chat", projectPath: "/p", threadId: "t1", createdAt: "c" }]
    };
    const parsed = parseThreadAgentToolsResponse(raw, "t1");
    assert.deepEqual(parsed && Object.keys(parsed).sort(), ["agent", "grants", "threadId", "workflowOwned"]);
    assert.equal(parsed?.workflowOwned, true);
    assert.deepEqual(parsed?.grants.map((grant) => grant.id), ["g1"]);
    assert.deepEqual(parseThreadAgentToolsResponse({ threadId: "t1", agent: "grok", workflowOwned: false, grants: [] }), { threadId: "t1", agent: "grok", workflowOwned: false, grants: [] });
    assert.equal(parseThreadAgentToolsResponse(raw, "t2"), null);
    assert.equal(parseThreadAgentToolsResponse({ ...raw, agent: "someone" }), null);
  });

  it("strips control characters from a grant's family", () => {
    assert.equal(parseAgentToolGrant({ id: "g", family: "work‮flows", scope: "chat", projectPath: "/p", createdAt: "c" })?.family, "workflows");
  });
});

describe("settings and chat grants", () => {
  beforeEach(() => resetAgentTools());

  function fakeApi(): AgentToolsApi & { calls: string[]; settings: AgentToolsResponse; thread: ThreadAgentToolsResponse } {
    const calls: string[] = [];
    const settings: AgentToolsResponse = { grants: [] };
    const thread: ThreadAgentToolsResponse = { threadId: "t1", agent: "claude", workflowOwned: false, grants: [] };
    return {
      calls,
      settings,
      thread,
      getAgentTools: async () => (calls.push("get"), settings),
      revokeAgentToolGrant: async (id) => {
        calls.push(`revoke:${id}`);
        throw new HttpError(404, { error: { code: "GRANT_NOT_FOUND" } });
      },
      revokeAgentToolGrants: async () => ({ revoked: 2 }),
      getThreadAgentTools: async (id) => (calls.push(`thread:${id}`), thread)
    };
  }

  const settle = async (): Promise<void> => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  };

  it("loads settings; an older daemon's bare 404 marks them unsupported", async () => {
    const api = fakeApi();
    await loadAgentToolsSettings(api);
    assert.deepEqual(agentToolsStore.getState().settings, { grants: [] });
    await loadAgentToolsSettings({ ...api, getAgentTools: async () => Promise.reject(new HttpError(404)) });
    assert.equal(agentToolsStore.getState().settingsUnsupported, true);
  });

  it("agentTools.changed re-reads the watched chat and the shown settings", async () => {
    const api = fakeApi();
    const unwatchSettings = watchAgentToolsSettings();
    const unwatch = watchThreadAgentTools("t1");
    await loadAgentToolsSettings(api);
    await loadThreadAgentTools(api, "t1");
    api.calls.length = 0;
    applyAgentToolsEvent({ channel: "agent-tools", type: "agentTools.changed", payload: { threadId: "t1" } });
    await settle();
    assert.deepEqual(api.calls.sort(), ["get", "thread:t1"]);
    api.calls.length = 0;
    // No chat named (an older daemon's `revision` too): the settings and every watched chat; junk is ignored.
    applyAgentToolsEvent({ channel: "agent-tools", type: "agentTools.changed", payload: { revision: 1 } });
    await settle();
    assert.deepEqual(api.calls.sort(), ["get", "thread:t1"]);
    api.calls.length = 0;
    applyAgentToolsEvent({ channel: "agent-tools", type: "agentTools.changed", payload: "junk" });
    await settle();
    assert.deepEqual(api.calls, []);
    unwatch();
    unwatchSettings();
    assert.equal(agentToolsStore.getState().threads.t1, undefined, "an unwatched chat is forgotten");
  });

  it("revoking a grant that is already gone is not an error, and the lists are read again", async () => {
    const api = fakeApi();
    const unwatch = watchAgentToolsSettings();
    await loadAgentToolsSettings(api);
    api.calls.length = 0;
    await revokeAgentToolGrant(api, "g1");
    await settle();
    assert.deepEqual(api.calls, ["revoke:g1", "get"]);
    unwatch();
  });
});
