// The pull request watch session tools, through the real routes (`pr-watch/routes.ts`) on a
// Fastify app and the real service on its test harness: what each tool answers, as which thread,
// and the routes' refusals.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { agentChatRoutes } from "@orquester/api/agent-chat";

import type { DaemonApi } from "../../mcp/daemon-api.ts";
import { registerPullRequestWatchRoutes } from "../../pr-watch/routes.ts";
import { check, cleanupHarnesses, harness, prStatus, REMOTE, type Harness } from "../../pr-watch/testing.ts";
import { executeSessionToolCall } from "../executor.ts";
import { createSessionToolRegistry } from "../registry.ts";
import type { SessionToolContext } from "../contract.ts";
import { pullRequestsToolkit } from "./index.ts";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  cleanupHarnesses();
});

async function setup(): Promise<{ h: Harness; app: FastifyInstance; call: (name: string, args: Record<string, unknown>, threadId?: string) => Promise<CallToolResult> }> {
  const h = await harness();
  const app = Fastify();
  registerPullRequestWatchRoutes(app, { service: () => h.service });
  await app.ready();
  apps.push(app);
  const api: DaemonApi = {
    async request(method, path, opts) {
      const res = await app.inject({ method, url: path, ...(opts?.body !== undefined ? { payload: opts.body as object } : {}) });
      return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as unknown) : null };
    },
    uploadAttachment: async () => ({ status: 503, value: null }),
    subscribe: () => () => undefined,
    fsRoot: "/",
    workspacesDir: "/ws"
  };
  const registry = createSessionToolRegistry([pullRequestsToolkit]);
  const call = async (name: string, args: Record<string, unknown>, threadId = "s1") => {
    const ctx: SessionToolContext = {
      threadId,
      projectPath: "/ws/acme/app",
      cwd: "/ws/acme/app",
      agentId: "claude",
      callId: "c1",
      signal: new AbortController().signal,
      api,
      now: () => Date.now()
    };
    const result = await executeSessionToolCall(registry, { name, arguments: args }, ctx);
    await h.service.idle();
    return result;
  };
  return { h, app, call };
}

const json = (result: CallToolResult): Record<string, unknown> => {
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return result.structuredContent as Record<string, unknown>;
};
const failure = (result: CallToolResult): string => {
  assert.equal(result.isError, true);
  return (result.content[0] as { text: string }).text;
};

test("watch, list, unwatch: the agent sees the current state and the watch belongs to its own thread", async () => {
  const { h, call } = await setup();
  h.pulls.set(`${REMOTE}#12`, prStatus({ checks: [check("build", "failure"), check("lint", "success")], mergeability: "conflicting" }));

  const watched = json(await call("watch_pull_request", { number: 12 }));
  assert.equal(watched.watching, true);
  assert.equal(watched.wasWatching, false);
  const pr = watched.pullRequest as Record<string, unknown>;
  assert.equal(pr.repository, "acme/app");
  assert.equal(pr.state, "open");
  assert.equal(pr.mergeability, "conflicting");
  assert.deepEqual(pr.checks, { total: 2, passed: 1, failed: 1, pending: 0 });
  assert.equal(pr.head, "aaaaaaaaaaaa");

  assert.equal(json(await call("watch_pull_request", { url: "https://github.com/acme/app/pull/12" })).wasWatching, true);
  const listed = json(await call("list_pull_request_watches", {}));
  assert.equal((listed.watches as unknown[]).length, 1);

  // Another thread sees none of it, and cannot stop it.
  h.sessions.set("s2", { ...h.sessions.get("s1")!, id: "s2" });
  assert.deepEqual(json(await call("list_pull_request_watches", {}, "s2")).watches, []);
  assert.deepEqual(json(await call("unwatch_pull_request", { number: 12 }, "s2")), { watching: false, wasWatching: false });

  const stopped = json(await call("unwatch_pull_request", { url: "https://github.com/acme/app/pull/12/files" }));
  assert.equal(stopped.wasWatching, true);
  assert.deepEqual(json(await call("list_pull_request_watches", {})).watches, []);
  assert.deepEqual(json(await call("unwatch_pull_request", { number: 12 })), { watching: false, wasWatching: false });
});

test("the tools' refusals name the fix", async () => {
  const { h, call } = await setup();
  assert.match(failure(await call("watch_pull_request", {})), /either url or number/);
  assert.match(failure(await call("watch_pull_request", { number: 7 })), /was not found/);
  h.pulls.set(`${REMOTE}#8`, prStatus({ number: 8, state: "closed" }));
  assert.match(failure(await call("watch_pull_request", { number: 8 })), /is closed, so there is nothing to watch/);
  assert.match(failure(await call("watch_pull_request", { url: "https://example.com/x" })), /not a pull request URL/);
  // A thread argument is not part of the input: the caller can only act as itself.
  assert.match(failure(await call("watch_pull_request", { number: 1, threadId: "s2" })), /threadId/);
  assert.match(failure(await call("unwatch_pull_request", { number: 1, watchId: "x" })), /exactly one/);
});

test("routes: list, create (201 / 200), delete, and their refusals", async () => {
  const { h, app } = await setup();
  h.pulls.set(`${REMOTE}#12`, prStatus());
  const created = await app.inject({ method: "POST", url: agentChatRoutes.prWatches("s1"), payload: { number: 12 } });
  assert.equal(created.statusCode, 201);
  const watchId = (created.json() as { watch: { id: string } }).watch.id;
  assert.equal((await app.inject({ method: "POST", url: agentChatRoutes.prWatches("s1"), payload: { number: 12 } })).statusCode, 200);
  const listed = await app.inject({ method: "GET", url: agentChatRoutes.prWatches("s1") });
  assert.equal((listed.json() as { watches: unknown[] }).watches.length, 1);

  const bad = await app.inject({ method: "POST", url: agentChatRoutes.prWatches("s1"), payload: { number: "12" } });
  assert.equal(bad.statusCode, 400);
  assert.equal((bad.json() as { error: { code: string } }).error.code, "INVALID_ARGUMENT");
  const extra = await app.inject({ method: "POST", url: agentChatRoutes.prWatches("s1"), payload: { number: 12, sessionId: "s2" } });
  assert.equal(extra.statusCode, 400);
  const unknown = await app.inject({ method: "GET", url: agentChatRoutes.prWatches("nope") });
  assert.equal(unknown.statusCode, 404);
  assert.equal((unknown.json() as { error: { code: string } }).error.code, "THREAD_NOT_FOUND");

  assert.equal((await app.inject({ method: "DELETE", url: agentChatRoutes.prWatch("s1", watchId) })).statusCode, 200);
  const again = await app.inject({ method: "DELETE", url: agentChatRoutes.prWatch("s1", watchId) });
  assert.equal(again.statusCode, 404);
  assert.equal((again.json() as { error: { code: string } }).error.code, "WATCH_NOT_FOUND");
});

test("routes answer 503 until the service runs", async () => {
  const app = Fastify();
  registerPullRequestWatchRoutes(app, { service: () => null });
  apps.push(app);
  const res = await app.inject({ method: "GET", url: agentChatRoutes.prWatches("s1") });
  assert.equal(res.statusCode, 503);
  assert.equal((res.json() as { error: { code: string } }).error.code, "UNAVAILABLE");
});
