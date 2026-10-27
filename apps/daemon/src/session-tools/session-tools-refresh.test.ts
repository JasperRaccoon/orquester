/**
 * The chat transport's daemon half (unified MCP design 2026-10-15 §9.4, §12.1, spec §14.2.5): the
 * socket-only manifest route — every chat tool for every chat, none always-Admin for a
 * workflow-owned one — the daemon-pointing reads behind its deny list (fail closed), and the
 * pushes to the host (a refused launch's manifest once its denials are known; a refresh of every
 * open chat).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import Fastify from "fastify";
import type { AgentAdapterId } from "@orquester/api/agent-chat";
import { AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, type SessionSummary } from "@orquester/api";
import { z } from "zod";

import { daemonRoutesForHost, type SessionToolsManifest, type SessionToolsRefreshResponse } from "../agent-host/host-protocol.ts";
import { defineTool, READ_ONLY, type AnyOrquesterTool, type ToolsetId } from "../mcp/catalog/contract.ts";
import { chatSummary } from "../mcp/fixtures.ts";
import { FakeDaemonApi } from "../mcp/testing.ts";
import {
  isFastifyRouteMiss,
  registerSessionToolsManifestRoute,
  SessionToolsRefresher,
  type SessionToolsRefreshDeps
} from "./session-tools-refresh.ts";
import type { ManifestKnowledge } from "./manifest.ts";

const tool = (name: string, toolset: ToolsetId, tier: "read" | "admin" = "read"): AnyOrquesterTool =>
  defineTool({
    name, title: name, description: name, input: { x: z.string().optional() }, audiences: ["chat"], toolset, tier,
    ...(tier === "admin" ? { adminFamily: "workflows" as const, approval: async () => ({ title: name, scopeLabel: name, sections: [] }) } : {}),
    scope: async () => ({ projects: [], sessions: [], reads: "none", writes: false, causesTurnIn: [] }),
    annotations: READ_ONLY, resultKind: "json", run: async () => ({})
  }) as AnyOrquesterTool;

const CATALOG = [tool("list_sessions", "core"), tool("list_workflows", "reads"), tool("update_todos", "notes"), tool("create_workflow", "workflow-authoring", "admin")];
const ALL = CATALOG.map((entry) => entry.name);

/** Fastify's default not-found body (no `code`): a route the daemon does not have. */
const ROUTE_MISS = { message: "Route GET:/api/agent-profile/daemon-mcp-servers not found", error: "Not Found", statusCode: 404 };

/** A rig: one chat per agent, the host recorded. */
function rig(over: Partial<SessionToolsRefreshDeps> = {}) {
  const api = new FakeDaemonApi();
  const agents: Record<string, AgentAdapterId> = { "claude-1": "claude", "codex-1": "codex" };
  const pushed: { threadId: string; manifest: SessionToolsManifest }[] = [];
  let hostAnswer: SessionToolsRefreshResponse["applied"] | null = "live";
  const warnings: string[] = [];
  const deps: SessionToolsRefreshDeps = {
    thread: (id) => (agents[id] ? { agentId: agents[id]!, home: "system", projectPath: "/w/acme/api" } : null),
    openThreads: () => Object.keys(agents),
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
  return { api, pushed, warnings, refresher, setHostAnswer: (answer: SessionToolsRefreshResponse["applied"] | null) => (hostAnswer = answer) };
}

/** The manifest of an open chat (not null, not unavailable). */
const manifestOf = async (r: ReturnType<typeof rig>, threadId: string): Promise<SessionToolsManifest> => {
  const manifest = await r.refresher.manifest(threadId);
  assert.ok(manifest !== null && manifest !== "unavailable", "a manifest");
  return manifest as SessionToolsManifest;
};

test("the manifest: every chat tool, for any agent with nothing configured; its block and denials; no Admin tool for a workflow-owned chat", async () => {
  const r = rig();
  r.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, {
    status: 200,
    body: { servers: [{ agent: "claude", home: "system", scope: "user", name: "orquester_remote", reason: "bearer" }, { agent: "codex", home: "system", scope: "user", name: "codex_remote", reason: "url" }] }
  });
  for (const threadId of ["claude-1", "codex-1"]) assert.deepEqual((await manifestOf(r, threadId)).tools, ALL, threadId);
  const manifest = await manifestOf(r, "claude-1");
  assert.deepEqual(manifest.deny, ["orquester_remote"]);
  assert.match(manifest.instructions, /^## Orquester/);
  assert.doesNotMatch(manifest.instructions, /request_toolset|Off at chat start/);
  assert.equal(manifest.toolsets, undefined);
  assert.equal(await r.refresher.manifest("nobody"), null);
  // Owned by a workflow run: no always-Admin tool advertised (§5.4).
  r.api.on("GET", "/api/sessions", { status: 200, body: [chatSummary({ id: "claude-1", owner: { kind: "workflow", workflowId: "wf", runId: "r" } } as Partial<SessionSummary>)] });
  assert.deepEqual((await manifestOf(r, "claude-1")).tools, ["list_sessions", "list_workflows", "update_todos"]);
  // Unreadable: fail closed (treated as owned).
  r.api.on("GET", "/api/sessions", { status: 503, body: { code: "UNAVAILABLE" } });
  assert.deepEqual((await manifestOf(r, "claude-1")).tools, ["list_sessions", "list_workflows", "update_todos"]);
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

test("Task 11's own refusals (its {error: {code}} envelope: a 404, a 400 for a projectPath outside the workspaces root) are failed reads: the last good list, else unavailable (503)", async () => {
  const t11NotFound = { status: 404, body: { error: { code: "AGENT_NOT_FOUND", message: "x" } } };
  const t11Outside = { status: 400, body: { error: { code: "INVALID_REQUEST", message: "projectPath is not a project under the workspaces root." } } };
  for (const answer of [t11NotFound, t11Outside]) {
    const never = rig();
    never.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, answer);
    assert.equal(await never.refresher.daemonPointing(), null, `${answer.status}: never read → unavailable`);
    assert.equal(await never.refresher.manifest("claude-1"), "unavailable", "the manifest route answers 503; the host uses its keyed fallback");
    const good = rig();
    good.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, { status: 200, body: { servers: [{ agent: "claude", home: "system", scope: "user", name: "orquester_remote", reason: "bearer" }] } });
    assert.equal((await good.refresher.daemonPointing())!.length, 1);
    good.refresher.invalidateDaemonPointing();
    good.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, answer);
    assert.deepEqual((await manifestOf(good, "claude-1")).deny, ["orquester_remote"], `${answer.status}: the last good list stays`);
  }
  // Only Fastify's exact default body is a route miss: a look-alike with more fields is not.
  assert.equal(isFastifyRouteMiss({ ...ROUTE_MISS, code: "X" }), false);
  assert.equal(isFastifyRouteMiss({ message: "Route GET:/x not found", error: "Not Found", statusCode: 404 }), true);
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
  // Nothing can be pushed then either.
  assert.equal(await r.refresher.push("claude-1"), "no-host");
  assert.equal(r.pushed.length, 0);
  // Once a read succeeds the manifest is back.
  r.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, { status: 200, body: { servers: [] } });
  assert.deepEqual((await manifestOf(r, "claude-1")).deny, []);
});

test("the manifest route: socket-only bearer, 404 for no chat, every chat tool for a launch or a look", async (t) => {
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
  assert.deepEqual(check.json().tools, ALL);
  const launch = await post({ threadId: "claude-1" });
  assert.deepEqual(launch.json().tools, ALL);
  assert.equal(launch.json().toolsets, undefined, "the legacy toolsets field is no longer sent");
});

test("a push hands the host the chat's manifest and answers what the host did with it", async () => {
  const r = rig();
  assert.equal(await r.refresher.push("claude-1"), "live");
  assert.deepEqual(r.pushed.map((entry) => [entry.threadId, entry.manifest.tools]), [["claude-1", ALL]]);
  r.setHostAnswer("next-idle");
  assert.equal(await r.refresher.push("codex-1"), "next-idle");
  r.setHostAnswer("unchanged");
  assert.equal(await r.refresher.push("codex-1"), "unchanged");
  r.setHostAnswer(null);
  assert.equal(await r.refresher.push("codex-1"), "no-host");
  assert.equal(await r.refresher.push("nobody"), "no-host");
  assert.equal(r.pushed.length, 4, "no push for a chat that is not open");
  // Pushes are sequenced within this daemon process.
  const seqs = r.pushed.map((entry) => entry.manifest.seq!);
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs);
});

test("a refresh of every open chat pushes each chat exactly once and reports each answer", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `codex-${i}`);
  const pushed: string[] = [];
  const r = rig({
    thread: (id) => (ids.includes(id) ? { agentId: "codex", home: "system", projectPath: "/w/acme/api" } : null),
    openThreads: () => ids,
    pushToHost: async (id) => {
      pushed.push(id);
      return { applied: "next-idle" };
    }
  });
  const answers = await r.refresher.refresh(null);
  assert.deepEqual(pushed.sort(), [...ids].sort());
  assert.deepEqual([...answers].sort(), ids.map((id) => [id, "next-idle"]).sort());
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

test("the daemon-pointing read is bounded: no answer in time, nothing ever read → unavailable", async () => {
  const r = rig({ pointingReadTimeoutMs: 20 });
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
  // The read that outlived the bound still lands: the next caller gets its list.
  assert.deepEqual(await r.refresher.daemonPointing(), []);
});

test("concurrent manifests share ONE daemon-pointing read", async () => {
  const r = rig();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const request = r.api.request.bind(r.api);
  let reads = 0;
  r.api.request = async (method, path, opts) => {
    if (path === AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE) {
      reads += 1;
      await gate;
    }
    return request(method, path, opts);
  };
  const both = Promise.all([r.refresher.manifest("claude-1"), r.refresher.manifest("codex-1"), r.refresher.daemonPointing()]);
  release();
  const [claude, codex, servers] = await both;
  assert.equal(reads, 1, "one read in flight, shared");
  assert.notEqual(claude, "unavailable");
  assert.notEqual(codex, "unavailable");
  assert.deepEqual(servers, []);
});

test("the session list read inside a manifest is bounded: no answer in time counts as workflow-owned", async () => {
  const r = rig({ sessionsReadTimeoutMs: 20 });
  const request = r.api.request.bind(r.api);
  r.api.request = async (method, path, opts) => (path === "/api/sessions" ? new Promise(() => undefined) : request(method, path, opts));
  const manifest = await manifestOf(r, "claude-1");
  assert.deepEqual(manifest.tools, ["list_sessions", "list_workflows", "update_todos"], "no Admin tool (fail closed)");
  assert.ok(r.warnings.some((warning) => /session list did not answer/.test(warning)));
});

test("a chat refused for unknown denials gets its manifest pushed once the daemon-pointing read lands", async () => {
  let pushedTo!: (push: { threadId: string; deny: string[] }) => void;
  const pushedOnce = new Promise<{ threadId: string; deny: string[] }>((resolve) => (pushedTo = resolve));
  const r = rig({
    pointingReadTimeoutMs: 20,
    pushToHost: async (threadId, manifest) => {
      pushedTo({ threadId, deny: manifest.deny });
      return { applied: "unchanged" };
    }
  });
  r.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, { status: 200, body: { servers: [{ agent: "codex", home: "system", scope: "user", name: "codex_remote", reason: "url" }] } });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const request = r.api.request.bind(r.api);
  r.api.request = async (method, path, opts) => {
    if (path === AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE) await gate;
    return request(method, path, opts);
  };
  // The read outlasts the launch's bound: the manifest route answers 503…
  assert.equal(await r.refresher.manifest("codex-1"), "unavailable");
  // …and when the read lands, the host (whose launch waits for its denials) is handed the manifest.
  release();
  assert.deepEqual(await pushedOnce, { threadId: "codex-1", deny: ["codex_remote"] });
});

test("a chat started in a directory inside its project is denied the servers configured on the way down to it", async () => {
  const r = rig({
    thread: (id) => (id === "codex-1" ? { agentId: "codex", home: "system", projectPath: "/w/acme/api", cwd: "/w/acme/api/packages/app" } : null)
  });
  const queries: unknown[] = [];
  r.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, (request: { query?: Record<string, string> }) => {
    queries.push(request.query);
    const scoped = request.query?.cwd !== undefined;
    return {
      status: 200,
      body: {
        servers: scoped
          ? [
              { agent: "codex", home: "system", scope: "project", projectPath: "/w/acme/api", name: "root_remote", reason: "url" },
              { agent: "codex", home: "system", scope: "project", projectPath: "/w/acme/api/packages", name: "sub_remote", reason: "url" },
              { agent: "codex", home: "system", scope: "project", projectPath: "/w/acme/api/packages/app", name: "cwd_remote", reason: "url" },
              { agent: "codex", home: "system", scope: "project", projectPath: "/w/acme/api/docs", name: "sibling_remote", reason: "url" }
            ]
          : [{ agent: "codex", home: "system", scope: "project", projectPath: "/w/acme/api", name: "from_the_root_read", reason: "url" }]
      }
    };
  });
  const manifest = await manifestOf(r, "codex-1");
  assert.deepEqual(manifest.deny, ["cwd_remote", "root_remote", "sub_remote"], "never a sibling directory's (Codex refuses a name its config lacks)");
  // Only its own read: what loads at ITS cwd (Codex's trust and layers are decided for it).
  assert.deepEqual(queries, [{ projectPath: "/w/acme/api", cwd: "/w/acme/api/packages/app" }]);
});

test("a refused chat stays remembered until a push actually reached the host", async () => {
  let delivered = false;
  const pushes: string[] = [];
  let pushed!: () => void;
  let next = new Promise<void>((resolve) => (pushed = resolve));
  /** The next push to reach `pushToHost`, its answer taken in. */
  const nextPush = async (): Promise<void> => {
    await next;
    next = new Promise<void>((resolve) => (pushed = resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const r = rig({
    pushToHost: async (threadId) => {
      pushes.push(threadId);
      pushed();
      return delivered ? { applied: "unchanged" } : null;
    }
  });
  r.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, { status: 500, body: {} });
  assert.equal(await r.refresher.manifest("codex-1"), "unavailable");
  // A read lands, but the push reaches no host (it timed out, or restarts): still remembered.
  r.api.on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, { status: 200, body: { servers: [] } });
  assert.deepEqual(await r.refresher.daemonPointing(), []);
  await nextPush();
  assert.deepEqual(pushes, ["codex-1"]);
  // The chat's own later launch manifest (one the host may have given up on) pushes again; this one lands.
  delivered = true;
  assert.notEqual(await r.refresher.manifest("codex-1"), "unavailable");
  await nextPush();
  assert.deepEqual(pushes, ["codex-1", "codex-1"]);
  // Delivered: nothing more is owed to it.
  assert.notEqual(await r.refresher.manifest("codex-1"), "unavailable");
  assert.deepEqual(pushes, ["codex-1", "codex-1"], "a delivered manifest is not pushed again");
});


test("Knowledge Graph: the chat's knowledge view is read fresh for every manifest; failing or unanswered it counts as off", async () => {
  const catalog = [...CATALOG, tool("knowledge_search", "knowledge"), tool("knowledge_save", "knowledge"), tool("knowledge_worker_next_task", "knowledge")];
  const reads: string[] = [];
  let view: ManifestKnowledge | Error | "hang" = { enabled: true, worker: false, searchable: true, visibleCollectionNames: ["SEO"] };
  const r = rig({
    catalog: () => catalog,
    knowledgeInfoTimeoutMs: 20,
    knowledgeForSession: async (threadId) => {
      reads.push(threadId);
      if (view === "hang") return new Promise<ManifestKnowledge>(() => undefined);
      if (view instanceof Error) throw view;
      return view;
    }
  });
  const on = await manifestOf(r, "claude-1");
  assert.deepEqual(on.tools, [...ALL, "knowledge_search", "knowledge_save"]);
  assert.match(on.instructions, /\nKnowledge: SEO\. Search it \(knowledge_search\)/);
  // A profile edit is seen by the next manifest (and so by the next push): nothing is cached.
  view = { enabled: true, worker: false, searchable: false, visibleCollectionNames: [] };
  const blind = await manifestOf(r, "claude-1");
  assert.deepEqual(blind.tools, [...ALL, "knowledge_save"]);
  assert.doesNotMatch(blind.instructions, /Knowledge:/);
  view = { enabled: true, worker: true, searchable: false, visibleCollectionNames: [] };
  assert.deepEqual((await manifestOf(r, "claude-1")).tools, ["knowledge_worker_next_task"]);
  assert.deepEqual(reads, ["claude-1", "claude-1", "claude-1"]);
  for (const failing of [new Error("store down"), "hang" as const]) {
    view = failing;
    const off = await manifestOf(r, "claude-1");
    assert.deepEqual(off.tools, ALL, "the plugin counts as off");
    assert.doesNotMatch(off.instructions, /Knowledge:/);
  }
  assert.ok(r.warnings.some((warning) => /knowledge read failed/.test(warning)));
  assert.ok(r.warnings.some((warning) => /knowledge read did not answer in time/.test(warning)));
  // Unwired (the integration not there yet): off.
  assert.deepEqual((await manifestOf(rig({ catalog: () => catalog }), "claude-1")).tools, ALL);
});

test("Knowledge Graph: a worker session (its owner in the session list) gets ONLY the worker tools even when the knowledge read fails, hangs or is unwired", async () => {
  const catalog = [...CATALOG, tool("knowledge_search", "knowledge"), tool("knowledge_save", "knowledge"), tool("knowledge_worker_next_task", "knowledge"), tool("knowledge_worker_submit", "knowledge")];
  const worker = [chatSummary({ id: "claude-1", owner: { kind: "knowledge-indexer", runId: "r1" } } as unknown as Partial<SessionSummary>)];
  let view: Error | "hang" = new Error("store down");
  const r = rig({
    catalog: () => catalog,
    knowledgeInfoTimeoutMs: 20,
    knowledgeForSession: async () => (view === "hang" ? new Promise<ManifestKnowledge>(() => undefined) : Promise.reject(view))
  });
  r.api.on("GET", "/api/sessions", { status: 200, body: worker });
  for (const failing of [new Error("store down"), "hang" as const]) {
    view = failing;
    const manifest = await manifestOf(r, "claude-1");
    assert.deepEqual(manifest.tools, ["knowledge_worker_next_task", "knowledge_worker_submit"], String(failing));
    assert.doesNotMatch(manifest.instructions, /list_sessions|update_todos/);
  }
  const unwired = rig({ catalog: () => catalog });
  unwired.api.on("GET", "/api/sessions", { status: 200, body: worker });
  assert.deepEqual((await manifestOf(unwired, "claude-1")).tools, ["knowledge_worker_next_task", "knowledge_worker_submit"]);
  // A chat that is no worker is untouched by the owner check.
  assert.deepEqual((await manifestOf(rig({ catalog: () => catalog }), "claude-1")).tools, ALL);
});
