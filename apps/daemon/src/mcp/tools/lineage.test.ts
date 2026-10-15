/**
 * `fork_session` and `merge_back_session` for an external caller (full trust), ported from the
 * pre-catalog definitions' tests (spec §11): the fork cut by transcript turn number, the host's
 * refusal passed through, one fork per call however often the host restarts (the same commandId),
 * a fork's merge back, and `resolve_merge_back` as `merge_back_session {mergeId, action}`.
 * `get_session_lineage` is `get_session`'s `lineage` (`sessions.test.ts`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { agentChatRoutes } from "@orquester/api/agent-chat";
import type { CallContext } from "../catalog/contract.ts";
import { chatSummary, snapshot, stamp, turn } from "../fixtures.ts";
import { FakeDaemonApi } from "../testing.ts";
import { lineageFamily } from "./lineage.ts";

/** An external caller's context (full trust), as the executor builds it for `/mcp`. */
const external = (api: FakeDaemonApi): CallContext => ({
  api,
  signal: new AbortController().signal,
  now: () => 0,
  caller: { kind: "external" },
  turn: { interactionMode: "default", provenance: (_origin, text) => text }
});
const tool = (name: string) => {
  const unified = lineageFamily.find((t) => t.name === name)!;
  return { run: (args: Record<string, unknown>, api: FakeDaemonApi) => unified.run(args as never, external(api)) as Promise<Record<string, unknown>> };
};
/** A POST body without its minted commandId, which every call must carry. */
const withoutId = (body: unknown): Record<string, unknown> => {
  const { commandId, ...rest } = body as Record<string, unknown>;
  assert.equal(typeof commandId, "string", "a commandId is minted for the call");
  return rest;
};

function harness(turns = [turn({ turnId: "t1", state: "completed" }), turn({ turnId: "t2", state: "completed" })]) {
  const api = new FakeDaemonApi();
  const snap = { ...snapshot(), turns };
  api
    .on("GET", "/api/sessions", {
      status: 200,
      body: [chatSummary(), chatSummary({ id: "f1", title: "fork", lineage: { parentThreadId: "c1", relation: "fork", createdAt: stamp(1) } })]
    })
    .on("GET", "/api/sessions/c1/thread", { status: 200, body: { kind: "snapshot", thread: snap } })
    .on("GET", "/api/sessions/f1/thread", { status: 200, body: { kind: "snapshot", thread: snap } })
    .on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [] } })
    .on("GET", "/api/agent/providers", { status: 200, body: { hostInstanceId: "h", providers: [] } })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: {} } });
  return { api };
}

test("fork_session forks through a transcript turn number and returns the new session", async () => {
  const { api } = harness();
  api.on("POST", agentChatRoutes.fork("c1"), {
    status: 200,
    body: { session: chatSummary({ id: "f1" }), strategy: "native", lineage: { parentThreadId: "c1", relation: "fork", createdAt: "x" } }
  });
  const result = await tool("fork_session").run({ sessionId: "c1", throughTurn: 1, title: "B" }, api);
  assert.equal(result.strategy, "native");
  assert.equal((result.session as { id: string }).id, "f1");
  const post = api.calls.find((c) => c.method === "POST")!;
  assert.deepEqual(withoutId(post.body), { title: "B", turnId: "t1", role: "assistant" });

  await tool("fork_session").run({ sessionId: "c1", throughTurn: 0 }, api);
  assert.deepEqual(withoutId(api.calls.filter((c) => c.method === "POST").at(-1)!.body), { turnId: "t1", role: "user" });
  await tool("fork_session").run({ sessionId: "c1" }, api);
  assert.deepEqual(withoutId(api.calls.filter((c) => c.method === "POST").at(-1)!.body), {}, "default: the host picks the latest finished turn");
});

test("fork_session refuses a turn past the end, and passes the host's refusal through", async () => {
  const { api } = harness();
  await assert.rejects(tool("fork_session").run({ sessionId: "c1", throughTurn: 3 }, api), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /between 0 and 2/.test(e.message));
  api.on("POST", agentChatRoutes.fork("c1"), { status: 409, body: { error: { code: "COMMAND_REJECTED", message: "That reply is still being written." } } });
  await assert.rejects(tool("fork_session").run({ sessionId: "c1" }, api), (e: { code: string; message: string }) => e.code === "COMMAND_REJECTED" && /still being written/.test(e.message));
});

test("merge_back_session sends the fork's text and reports the delivery; a session that is no fork is refused", async () => {
  const { api } = harness();
  api.on("POST", agentChatRoutes.mergeBack("f1"), { status: 200, body: { parentSessionId: "c1", delivery: "queued", mergeId: "m1" } });
  const result = await tool("merge_back_session").run({ sessionId: "f1", text: "Use B." }, api);
  assert.deepEqual(result, { parentSessionId: "c1", delivery: "queued", mergeId: "m1" });
  assert.deepEqual(withoutId(api.calls.find((c) => c.method === "POST")!.body), { text: "Use B." });
  await tool("merge_back_session").run({ sessionId: "f1" }, api);
  assert.deepEqual(withoutId(api.calls.filter((c) => c.method === "POST").at(-1)!.body), {});
  const posts = api.calls.filter((c) => c.method === "POST").length;
  await assert.rejects(tool("merge_back_session").run({ sessionId: "c1", text: "x" }, api), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  assert.equal(api.calls.filter((c) => c.method === "POST").length, posts, "nothing was sent");
});

test("fork_session re-sends the SAME commandId while the host restarts, so a retry is one fork", async () => {
  const { api } = harness();
  let attempts = 0;
  api.on("POST", agentChatRoutes.fork("c1"), () => {
    attempts += 1;
    return attempts === 1
      ? { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "restarting" } } }
      : { status: 200, body: { session: chatSummary({ id: "f1" }), strategy: "native", lineage: { parentThreadId: "c1", relation: "fork", createdAt: "x" } } };
  });
  await tool("fork_session").run({ sessionId: "c1" }, api);
  const ids = api.calls.filter((c) => c.method === "POST").map((c) => (c.body as { commandId: string }).commandId);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});

test("resolve_merge_back is merge_back_session {mergeId, action}: deliver or discard a pending merge", async () => {
  const { api } = harness();
  api.on("POST", agentChatRoutes.mergeBackItem("c1", "m1"), (call) => ({
    status: 200,
    body: { mergeId: "m1", outcome: (call.body as { action: string }).action === "deliver" ? "sent" : "discarded" }
  }));
  assert.deepEqual(await tool("merge_back_session").run({ sessionId: "c1", mergeId: "m1", action: "deliver" }, api), { mergeId: "m1", outcome: "sent" });
  assert.deepEqual(await tool("merge_back_session").run({ sessionId: "c1", mergeId: "m1", action: "discard" }, api), { mergeId: "m1", outcome: "discarded" });
});
