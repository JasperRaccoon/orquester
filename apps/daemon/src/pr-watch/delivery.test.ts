// The wake's send path: the thread's own `/turn` route, keeping the thread's interaction mode, and
// telling a deleted thread from a host-side miss.

import assert from "node:assert/strict";
import { test } from "node:test";

import { agentChatCommandPath, agentChatRoutes } from "@orquester/api/agent-chat";

import type { DaemonApi, DaemonResponse } from "../mcp/daemon-api.ts";
import { deliverThroughTurnRoute } from "./service.ts";

function fakeApi(answers: Record<string, DaemonResponse>): { api: DaemonApi; posts: unknown[] } {
  const posts: unknown[] = [];
  const api = {
    async request(method: string, path: string, opts?: { body?: unknown }) {
      if (method === "POST") posts.push(opts?.body);
      return answers[`${method} ${path}`] ?? { status: 200, body: { seq: 1 } };
    }
  } as unknown as DaemonApi;
  return { api, posts };
}

const thread = (modes: Array<string | undefined>): DaemonResponse => ({
  status: 200,
  body: { kind: "snapshot", thread: { turns: modes.map((interactionMode) => (interactionMode ? { interactionMode } : {})) } }
});

test("a wake keeps the thread's current interaction mode", async () => {
  for (const [modes, expected] of [
    [["default", "plan"], "plan"],
    [["plan", "default"], "default"],
    [["plan", undefined], "plan"],
    [[], "default"]
  ] as const) {
    const { api, posts } = fakeApi({ [`GET ${agentChatRoutes.thread("s1")}`]: thread([...modes]) });
    const outcome = await deliverThroughTurnRoute(() => api)("s1", { commandId: "pr-watch:1", input: "x" });
    assert.deepEqual(outcome, { kind: "sent" });
    assert.deepEqual(posts, [{ commandId: "pr-watch:1", input: "x", interactionMode: expected }], JSON.stringify(modes));
  }
});

test("a wake keeps a running turn the user steered into plan mode in plan mode (steer-aware)", async () => {
  const steered: DaemonResponse = {
    status: 200,
    body: {
      kind: "snapshot",
      thread: {
        head: { session: { activeTurnId: "t2" } },
        turns: [{ turnId: "t2", state: "running", interactionMode: "default" }],
        items: [{ kind: "message", id: "u2", role: "user", text: "plan first", turnId: "t2", interactionMode: "plan" }]
      }
    }
  };
  const { api, posts } = fakeApi({ [`GET ${agentChatRoutes.thread("s1")}`]: steered });
  await deliverThroughTurnRoute(() => api)("s1", { commandId: "pr-watch:2", input: "x" });
  assert.deepEqual(posts, [{ commandId: "pr-watch:2", input: "x", interactionMode: "plan" }]);
});

test("only THREAD_NOT_FOUND is a gone thread; an unreadable thread or a host miss is not", async () => {
  const notFound = { status: 404, body: { error: { code: "THREAD_NOT_FOUND", message: "No chat session with that id." } } };
  const gone = fakeApi({ [`GET ${agentChatRoutes.thread("s1")}`]: notFound });
  assert.deepEqual(await deliverThroughTurnRoute(() => gone.api)("s1", { commandId: "c", input: "x" }), { kind: "gone" });
  assert.deepEqual(gone.posts, []);

  const hostMiss = fakeApi({
    [`GET ${agentChatRoutes.thread("s1")}`]: thread(["default"]),
    [`POST ${agentChatCommandPath("s1", "turn")}`]: { status: 404, body: { error: { code: "ITEM_NOT_FOUND", message: "No route" } } }
  });
  const missed = await deliverThroughTurnRoute(() => hostMiss.api)("s1", { commandId: "c", input: "x" });
  assert.equal(missed.kind, "refused");

  const down = fakeApi({ [`GET ${agentChatRoutes.thread("s1")}`]: { status: 503, body: { error: { code: "HOST_UNAVAILABLE" } } } });
  assert.deepEqual(await deliverThroughTurnRoute(() => down.api)("s1", { commandId: "c", input: "x" }), { kind: "unavailable" });
  assert.deepEqual(down.posts, []);
});

test("the thread is read once per wake: a retry of the same wake reuses its mode", async () => {
  let reads = 0;
  let posts = 0;
  const api = {
    async request(method: string) {
      if (method === "GET") {
        reads += 1;
        return thread(["plan"]);
      }
      posts += 1;
      return posts === 1 ? { status: 503, body: { error: { code: "HOST_UNAVAILABLE" } } } : { status: 200, body: { seq: 2 } };
    }
  } as unknown as DaemonApi;
  const deliver = deliverThroughTurnRoute(() => api);
  assert.deepEqual(await deliver("s1", { commandId: "pr-watch:9", input: "x" }), { kind: "unavailable" });
  assert.deepEqual(await deliver("s1", { commandId: "pr-watch:9", input: "x" }), { kind: "sent" });
  assert.equal(reads, 1);
  // A new wake reads the thread again (the mode may have changed since).
  await deliver("s1", { commandId: "pr-watch:10", input: "y" });
  assert.equal(reads, 2);
});
