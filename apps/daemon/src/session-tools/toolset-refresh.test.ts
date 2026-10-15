/**
 * The chat transport's daemon half (unified MCP design 2026-10-15 §9.3, §9.4, spec §14.2.5): the
 * socket-only manifest route, refreshes pushed to the host when toolsets change (in-session where
 * the provider re-lists, else deferred to the next idle point), and the automatic continue turn —
 * posted after the asking turn settles, skipped when the user spoke first.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import Fastify from "fastify";
import { agentChatCommandPath, agentChatRoutes, type AgentAdapterId } from "@orquester/api/agent-chat";
import { AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, type SessionSummary } from "@orquester/api";
import { z } from "zod";

import { daemonRoutesForHost, type SessionToolsManifest, type SessionToolsRefreshResponse } from "../agent-host/host-protocol.ts";
import { defineTool, READ_ONLY, type AnyOrquesterTool, type ThreadCaller, type ToolsetId } from "../mcp/catalog/contract.ts";
import { chatSummary, message, snapshot, stamp } from "../mcp/fixtures.ts";
import { FakeDaemonApi } from "../mcp/testing.ts";
import { registerSessionToolsManifestRoute, SessionToolsRefresher, userMessageIds, type ToolsetRefreshDeps } from "./toolset-refresh.ts";

const tool = (name: string, toolset: ToolsetId, tier: "read" | "admin" = "read"): AnyOrquesterTool =>
  defineTool({
    name, title: name, description: name, input: { x: z.string().optional() }, audiences: ["chat"], toolset, tier,
    ...(tier === "admin" ? { adminFamily: "workflows" as const, approval: async () => ({ title: name, scopeLabel: name, sections: [] }) } : {}),
    scope: async () => ({ projects: [], sessions: [], reads: "none", writes: false, causesTurnIn: [] }),
    annotations: READ_ONLY, resultKind: "json", run: async () => ({})
  }) as AnyOrquesterTool;

const CATALOG = [tool("list_sessions", "core"), tool("list_workflows", "reads"), tool("create_workflow", "workflow-authoring", "admin")];

/** A rig: one chat per agent, toolsets in a mutable map, the host recorded. */
function rig(over: Partial<ToolsetRefreshDeps> = {}) {
  const api = new FakeDaemonApi();
  const toolsets = new Map<string, string[]>([["claude-1", ["core", "reads"]], ["codex-1", ["core", "reads"]]]);
  const agents: Record<string, AgentAdapterId> = { "claude-1": "claude", "codex-1": "codex" };
  const pushed: { threadId: string; manifest: SessionToolsManifest }[] = [];
  const deferred: (() => void)[] = [];
  let hostAnswer: SessionToolsRefreshResponse["applied"] = "live";
  const deps: ToolsetRefreshDeps = {
    thread: (id) => (agents[id] ? { agentId: agents[id]!, home: "system", projectPath: "/w/acme/api" } : null),
    openThreads: () => Object.keys(agents),
    resolvedToolsets: (id) => toolsets.get(id) ?? ["core"],
    agentToolsEnabled: () => true,
    catalog: () => CATALOG,
    api: () => api,
    pushToHost: async (threadId, manifest) => {
      pushed.push({ threadId, manifest });
      return { applied: hostAnswer };
    },
    defer: (run) => deferred.push(run),
    ...over
  };
  api.on("GET", "/api/sessions", { status: 200, body: [chatSummary({ id: "claude-1" }), chatSummary({ id: "codex-1", refId: "codex" })] });
  const refresher = new SessionToolsRefresher(deps);
  return { api, toolsets, pushed, deferred, refresher, setHostAnswer: (answer: SessionToolsRefreshResponse["applied"]) => (hostAnswer = answer) };
}

/** Wait for every queued promise continuation (the refresh is async but never waits on time). */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("the manifest: the thread's toolsets, its block, its denials; Admin tools not for a workflow-owned chat", async () => {
  const r = rig();
  r.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, {
    status: 200,
    body: { servers: [{ agent: "claude", home: "system", scope: "user", name: "orquester_remote", reason: "bearer" }, { agent: "codex", home: "system", scope: "user", name: "codex_remote", reason: "url" }] }
  });
  r.toolsets.set("claude-1", ["core", "reads", "workflow-authoring"]);
  const manifest = (await r.refresher.manifest("claude-1"))!;
  assert.deepEqual(manifest.tools, ["list_sessions", "list_workflows", "create_workflow"]);
  assert.deepEqual(manifest.deny, ["orquester_remote"]);
  assert.match(manifest.instructions, /^## Orquester/);
  assert.equal(await r.refresher.manifest("nobody"), null);
  // Owned by a workflow run: no Admin tool advertised (§5.4).
  r.api.on("GET", "/api/sessions", { status: 200, body: [chatSummary({ id: "claude-1", owner: { kind: "workflow", workflowId: "wf", runId: "r" } } as Partial<SessionSummary>)] });
  assert.deepEqual((await r.refresher.manifest("claude-1"))!.tools, ["list_sessions", "list_workflows"]);
  // Unreadable: fail closed (treated as owned).
  r.api.on("GET", "/api/sessions", { status: 503, body: { code: "UNAVAILABLE" } });
  assert.deepEqual((await r.refresher.manifest("claude-1"))!.tools, ["list_sessions", "list_workflows"]);
});

test("the daemon-pointing read: none from a daemon without it, reused while fresh, read again once invalidated", async () => {
  let now = 0;
  const r = rig({ now: () => now });
  assert.deepEqual(await r.refresher.daemonPointing(), [], "404 → none");
  r.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, { status: 200, body: { servers: [{ agent: "claude", home: "system", scope: "user", name: "a", reason: "url" }] } });
  assert.deepEqual(await r.refresher.daemonPointing(), [], "cached for 30 s");
  r.refresher.invalidateDaemonPointing();
  assert.equal((await r.refresher.daemonPointing()).length, 1);
  r.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, { status: 500, body: {} });
  now = 60_000;
  assert.equal((await r.refresher.daemonPointing()).length, 1, "a failed read keeps the last good list");
});

test("the manifest route: socket-only bearer, 404 for no chat, and a launch records what the thread advertises", async (t) => {
  const r = rig();
  const app = Fastify();
  t.after(() => app.close());
  registerSessionToolsManifestRoute(app, { authorizeHost: (authorization) => authorization === "Bearer host", refresher: r.refresher });
  const post = (body: unknown, authorization = "Bearer host") =>
    app.inject({ method: "POST", url: daemonRoutesForHost.sessionToolsManifest, headers: { authorization }, payload: body as object });
  assert.equal((await post({ threadId: "claude-1" }, "Bearer nope")).statusCode, 401);
  assert.equal((await post({})).statusCode, 400);
  const missing = await post({ threadId: "ghost" });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, "THREAD_NOT_FOUND");
  const check = await post({ threadId: "claude-1", purpose: "check" });
  assert.equal(check.statusCode, 200);
  assert.equal(r.refresher.advertisedToolsets("claude-1"), null, "a look records nothing");
  const launch = await post({ threadId: "claude-1" });
  assert.deepEqual(launch.json().tools, ["list_sessions", "list_workflows"]);
  assert.deepEqual(r.refresher.advertisedToolsets("claude-1"), ["core", "reads"]);
});

test("a toolset change: in-session providers move their advertised set at once and push; others keep it and push later", async () => {
  const r = rig();
  await r.refresher.manifest("claude-1");
  await r.refresher.manifest("codex-1");
  r.toolsets.set("claude-1", ["core", "reads", "notes"]);
  r.toolsets.set("codex-1", ["core", "reads", "notes"]);
  r.refresher.toolsetsChanged("claude-1");
  // Synchronously, before the awaiting request_toolset call resumes (it reads appliesAtNextIdle).
  assert.deepEqual(r.refresher.advertisedToolsets("claude-1"), ["core", "reads", "notes"]);
  r.refresher.toolsetsChanged("codex-1");
  assert.deepEqual(r.refresher.advertisedToolsets("codex-1"), ["core", "reads"], "the live session keeps its list until it restarts");
  assert.equal(r.deferred.length, 1, "the restart-path push waits for a later macrotask");
  await settle();
  assert.deepEqual(r.pushed.map((push) => push.threadId), ["claude-1"]);
  r.setHostAnswer("next-idle");
  r.deferred.shift()!();
  await settle();
  assert.deepEqual(r.pushed.map((push) => push.threadId), ["claude-1", "codex-1"]);
  assert.deepEqual(r.refresher.advertisedToolsets("codex-1"), ["core", "reads"]);
  // A settings change refreshes every open chat; an unknown advertised set of a restart-path chat reads "pending".
  r.refresher.forget("codex-1");
  r.refresher.toolsetsChanged(null);
  assert.deepEqual(r.refresher.advertisedToolsets("codex-1"), []);
});

test("the automatic continue: scheduled only where the tools wait for a restart (mirrors appliesAtNextIdle)", async () => {
  const r = rig();
  const scheduled: string[] = [];
  r.refresher.scheduleContinue = async (threadId) => (scheduled.push(threadId), "posted");
  const asCaller = (threadId: string, agentId: AgentAdapterId): ThreadCaller => ({
    kind: "thread", threadId, title: "t", projectPath: "", workspace: "", cwd: "/", agentId, callId: "c", runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null
  });
  await r.refresher.manifest("claude-1");
  await r.refresher.manifest("codex-1");
  r.toolsets.set("claude-1", ["core", "reads", "notes"]);
  r.toolsets.set("codex-1", ["core", "reads", "notes"]);
  r.refresher.toolsetsChanged("claude-1");
  r.refresher.toolsetsChanged("codex-1");
  r.refresher.toolsetApproved(asCaller("claude-1", "claude"), "notes");
  r.refresher.toolsetApproved(asCaller("codex-1", "codex"), "notes");
  assert.deepEqual(scheduled, ["codex-1"]);
});

// ---------------------------------------------------------------------------
// The continue turn itself, over the bus
// ---------------------------------------------------------------------------

const RUNNING = { latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null }, chatSessionStatus: "running" } as Partial<SessionSummary>;
const SETTLED = { latestTurn: { turnId: "t2", state: "completed", startedAt: stamp(2), completedAt: stamp(3) }, chatSessionStatus: "ready" } as Partial<SessionSummary>;

/** The thread "codex-1": first read running, every later read `after`; snapshots in order. */
function continueRig(after: Partial<SessionSummary>, snapshots: ReturnType<typeof snapshot>[]) {
  const r = rig();
  let reads = 0;
  r.api.on("GET", "/api/sessions", () => ({ status: 200, body: [chatSummary({ id: "codex-1", refId: "codex", ...(reads++ === 0 ? RUNNING : after) })] }));
  let snaps = 0;
  r.api.on("GET", agentChatRoutes.thread("codex-1"), () => ({ status: 200, body: { kind: "snapshot", thread: snapshots[Math.min(snaps++, snapshots.length - 1)] } }));
  const posted: Record<string, unknown>[] = [];
  r.api.on("POST", agentChatCommandPath("codex-1", "turn"), ({ body }) => (posted.push(body as Record<string, unknown>), { status: 200, body: { seq: 9 } }));
  return { ...r, posted };
}

test("posted once the asking turn completed: Orquester's words, its chip, the chat's mode, ifIdle, no causedBy", async () => {
  const before = snapshot({ items: [message("user", "build it")] });
  const r = continueRig(SETTLED, [before, before]);
  assert.equal(await r.refresher.scheduleContinue("codex-1", "workflow-authoring", "plan"), "posted");
  assert.equal(r.posted.length, 1);
  const body = r.posted[0]!;
  assert.equal(body.input, "[Orquester] The Workflow authoring (changes need your approval) tools are now available. Continue the task you were doing.");
  assert.deepEqual(body.context, [{ kind: "toolset-continue", label: "Orquester", ref: "workflow-authoring" }]);
  assert.equal(body.interactionMode, "plan");
  assert.equal(body.ifIdle, true);
  assert.equal(body.causedBy, undefined);
  assert.match(String(body.commandId), /^toolset-continue-/);
});

test("skipped when the user spoke first (a steer into that turn), or another turn ran, or the turn did not complete", async () => {
  const before = snapshot({ items: [message("user", "build it")] });
  const steered = snapshot({ items: [...before.items, message("user", "actually, wait")] });
  const user = continueRig(SETTLED, [before, steered]);
  assert.equal(await user.refresher.scheduleContinue("codex-1", "notes", "default"), "skipped");
  assert.equal(user.posted.length, 0);

  const another = continueRig({ latestTurn: { turnId: "t3", state: "completed", startedAt: stamp(4), completedAt: stamp(5) }, chatSessionStatus: "ready" } as Partial<SessionSummary>, [before, before]);
  assert.equal(await another.refresher.scheduleContinue("codex-1", "notes", "default"), "skipped");
  assert.equal(another.posted.length, 0);

  const stopped = continueRig({ latestTurn: { turnId: "t2", state: "interrupted", startedAt: stamp(2), completedAt: stamp(3) }, chatSessionStatus: "ready" } as Partial<SessionSummary>, [before, before]);
  assert.equal(await stopped.refresher.scheduleContinue("codex-1", "notes", "default"), "skipped");
  assert.equal(stopped.posted.length, 0);
});

test("another chat's message or a reply is not the user speaking; a closed chat's continue is dropped", async () => {
  const before = snapshot({ items: [message("user", "build it")] });
  const replied = snapshot({ items: [...before.items, message("user", "[Reply from thread…]", { context: [{ kind: "thread-reply", label: "Reply from another chat", ref: "x" }] })] });
  assert.deepEqual([...userMessageIds(replied)], [...userMessageIds(before)]);
  const r = continueRig(SETTLED, [before, replied]);
  assert.equal(await r.refresher.scheduleContinue("codex-1", "notes", "default"), "posted");

  // Closed while waiting: the wait ends, nothing is posted.
  const closing = rig();
  closing.api.on("GET", "/api/sessions", { status: 200, body: [chatSummary({ id: "codex-1", refId: "codex", ...RUNNING })] });
  closing.api.on("GET", agentChatRoutes.thread("codex-1"), { status: 200, body: { kind: "snapshot", thread: before } });
  const pending = closing.refresher.scheduleContinue("codex-1", "notes", "default");
  while (closing.api.listenerCount() === 0) await settle();
  closing.refresher.forget("codex-1");
  assert.equal(await pending, "cancelled");
});

test("a refused post (a user turn raced in: TURN_NOT_IDLE) is skipped, never retried as a steer", async () => {
  const before = snapshot({ items: [message("user", "build it")] });
  const r = continueRig(SETTLED, [before, before]);
  r.api.on("POST", agentChatCommandPath("codex-1", "turn"), { status: 409, body: { error: { code: "TURN_NOT_IDLE", message: "busy" } } });
  assert.equal(await r.refresher.scheduleContinue("codex-1", "notes", "default"), "skipped");
});
