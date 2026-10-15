/**
 * Thread lineage's routes (spec 2026-10-14 §6): paths from `agentChatRoutes`,
 * refusals in the §6.2 envelope with their statuses, nothing internal leaked.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";

import { agentChatRoutes, type CallerPrincipal } from "@orquester/api/agent-chat";

import { ChatSessionError } from "./chat-sessions.ts";
import { LineageError, type LineageService } from "./lineage.ts";
import { gateSessionCreateBody, registerLineageRoutes, registerReplySubscriptionRoutes } from "./lineage-routes.ts";
import { ReplyError, type ReplyRouter } from "./replies.ts";

function app(overrides: { fork?: () => Promise<unknown>; lineage?: Partial<LineageService> | null } = {}) {
  const server = Fastify();
  registerLineageRoutes(server, {
    isChatSession: (id) => id === "chat-1",
    lineage: () =>
      overrides.lineage === null
        ? null
        : ({
            view: (id: string) => ({ sessionId: id, lineage: null, parent: null, children: [], pendingMerges: [] }),
            mergeBack: async () => ({ parentSessionId: "p", delivery: "queued", mergeId: "m" }),
            actOnMerge: async (_id: string, mergeId: string, body: { action: string }) =>
              ({ mergeId, outcome: body.action === "deliver" ? "sent" : "discarded" }) as never,
            ...overrides.lineage
          } as LineageService),
    fork: (overrides.fork ?? (async () => ({ ok: true }))) as never
  });
  return server;
}

test("the three routes answer on agentChatRoutes' paths", async () => {
  const server = app();
  const read = await server.inject({ method: "GET", url: agentChatRoutes.lineage("chat-1") });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().sessionId, "chat-1");
  const merge = await server.inject({ method: "POST", url: agentChatRoutes.mergeBack("chat-1"), payload: {} });
  assert.equal(merge.json().delivery, "queued");
  const fork = await server.inject({ method: "POST", url: agentChatRoutes.fork("chat-1"), payload: {} });
  assert.deepEqual(fork.json(), { ok: true });
  for (const url of [agentChatRoutes.lineage("nope")]) {
    const missing = await server.inject({ method: "GET", url });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "THREAD_NOT_FOUND");
  }
});

test("refusals keep their code and words; anything else is a generic rejection", async () => {
  const refused = app({
    fork: async () => {
      throw new ChatSessionError("That reply is still being written.", "COMMAND_REJECTED");
    },
    lineage: {
      mergeBack: async () => {
        throw new LineageError("Orquester is still starting.", "HOST_UNAVAILABLE");
      }
    }
  });
  const fork = await refused.inject({ method: "POST", url: agentChatRoutes.fork("chat-1"), payload: {} });
  assert.equal(fork.statusCode, 409);
  assert.deepEqual(fork.json(), { error: { code: "COMMAND_REJECTED", message: "That reply is still being written." } });
  const merge = await refused.inject({ method: "POST", url: agentChatRoutes.mergeBack("chat-1"), payload: {} });
  assert.equal(merge.statusCode, 503);

  const crashed = app({
    fork: async () => {
      throw new Error("ENOENT /var/lib/secret/path");
    }
  });
  const leaked = await crashed.inject({ method: "POST", url: agentChatRoutes.fork("chat-1"), payload: {} });
  assert.equal(leaked.statusCode, 409);
  assert.doesNotMatch(leaked.body, /secret/);

  const starting = app({ lineage: null });
  const early = await starting.inject({ method: "POST", url: agentChatRoutes.mergeBack("chat-1"), payload: {} });
  assert.equal(early.statusCode, 503);
});

test("a pending merge is acted on by its id, from a tab that may already be closed", async () => {
  const server = app();
  const res = await server.inject({ method: "POST", url: agentChatRoutes.mergeBackItem("closed-fork", "m 1"), payload: { action: "discard" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { mergeId: "m 1", outcome: "discarded" });
  const refused = app({
    lineage: {
      actOnMerge: async () => {
        throw new LineageError("No pending merge with that id for this session.", "THREAD_NOT_FOUND");
      }
    }
  });
  const missing = await refused.inject({ method: "POST", url: agentChatRoutes.mergeBackItem("x", "m"), payload: { action: "deliver" } });
  assert.equal(missing.statusCode, 404);
});

test("a refusal whose code is not on the wire list (SESSION_UNAVAILABLE) answers 409 COMMAND_REJECTED, as documented", async () => {
  const server = app({
    fork: async () => {
      throw new ChatSessionError("The account this conversation runs under is no longer available, so it cannot be forked.", "SESSION_UNAVAILABLE");
    }
  });
  const res = await server.inject({ method: "POST", url: agentChatRoutes.fork("chat-1"), payload: {} });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "COMMAND_REJECTED");
  assert.match(res.json().error.message, /no longer available/);
});

// --- unified MCP design 2026-10-15: principal gates and the socket-only reply routes ---------

/** A test app whose principal comes from a test header (Task 2's hook stands in). */
function gatedApp(record: { sessionBody?: unknown; forkBody?: unknown; replies?: ReplyRouter | null }) {
  const server = Fastify();
  server.addHook("onRequest", async (request) => {
    const header = request.headers["x-test-principal"];
    if (typeof header === "string") (request as unknown as { principal: CallerPrincipal }).principal = JSON.parse(header) as CallerPrincipal;
  });
  registerLineageRoutes(server, {
    isChatSession: (id) => id === "chat-1" || id === "chat-2",
    lineage: () =>
      ({
        mergeBack: async () => ({ parentSessionId: "p", delivery: "queued", mergeId: "m" }),
        actOnMerge: async (_id: string, mergeId: string) => ({ mergeId, outcome: "discarded" }) as never
      }) as unknown as LineageService,
    fork: (async (_id: string, body: unknown) => {
      record.forkBody = body;
      return { ok: true };
    }) as never
  });
  // Declared after the lineage routes, as `index.ts` declares it.
  server.post("/api/sessions", async (request) => {
    record.sessionBody = request.body;
    return { ok: true };
  });
  return server;
}

const agentOf = (threadId: string) => JSON.stringify({ kind: "agent", threadId, projectPath: "/w/p" });

test("lineage.agentCreated on session create survives only from the parent's own agent (principal-gated)", async () => {
  const record: { sessionBody?: unknown } = {};
  const server = gatedApp(record);
  const lineage = () => ({ parentThreadId: "chat-1", relation: "opened", agentCreated: true });
  // Both spellings the service reads (`chatFields`): top-level `lineage` and `chat.lineage`.
  const shapes = [
    { payload: () => ({ kind: "agent-chat", lineage: lineage() }), read: (b: unknown) => (b as { lineage: Record<string, unknown> }).lineage },
    {
      payload: () => ({ kind: "agent-chat", chat: { lineage: lineage() } }),
      read: (b: unknown) => (b as { chat: { lineage: Record<string, unknown> } }).chat.lineage
    }
  ];
  for (const shape of shapes) {
    await server.inject({ method: "POST", url: "/api/sessions", payload: shape.payload(), headers: { "x-test-principal": agentOf("chat-1") } });
    assert.equal(shape.read(record.sessionBody).agentCreated, true, "the parent's agent: kept");
    for (const headers of [{}, { "x-test-principal": agentOf("chat-2") }, { "x-test-principal": JSON.stringify({ kind: "external" }) }]) {
      await server.inject({ method: "POST", url: "/api/sessions", payload: shape.payload(), headers });
      assert.equal("agentCreated" in shape.read(record.sessionBody), false, JSON.stringify(headers));
      assert.equal(shape.read(record.sessionBody).relation, "opened", "the rest of the lineage is untouched");
    }
  }
  assert.equal(gateSessionCreateBody("not an object", undefined), "not an object");
});

test("ForkSessionRequest.agentCreated survives only from the forked chat's agent; merges only as oneself", async () => {
  const record: { forkBody?: unknown } = {};
  const server = gatedApp(record);
  await server.inject({ method: "POST", url: agentChatRoutes.fork("chat-1"), payload: { agentCreated: true }, headers: { "x-test-principal": agentOf("chat-1") } });
  assert.deepEqual(record.forkBody, { agentCreated: true });
  await server.inject({ method: "POST", url: agentChatRoutes.fork("chat-1"), payload: { agentCreated: true, title: "x" } });
  assert.deepEqual(record.forkBody, { title: "x" }, "the GUI's fork is nobody's child");
  await server.inject({ method: "POST", url: agentChatRoutes.fork("chat-1"), payload: { agentCreated: true }, headers: { "x-test-principal": agentOf("chat-2") } });
  assert.deepEqual(record.forkBody, {});

  const asOther = await server.inject({ method: "POST", url: agentChatRoutes.mergeBack("chat-1"), payload: {}, headers: { "x-test-principal": agentOf("chat-2") } });
  assert.equal(asOther.statusCode, 403);
  const item = await server.inject({ method: "POST", url: agentChatRoutes.mergeBackItem("chat-1", "m"), payload: { action: "discard" }, headers: { "x-test-principal": agentOf("chat-2") } });
  assert.equal(item.statusCode, 403);
  const self = await server.inject({ method: "POST", url: agentChatRoutes.mergeBackItem("chat-1", "m"), payload: { action: "discard" }, headers: { "x-test-principal": agentOf("chat-1") } });
  assert.equal(self.statusCode, 200);
});

test("a merge past the exchange cap answers 409 EXCHANGE_LIMIT", async () => {
  const server = app({
    lineage: {
      mergeBack: async () => {
        throw new LineageError("This exchange reached its limit.", "EXCHANGE_LIMIT");
      }
    }
  });
  const res = await server.inject({ method: "POST", url: agentChatRoutes.mergeBack("chat-1"), payload: {} });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "EXCHANGE_LIMIT");
});

test("the reply-subscription routes exist only where registered (the unix app), and answer the router's refusals", async () => {
  const remote = app();
  const missing = await remote.inject({ method: "POST", url: agentChatRoutes.replySubscriptions("chat-1"), payload: {} });
  assert.equal(missing.statusCode, 404, "registerLineageRoutes never adds them");

  const server = Fastify();
  const calls: unknown[] = [];
  registerReplySubscriptionRoutes(server, {
    isChatSession: (id) => id === "chat-1",
    replies: () =>
      ({
        subscribe: async (target: string, body: unknown) => {
          calls.push([target, body]);
          throw new ReplyError("This chat already waits for 20 replies.", "REPLY_SUBSCRIPTION_LIMIT");
        },
        wait: async () => ({ outcome: "notify", reason: "timeout", willNotify: true })
      }) as unknown as ReplyRouter
  });
  const limited = await server.inject({ method: "POST", url: agentChatRoutes.replySubscriptions("chat-1"), payload: { fromThreadId: "x" } });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, "REPLY_SUBSCRIPTION_LIMIT");
  assert.deepEqual(calls, [["chat-1", { fromThreadId: "x" }]]);
  const notChat = await server.inject({ method: "POST", url: agentChatRoutes.replySubscriptions("nope"), payload: {} });
  assert.equal(notChat.statusCode, 404);
  const waited = await server.inject({ method: "POST", url: agentChatRoutes.replySubscriptionWait("chat-1", "s-1"), payload: { timeoutSeconds: 5 } });
  assert.deepEqual(waited.json(), { outcome: "notify", reason: "timeout", willNotify: true });
});
