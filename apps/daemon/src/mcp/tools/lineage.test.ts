import { test } from "node:test";
import assert from "node:assert/strict";
import { agentChatRoutes } from "@orquester/api/agent-chat";
import { chatSummary, snapshot, turn } from "../fixtures.ts";
import { FakeDaemonApi } from "../testing.ts";
import type { ToolContext } from "../tool.ts";
import { lineageTools } from "./lineage.ts";

const tool = (name: string) => lineageTools.find((t) => t.name === name)!;
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
    .on("GET", "/api/sessions", { status: 200, body: [chatSummary(), chatSummary({ id: "f1", title: "fork" })] })
    .on("GET", "/api/sessions/c1/thread", { status: 200, body: { kind: "snapshot", thread: snap } })
    .on("GET", "/api/sessions/f1/thread", { status: 200, body: { kind: "snapshot", thread: snap } })
    .on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [] } })
    .on("GET", "/api/agent/providers", { status: 200, body: { hostInstanceId: "h", providers: [] } })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: {} } });
  const ctx: ToolContext = { api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => 0 };
  return { api, ctx };
}

test("fork_session forks through a transcript turn number and returns the new session", async () => {
  const { api, ctx } = harness();
  api.on("POST", agentChatRoutes.fork("c1"), {
    status: 200,
    body: { session: chatSummary({ id: "f1" }), strategy: "native", lineage: { parentThreadId: "c1", relation: "fork", createdAt: "x" } }
  });
  const result = await tool("fork_session").run({ sessionId: "c1", throughTurn: 1, title: "B" }, ctx);
  assert.equal(result.strategy, "native");
  assert.equal((result.session as { id: string }).id, "f1");
  const post = api.calls.find((c) => c.method === "POST")!;
  assert.deepEqual(withoutId(post.body), { title: "B", turnId: "t1", role: "assistant" });

  await tool("fork_session").run({ sessionId: "c1", throughTurn: 0 }, ctx);
  assert.deepEqual(withoutId(api.calls.filter((c) => c.method === "POST").at(-1)!.body), { turnId: "t1", role: "user" });
  await tool("fork_session").run({ sessionId: "c1" }, ctx);
  assert.deepEqual(withoutId(api.calls.filter((c) => c.method === "POST").at(-1)!.body), {}, "default: the host picks the latest finished turn");
});

test("fork_session refuses a turn past the end, and passes the host's refusal through", async () => {
  const { api, ctx } = harness();
  await assert.rejects(tool("fork_session").run({ sessionId: "c1", throughTurn: 3 }, ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /between 0 and 2/.test(e.message));
  api.on("POST", agentChatRoutes.fork("c1"), { status: 409, body: { error: { code: "COMMAND_REJECTED", message: "That reply is still being written." } } });
  await assert.rejects(tool("fork_session").run({ sessionId: "c1" }, ctx), (e: { code: string; message: string }) => e.code === "COMMAND_REJECTED" && /still being written/.test(e.message));
});

test("merge_back_session sends the fork's text and reports the delivery", async () => {
  const { api, ctx } = harness();
  api.on("POST", agentChatRoutes.mergeBack("f1"), { status: 200, body: { parentSessionId: "c1", delivery: "queued", mergeId: "m1" } });
  const result = await tool("merge_back_session").run({ sessionId: "f1", text: "Use B." }, ctx);
  assert.deepEqual(result, { parentSessionId: "c1", delivery: "queued", mergeId: "m1" });
  assert.deepEqual(withoutId(api.calls.find((c) => c.method === "POST")!.body), { text: "Use B." });
  await tool("merge_back_session").run({ sessionId: "f1" }, ctx);
  assert.deepEqual(withoutId(api.calls.filter((c) => c.method === "POST").at(-1)!.body), {});
});

test("get_session_lineage reads the daemon's lineage", async () => {
  const { api, ctx } = harness();
  const body = { sessionId: "c1", lineage: null, parent: null, children: [{ sessionId: "f1", title: "fork", exists: true, relation: "fork", createdAt: "x" }], pendingMerges: [] };
  api.on("GET", agentChatRoutes.lineage("c1"), { status: 200, body });
  assert.deepEqual(await tool("get_session_lineage").run({ sessionId: "c1" }, ctx), body);
});

test("fork_session re-sends the SAME commandId while the host restarts, so a retry is one fork", async () => {
  const { api, ctx } = harness();
  let attempts = 0;
  api.on("POST", agentChatRoutes.fork("c1"), () => {
    attempts += 1;
    return attempts === 1
      ? { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "restarting" } } }
      : { status: 200, body: { session: chatSummary({ id: "f1" }), strategy: "native", lineage: { parentThreadId: "c1", relation: "fork", createdAt: "x" } } };
  });
  await tool("fork_session").run({ sessionId: "c1" }, ctx);
  const ids = api.calls.filter((c) => c.method === "POST").map((c) => (c.body as { commandId: string }).commandId);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});

test("resolve_merge_back delivers or discards a pending merge", async () => {
  const { api, ctx } = harness();
  api.on("POST", agentChatRoutes.mergeBackItem("c1", "m1"), (call) => ({
    status: 200,
    body: { mergeId: "m1", outcome: (call.body as { action: string }).action === "deliver" ? "sent" : "discarded" }
  }));
  assert.deepEqual(await tool("resolve_merge_back").run({ sessionId: "c1", mergeId: "m1", action: "deliver" }, ctx), { mergeId: "m1", outcome: "sent" });
  assert.deepEqual(await tool("resolve_merge_back").run({ sessionId: "c1", mergeId: "m1", action: "discard" }, ctx), { mergeId: "m1", outcome: "discarded" });
});
