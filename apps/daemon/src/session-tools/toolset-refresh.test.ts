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
import { chatSummary, message, snapshot, stamp, turn } from "../mcp/fixtures.ts";
import { FakeDaemonApi } from "../mcp/testing.ts";
import { REFRESH_CONCURRENCY, registerSessionToolsManifestRoute, SessionToolsRefresher, userMessageIds, type ToolsetRefreshDeps } from "./toolset-refresh.ts";

const tool = (name: string, toolset: ToolsetId, tier: "read" | "admin" = "read"): AnyOrquesterTool =>
  defineTool({
    name, title: name, description: name, input: { x: z.string().optional() }, audiences: ["chat"], toolset, tier,
    ...(tier === "admin" ? { adminFamily: "workflows" as const, approval: async () => ({ title: name, scopeLabel: name, sections: [] }) } : {}),
    scope: async () => ({ projects: [], sessions: [], reads: "none", writes: false, causesTurnIn: [] }),
    annotations: READ_ONLY, resultKind: "json", run: async () => ({})
  }) as AnyOrquesterTool;

const CATALOG = [tool("list_sessions", "core"), tool("list_workflows", "reads"), tool("create_workflow", "workflow-authoring", "admin")];

/** Fastify's default not-found body (no `code`): a route the daemon does not have. */
const ROUTE_MISS = { message: "Route GET:/api/agent-profile/daemon-mcp-servers not found", error: "Not Found", statusCode: 404 };

/** A rig: one chat per agent, toolsets in a mutable map, the host recorded. */
function rig(over: Partial<ToolsetRefreshDeps> = {}) {
  const api = new FakeDaemonApi();
  const toolsets = new Map<string, string[]>([["claude-1", ["core", "reads"]], ["codex-1", ["core", "reads"]]]);
  const agents: Record<string, AgentAdapterId> = { "claude-1": "claude", "codex-1": "codex" };
  const pushed: { threadId: string; manifest: SessionToolsManifest }[] = [];
  let hostAnswer: SessionToolsRefreshResponse["applied"] | null = "live";
  const warnings: string[] = [];
  const deps: ToolsetRefreshDeps = {
    thread: (id) => (agents[id] ? { agentId: agents[id]!, home: "system", projectPath: "/w/acme/api" } : null),
    openThreads: () => Object.keys(agents),
    resolvedToolsets: (id) => toolsets.get(id) ?? ["core"],
    agentToolsEnabled: () => true,
    catalog: () => CATALOG,
    api: () => api,
    pushToHost: async (threadId, manifest) => {
      pushed.push({ threadId, manifest });
      return hostAnswer === null ? null : { applied: hostAnswer };
    },
    logger: { warn: (message) => warnings.push(message) },
    ...over
  };
  api.on("GET", "/api/sessions", { status: 200, body: [chatSummary({ id: "claude-1" }), chatSummary({ id: "codex-1", refId: "codex" })] });
  // A daemon without the detection (Task 11 not merged): Fastify's own route-miss 404.
  api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, { status: 404, body: ROUTE_MISS });
  const refresher = new SessionToolsRefresher(deps);
  return { api, toolsets, pushed, warnings, refresher, setHostAnswer: (answer: SessionToolsRefreshResponse["applied"] | null) => (hostAnswer = answer) };
}

/** The manifest of an open chat (not null, not unavailable). */
const manifestOf = async (r: ReturnType<typeof rig>, threadId: string): Promise<SessionToolsManifest> => {
  const manifest = await r.refresher.manifest(threadId);
  assert.ok(manifest !== null && manifest !== "unavailable", "a manifest");
  return manifest as SessionToolsManifest;
};

test("the manifest: the thread's toolsets, its block, its denials; Admin tools not for a workflow-owned chat", async () => {
  const r = rig();
  r.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, {
    status: 200,
    body: { servers: [{ agent: "claude", home: "system", scope: "user", name: "orquester_remote", reason: "bearer" }, { agent: "codex", home: "system", scope: "user", name: "codex_remote", reason: "url" }] }
  });
  r.toolsets.set("claude-1", ["core", "reads", "workflow-authoring"]);
  const manifest = await manifestOf(r, "claude-1");
  assert.deepEqual(manifest.tools, ["list_sessions", "list_workflows", "create_workflow"]);
  assert.deepEqual(manifest.deny, ["orquester_remote"]);
  assert.match(manifest.instructions, /^## Orquester/);
  assert.equal(await r.refresher.manifest("nobody"), null);
  // Owned by a workflow run: no Admin tool advertised (§5.4).
  r.api.on("GET", "/api/sessions", { status: 200, body: [chatSummary({ id: "claude-1", owner: { kind: "workflow", workflowId: "wf", runId: "r" } } as Partial<SessionSummary>)] });
  assert.deepEqual((await manifestOf(r, "claude-1")).tools, ["list_sessions", "list_workflows"]);
  // Unreadable: fail closed (treated as owned).
  r.api.on("GET", "/api/sessions", { status: 503, body: { code: "UNAVAILABLE" } });
  assert.deepEqual((await manifestOf(r, "claude-1")).tools, ["list_sessions", "list_workflows"]);
});

test("the daemon-pointing read: none from a daemon without it, reused while fresh, read again once invalidated", async () => {
  let now = 0;
  const r = rig({ now: () => now });
  assert.deepEqual(await r.refresher.daemonPointing(), [], "404 → none (no detection is not a failure)");
  r.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, { status: 200, body: { servers: [{ agent: "claude", home: "system", scope: "user", name: "a", reason: "url" }] } });
  assert.deepEqual(await r.refresher.daemonPointing(), [], "cached for 30 s");
  r.refresher.invalidateDaemonPointing();
  assert.equal((await r.refresher.daemonPointing())!.length, 1);
  r.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, { status: 500, body: {} });
  now = 60_000;
  assert.equal((await r.refresher.daemonPointing())!.length, 1, "a failed read keeps the last good list");
  assert.equal(r.warnings.length, 1, "and says so");
});

test("fail closed after an invalidation too: a failed re-read answers the last GOOD list, never []", async () => {
  const r = rig();
  r.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, { status: 200, body: { servers: [{ agent: "claude", home: "system", scope: "user", name: "orquester_remote", reason: "bearer" }] } });
  assert.equal((await r.refresher.daemonPointing())!.length, 1);
  r.refresher.invalidateDaemonPointing();
  r.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, { status: 500, body: {} });
  assert.deepEqual((await r.refresher.daemonPointing())!.map((server) => server.name), ["orquester_remote"]);
  assert.deepEqual((await manifestOf(r, "claude-1")).deny, ["orquester_remote"], "the denial stays");
  assert.ok(r.warnings.length >= 1);
});

test("only a route-miss 404 means \"no detection\"; a 404 with our own code is a failure", async () => {
  const r = rig();
  r.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, { status: 404, body: { code: "THREAD_NOT_FOUND", message: "x" } });
  assert.equal(await r.refresher.daemonPointing(), null, "never read: unavailable");
  assert.equal(r.warnings.length, 1);
  r.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, { status: 404, body: { message: "Route GET:/api/agent-profile/daemon-mcp-servers not found", error: "Not Found", statusCode: 404 } });
  assert.deepEqual(await r.refresher.daemonPointing(), []);
});

test("an older push finishing last never overwrites the advertised set (sequenced)", async () => {
  const gates: Array<(answer: SessionToolsRefreshResponse) => void> = [];
  let both!: () => void;
  const arrived = new Promise<void>((resolve) => (both = resolve));
  const r = rig({
    pushToHost: () =>
      new Promise((resolve) => {
        gates.push(resolve);
        if (gates.length === 2) both();
      })
  });
  await r.refresher.manifest("claude-1");
  r.toolsets.set("claude-1", ["core", "reads", "notes"]);
  const first = r.refresher.push("claude-1").done;
  r.toolsets.set("claude-1", ["core", "reads", "notes", "files-git"]);
  const second = r.refresher.push("claude-1").done;
  await arrived;
  gates[1]!({ applied: "live" });
  await second;
  assert.deepEqual(r.refresher.advertisedToolsets("claude-1"), ["core", "reads", "notes", "files-git"]);
  gates[0]!({ applied: "live" });
  await first;
  assert.deepEqual(r.refresher.advertisedToolsets("claude-1"), ["core", "reads", "notes", "files-git"], "the older answer is ignored");
});

test("fail closed: with no good read ever, a failed read makes the manifest unavailable (503), every failure warned", async (t) => {
  const r = rig();
  r.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, { status: 500, body: {} });
  assert.equal(await r.refresher.daemonPointing(), null);
  assert.equal(await r.refresher.manifest("claude-1"), "unavailable");
  assert.equal(r.warnings.length, 2);
  const app = Fastify();
  t.after(() => app.close());
  registerSessionToolsManifestRoute(app, { authorizeHost: () => true, refresher: r.refresher });
  const res = await app.inject({ method: "POST", url: daemonRoutesForHost.sessionToolsManifest, payload: { threadId: "claude-1" } });
  assert.equal(res.statusCode, 503, "the host falls back to what it knows for that launch");
  assert.equal(r.refresher.advertisedToolsets("claude-1"), null, "nothing was handed out");
  // A toolset change cannot be pushed then: pending, no "now".
  await r.refresher.push("claude-1").done;
  assert.deepEqual(r.refresher.advertisedToolsets("claude-1"), []);
  assert.equal(r.pushed.length, 0);
  // Once a read succeeds the manifest is back.
  r.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, { status: 200, body: { servers: [] } });
  assert.deepEqual((await manifestOf(r, "claude-1")).deny, []);
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

test("a push moves the advertised set only when the host applied it; otherwise the change stays pending", async () => {
  const r = rig();
  await r.refresher.manifest("claude-1");
  await r.refresher.manifest("codex-1");
  r.toolsets.set("claude-1", ["core", "reads", "notes"]);
  r.toolsets.set("codex-1", ["core", "reads", "notes"]);
  // Claude, applied in-session.
  assert.equal(await r.refresher.push("claude-1").done, "live");
  assert.deepEqual(r.refresher.advertisedToolsets("claude-1"), ["core", "reads", "notes"]);
  // Codex: a restart is pending — the live session keeps what it launched with.
  r.setHostAnswer("next-idle");
  assert.equal(await r.refresher.push("codex-1").done, "next-idle");
  assert.deepEqual(r.refresher.advertisedToolsets("codex-1"), ["core", "reads"]);
  // Claude whose client did not re-list (next-idle), or no host at all: never "now".
  r.toolsets.set("claude-1", ["core", "reads", "notes", "files-git"]);
  assert.equal(await r.refresher.push("claude-1").done, "next-idle");
  assert.deepEqual(r.refresher.advertisedToolsets("claude-1"), ["core", "reads", "notes"]);
  r.setHostAnswer(null);
  r.refresher.forget("claude-1");
  assert.equal(await r.refresher.push("claude-1").done, "no-host");
  assert.deepEqual(r.refresher.advertisedToolsets("claude-1"), [], "unknown → pending");
});

test("a settings change pushes every chat, at most REFRESH_CONCURRENCY at a time", async () => {
  let inFlight = 0;
  let most = 0;
  let calls = 0;
  let released = false;
  const gates: (() => void)[] = [];
  let full!: () => void;
  const saturated = new Promise<void>((resolve) => (full = resolve));
  const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`codex-${i}`, "codex" as AgentAdapterId]));
  const r = rig({
    thread: (id) => (many[id] ? { agentId: many[id]!, home: "system", projectPath: "/w/acme/api" } : null),
    openThreads: () => Object.keys(many),
    pushToHost: async () => {
      calls += 1;
      inFlight += 1;
      most = Math.max(most, inFlight);
      if (inFlight === REFRESH_CONCURRENCY) full();
      if (!released) await new Promise<void>((resolve) => gates.push(resolve));
      inFlight -= 1;
      return { applied: "next-idle" };
    }
  });
  const done = r.refresher.refresh(null);
  await saturated;
  assert.equal(calls, REFRESH_CONCURRENCY, "no more pushes start while the pool is full");
  released = true;
  gates.splice(0).forEach((go) => go());
  const answers = await done;
  assert.equal(answers.size, 10);
  assert.equal(most, REFRESH_CONCURRENCY);
});

test("request_toolset waits for the host: `next-idle` schedules the continue; live, no host or no answer do not", async () => {
  const scheduled: string[] = [];
  const asCaller = (threadId: string, agentId: AgentAdapterId): ThreadCaller => ({
    kind: "thread", threadId, title: "t", projectPath: "", workspace: "", cwd: "/", agentId, callId: "c", runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null
  });
  const fresh = (over: Partial<ToolsetRefreshDeps> = {}) => {
    const r = rig(over);
    r.refresher.scheduleContinue = async (threadId) => (scheduled.push(threadId), "posted");
    return r;
  };
  const live = fresh();
  live.refresher.toolsetsChanged("claude-1");
  await live.refresher.toolsetApproved(asCaller("claude-1", "claude"), "notes");
  const restart = fresh();
  restart.setHostAnswer("next-idle");
  restart.refresher.toolsetsChanged("codex-1");
  await restart.refresher.toolsetApproved(asCaller("codex-1", "codex"), "notes");
  const none = fresh();
  none.setHostAnswer(null);
  await none.refresher.toolsetApproved(asCaller("codex-1", "codex"), "notes");
  assert.deepEqual(none.refresher.advertisedToolsets("codex-1"), []);
  const slow = fresh({ applyWaitMs: 10, pushToHost: () => new Promise(() => undefined) });
  await slow.refresher.toolsetApproved(asCaller("codex-1", "codex"), "notes");
  assert.deepEqual(slow.refresher.advertisedToolsets("codex-1"), [], "no answer in time: pending");
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
  let subscribed!: () => void;
  const watching = new Promise<void>((resolve) => (subscribed = resolve));
  const subscribe = closing.api.subscribe.bind(closing.api);
  closing.api.subscribe = (listener) => {
    const off = subscribe(listener);
    subscribed();
    return off;
  };
  const pending = closing.refresher.scheduleContinue("codex-1", "notes", "default");
  await watching;
  closing.refresher.forget("codex-1");
  assert.equal(await pending, "cancelled");
});

test("a refused post (a user turn raced in: TURN_NOT_IDLE) is skipped, never retried as a steer", async () => {
  const before = snapshot({ items: [message("user", "build it")] });
  const r = continueRig(SETTLED, [before, before]);
  r.api.on("POST", agentChatCommandPath("codex-1", "turn"), { status: 409, body: { error: { code: "TURN_NOT_IDLE", message: "busy" } } });
  assert.equal(await r.refresher.scheduleContinue("codex-1", "notes", "default"), "skipped");
});

test("request_toolset whose push was overtaken by one that already finished takes THAT outcome (the continue is not lost)", async () => {
  const scheduled: string[] = [];
  const answers: Array<(answer: SessionToolsRefreshResponse) => void> = [];
  let both!: () => void;
  const arrived = new Promise<void>((resolve) => (both = resolve));
  const r = rig({
    pushToHost: () =>
      new Promise((resolve) => {
        answers.push(resolve);
        if (answers.length === 2) both();
      })
  });
  r.refresher.scheduleContinue = async (threadId) => (scheduled.push(threadId), "posted");
  const caller: ThreadCaller = {
    kind: "thread", threadId: "codex-1", title: "t", projectPath: "", workspace: "", cwd: "/", agentId: "codex", callId: "c", runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null
  };
  // The approval's own push, then a settings refresh's newer one.
  r.refresher.toolsetsChanged("codex-1");
  const approval = r.refresher.toolsetApproved(caller, "notes");
  r.refresher.toolsetsChanged("codex-1");
  await arrived;
  // The newer push finishes first (a restart is pending); the older one is superseded.
  answers[1]!({ applied: "next-idle" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  answers[0]!({ applied: "superseded" });
  await approval;
  assert.deepEqual(scheduled, ["codex-1"]);
});

test("manifests carry this daemon's epoch beside the sequence", async () => {
  const r = rig();
  const a = await manifestOf(r, "codex-1");
  const b = await manifestOf(r, "codex-1");
  assert.equal(typeof a.epoch, "string");
  assert.equal(a.epoch, b.epoch);
  assert.ok(b.seq! > a.seq!);
  assert.notEqual(a.epoch, (await manifestOf(rig(), "codex-1")).epoch, "another daemon process, another epoch");
});

// ---------------------------------------------------------------------------
// Fix round 4
// ---------------------------------------------------------------------------

const codexCaller: ThreadCaller = {
  kind: "thread", threadId: "codex-1", title: "t", projectPath: "", workspace: "", cwd: "/", agentId: "codex", callId: "c", runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null
};

test("an OLDER recorded next-idle is no answer to a push the host superseded (a relaunch read it): no continue", async () => {
  const scheduled: string[] = [];
  let answer: SessionToolsRefreshResponse["applied"] = "next-idle";
  const r = rig({ pushToHost: async () => ({ applied: answer }) });
  r.refresher.scheduleContinue = async (threadId) => (scheduled.push(threadId), "posted");
  // An earlier push (a settings change) said a restart is pending…
  assert.equal(await r.refresher.push("codex-1").done, "next-idle");
  // …then the session relaunched with the change, and the approval's own (newer) push is superseded.
  answer = "superseded";
  r.refresher.toolsetsChanged("codex-1");
  await r.refresher.toolsetApproved(codexCaller, "notes");
  assert.deepEqual(scheduled, []);
});

test("an aborted call (Stop, the provider cancelled) stops waiting at once and schedules nothing", async () => {
  const scheduled: string[] = [];
  let asked!: () => void;
  const hostAsked = new Promise<void>((resolve) => (asked = resolve));
  const r = rig({
    pushToHost: () => {
      asked();
      return new Promise(() => undefined);
    }
  });
  r.refresher.scheduleContinue = async (threadId) => (scheduled.push(threadId), "posted");
  const controller = new AbortController();
  r.refresher.toolsetsChanged("codex-1");
  const waiting = r.refresher.toolsetApproved(codexCaller, "notes", controller.signal);
  await hostAsked;
  controller.abort();
  await waiting;
  assert.deepEqual(scheduled, []);
  const before = new AbortController();
  before.abort();
  await r.refresher.toolsetApproved(codexCaller, "notes", before.signal);
  assert.deepEqual(scheduled, []);
});

test("the wait starts when the host is asked (a slow manifest build does not eat it); the pointing read is bounded", async () => {
  const scheduled: string[] = [];
  const r = rig({ applyWaitMs: 50, pointingReadTimeoutMs: 20, pushToHost: async () => ({ applied: "next-idle" }) });
  r.refresher.scheduleContinue = async (threadId) => (scheduled.push(threadId), "posted");
  // The daemon-pointing read never answers: bounded at 20 ms, then the build goes on (no read ever → unavailable).
  const request = r.api.request.bind(r.api);
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  r.api.request = async (method, path, opts) => {
    if (path === AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE) {
      await slow;
    }
    return request(method, path, opts);
  };
  assert.equal(await r.refresher.daemonPointing(), null, "timed out, nothing ever read: unavailable");
  release();
  // A good read, then a slow build longer than the apply wait: the host is still awaited.
  assert.deepEqual(await r.refresher.daemonPointing(), []);
  r.refresher.invalidateDaemonPointing();
  let releaseBuild!: () => void;
  const build = new Promise<void>((resolve) => (releaseBuild = resolve));
  r.api.request = async (method, path, opts) => {
    if (path === AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE) await build;
    return request(method, path, opts);
  };
  r.refresher.toolsetsChanged("codex-1");
  const waiting = r.refresher.toolsetApproved(codexCaller, "notes");
  setTimeout(releaseBuild, 15);
  await waiting;
  assert.deepEqual(scheduled, ["codex-1"]);
});

test("a turn the user stopped is no turn to continue, even when the summary reads it completed", async () => {
  const before = snapshot({ items: [message("user", "build it")], turns: [turn({ turnId: "t2", state: "running", completedAt: null })] });
  const stopped = snapshot({ items: before.items, turns: [turn({ turnId: "t2", state: "interrupted" })] });
  const r = continueRig(SETTLED, [before, stopped]);
  assert.equal(await r.refresher.scheduleContinue("codex-1", "notes", "default"), "skipped");
  assert.equal(r.posted.length, 0);
});
