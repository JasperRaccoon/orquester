import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { Broadcaster } from "../broadcaster.ts";
import * as ladder from "../agent-chat/activity-ladder.ts";
import * as mcpAgents from "../mcp/agents.ts";
import * as mcpApi from "../mcp/daemon-api.ts";
import * as mcpErrors from "../mcp/errors.ts";
import * as mcpReads from "../mcp/reads.ts";
import * as mcpViews from "../mcp/views.ts";
import * as mcpWait from "../mcp/wait.ts";
import * as chatClient from "./index.ts";

// The workflow engine and the MCP must drive chat sessions with the SAME functions: a wrapper or a
// copy here could drift from what the MCP (and its tests) exercise.

test("chat-client re-exports the very functions the MCP uses, never copies", () => {
  const pairs: [string, unknown, unknown][] = [
    ["InjectDaemonApi", chatClient.InjectDaemonApi, mcpApi.InjectDaemonApi],
    ["ToolError", chatClient.ToolError, mcpErrors.ToolError],
    ["daemonError", chatClient.daemonError, mcpErrors.daemonError],
    ["expectOk", chatClient.expectOk, mcpErrors.expectOk],
    ["sendCommand", chatClient.sendCommand, mcpReads.sendCommand],
    ["readThread", chatClient.readThread, mcpReads.readThread],
    ["requireChatSession", chatClient.requireChatSession, mcpReads.requireChatSession],
    ["findSession", chatClient.findSession, mcpReads.findSession],
    ["listSessions", chatClient.listSessions, mcpReads.listSessions],
    ["mintCommandId", chatClient.mintCommandId, mcpReads.mintCommandId],
    ["turnBaseline", chatClient.turnBaseline, mcpWait.turnBaseline],
    ["turnOutcome", chatClient.turnOutcome, mcpWait.turnOutcome],
    ["waitForTurn", chatClient.waitForTurn, mcpWait.waitForTurn],
    ["watchSessions", chatClient.watchSessions, mcpWait.watchSessions],
    ["assistantTextForTurn", chatClient.assistantTextForTurn, mcpViews.assistantTextForTurn],
    ["latestSettledTurn", chatClient.latestSettledTurn, mcpViews.latestSettledTurn],
    ["lastReply", chatClient.lastReply, mcpViews.lastReply],
    ["loadAgents", chatClient.loadAgents, mcpAgents.loadAgents],
    ["findAgent", chatClient.findAgent, mcpAgents.findAgent],
    ["findModel", chatClient.findModel, mcpAgents.findModel],
    ["resolveModelSelection", chatClient.resolveModelSelection, mcpAgents.resolveModelSelection],
    ["validateAccountId", chatClient.validateAccountId, mcpAgents.validateAccountId],
    ["launchesProxyModel", chatClient.launchesProxyModel, mcpAgents.launchesProxyModel],
    ["EFFORT_OPTION_IDS", chatClient.EFFORT_OPTION_IDS, mcpAgents.EFFORT_OPTION_IDS],
    ["resolveChatActivity", chatClient.resolveChatActivity, ladder.resolveChatActivity]
  ];
  for (const [name, facade, original] of pairs) {
    assert.equal(typeof facade === "function" || typeof facade === "object", true, `${name} is exported`);
    assert.equal(facade, original, `${name} is the MCP's own`);
  }
});

test("createInternalDaemonApi runs routes in-process with NO authorization header", async (t) => {
  const app = Fastify();
  app.post("/echo", async (request) => ({
    authorization: request.headers.authorization ?? null,
    body: request.body
  }));
  await app.ready();
  t.after(() => app.close());
  const api = chatClient.createInternalDaemonApi({
    app,
    broadcaster: new Broadcaster(),
    agentChat: null,
    fsRoot: "/fs",
    workspacesDir: "/fs/ws"
  });
  assert.ok(api instanceof mcpApi.InjectDaemonApi);
  assert.equal(api.fsRoot, "/fs");
  assert.equal(api.workspacesDir, "/fs/ws");
  const res = await api.request("POST", "/echo", { body: { a: 1 } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { authorization: null, body: { a: 1 } });
});

test("sendCommand posts a caller's persisted commandId as is, and mints one otherwise", async () => {
  const bodies: Record<string, unknown>[] = [];
  const api: chatClient.DaemonApi = {
    fsRoot: "/fs",
    workspacesDir: "/fs/ws",
    request: async (_method, _path, opts) => {
      bodies.push(opts?.body as Record<string, unknown>);
      return { status: 200, body: { seq: bodies.length } };
    },
    uploadAttachment: async () => ({ status: 503, value: null }),
    subscribe: () => () => undefined
  };
  assert.deepEqual(
    await chatClient.sendCommand(api, "s1", "turn", { commandId: "ignored", input: "hi" }, { commandId: "persisted-1" }),
    { seq: 1 }
  );
  assert.equal(bodies[0]!.commandId, "persisted-1");
  await chatClient.sendCommand(api, "s1", "turn", { commandId: "ignored" });
  assert.notEqual(bodies[1]!.commandId, "ignored", "the MCP's rule: a body commandId never wins");
  assert.equal(typeof bodies[1]!.commandId, "string");
});
