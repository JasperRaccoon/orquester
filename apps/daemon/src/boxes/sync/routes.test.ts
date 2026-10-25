import assert from "node:assert/strict";
import { test } from "node:test";

import Fastify from "fastify";

import { boxRoutes, type BoxConfigChangeSet } from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";

import { BoxSyncError } from "./config-sync.ts";
import { registerBoxConfigChangeRoutes } from "./routes.ts";

const SET: BoxConfigChangeSet = {
  id: "c1",
  boxId: "b1",
  threadId: "t1",
  createdAt: "2026-10-20T00:00:00.000Z",
  decidedAt: null,
  state: "pending",
  files: [{ path: "/h/CLAUDE.md", change: "modified", executable: false, diff: "--- a\n+++ b", truncated: false, binary: false }]
};

function app(principal: CallerPrincipal | null) {
  const decisions: { id: string; decision: string }[] = [];
  const server = Fastify();
  server.addHook("onRequest", async (request) => {
    if (principal) (request as unknown as { principal: CallerPrincipal }).principal = principal;
  });
  registerBoxConfigChangeRoutes(server, {
    sync: {
      listChanges: async () => [SET],
      decide: async (id, decision) => {
        decisions.push({ id, decision });
        if (id === "gone") throw new BoxSyncError("BOX_CONFIG_CHANGE_NOT_FOUND", "No such box config change.", 404);
        return { ...SET, state: decision === "approve" ? "approved" : "denied" };
      }
    },
    logger: { error: () => undefined }
  });
  return { server, decisions };
}

test("list and decide as the user", async () => {
  const { server, decisions } = app(null);
  const listed = await server.inject({ method: "GET", url: boxRoutes.configChanges });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json(), { changes: [SET] });
  const decided = await server.inject({ method: "POST", url: boxRoutes.configChange("c1"), payload: { decision: "approve" } });
  assert.equal(decided.statusCode, 200);
  assert.equal(decided.json().change.state, "approved");
  assert.deepEqual(decisions, [{ id: "c1", decision: "approve" }]);
  const missing = await server.inject({ method: "POST", url: boxRoutes.configChange("gone"), payload: { decision: "deny" } });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, "BOX_CONFIG_CHANGE_NOT_FOUND");
  const bad = await server.inject({ method: "POST", url: boxRoutes.configChange("c1"), payload: { decision: "maybe" } });
  assert.equal(bad.statusCode, 400);
  await server.close();
});

test("agents and external MCP clients cannot decide", async () => {
  for (const principal of [
    { kind: "agent", threadId: "t1", projectPath: "/w/p", agent: "claude" } as unknown as CallerPrincipal,
    { kind: "external", credentialId: "x" } as CallerPrincipal
  ]) {
    const { server, decisions } = app(principal);
    const response = await server.inject({ method: "POST", url: boxRoutes.configChange("c1"), payload: { decision: "approve" } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, "PERMISSION_DENIED");
    assert.equal(decisions.length, 0);
    await server.close();
  }
});
