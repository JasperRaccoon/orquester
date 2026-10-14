/**
 * Thread lineage's routes (spec 2026-10-14 §6): paths from `agentChatRoutes`,
 * refusals in the §6.2 envelope with their statuses, nothing internal leaked.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";

import { agentChatRoutes } from "@orquester/api/agent-chat";

import { ChatSessionError } from "./chat-sessions.ts";
import { LineageError, type LineageService } from "./lineage.ts";
import { registerLineageRoutes } from "./lineage-routes.ts";

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
