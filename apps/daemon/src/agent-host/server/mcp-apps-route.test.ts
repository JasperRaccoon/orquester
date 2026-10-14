/**
 * `POST /threads/:id/mcp-apps/:operation` end to end inside the host (spec
 * 2026-10-14 §3): the route, the orchestrator's resolution of the app from the
 * stored row, and the request reaching the thread's adapter against the
 * app's own server — or the §6.2 refusal the app is shown.
 */

import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { SECRET_REDACTED_TEXT, type McpAppReference, type ThreadActivityItem } from "@orquester/api/agent-chat";

import type { AdapterMcpApps } from "../adapter.ts";
import type { OrchestratorOptions } from "../orchestration/orchestrator.ts";
import { SessionSecretRedactor } from "../session-tools/secret-redaction.ts";
import { createTestHost, type TestHost } from "../orchestration/testing/index.ts";
import { agentHostExtraRoutes } from "./extra-routes.ts";
import { createAgentHostServer } from "./http-server.ts";

const TOKEN = "test-token";
const reference: McpAppReference = {
  attachmentId: "t1-0f8fad5b-d9cb-469f-a165-70867728950e-html",
  server: "charts",
  tool: "show_chart",
  resourceUri: "ui://charts/view"
};

async function pushActivity(host: TestHost, threadId: string, activity: Partial<ThreadActivityItem> & { id: string }) {
  await host.orchestrator.ingestionSink(threadId, [
    {
      eventId: `ing-${activity.id}`,
      threadId,
      type: "thread.activity-appended",
      payload: {
        activity: {
          kind: "activity",
          tone: "tool",
          activityKind: "tool.completed",
          summary: "charts: show_chart",
          payload: {},
          turnId: null,
          createdAt: host.clock.nowIso(),
          updatedAt: host.clock.nowIso(),
          ...activity
        } as ThreadActivityItem
      },
      occurredAt: host.clock.nowIso(),
      commandId: null,
      causationEventId: null,
      metadata: {}
    }
  ]);
}

async function setup(options: { secrets?: OrchestratorOptions["secrets"]; answer?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-mcp-apps-"));
  const socketPath = join(dir, "agent-host.sock");
  const host = createTestHost({ openGate: true, ...(options.secrets ? { secrets: options.secrets } : {}) });
  const calls: unknown[] = [];
  const mcpApps: AdapterMcpApps = {
    modelContext: false,
    listTools: async () => [{ name: "reset", readOnly: false, definition: { name: "reset" } }],
    callTool: async (threadId, input) => {
      calls.push({ threadId, ...input });
      return { content: [{ type: "text", text: options.answer ?? "reset" }] };
    },
    readResource: async () => ({ contents: [] })
  };
  Object.assign(host.adapter, { mcpApps });
  const server = createAgentHostServer({
    orchestrator: host.orchestrator,
    store: host.store,
    logger: host.logger,
    hostInstanceId: "host-test",
    token: TOKEN,
    socketPath,
    tmpDir: join(dir, "tmp"),
    startedAt: "1970-01-01T00:00:00.000Z",
    onStop: async () => ({ ok: true, markedThreadIds: [] })
  });
  await server.listen();
  const call = (path: string, body: unknown) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = request(
        {
          socketPath,
          method: "POST",
          path,
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload)
          }
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") })
          );
        }
      );
      req.on("error", reject);
      req.end(payload);
    });
  return {
    host,
    calls,
    call,
    stop: async () => {
      await server.close();
      await host.stop();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

describe("the host's MCP App route", () => {
  it("runs a request of the app a stored row carries, against that row's own server", async () => {
    const h = await setup();
    try {
      const threadId = await h.host.createThread();
      await pushActivity(h.host, threadId, {
        id: "tool-1",
        payload: {
          itemType: "mcp_tool_call",
          status: "completed",
          data: { server: "charts", tool: "show_chart", arguments: {}, mcpApp: reference }
        }
      });
      await pushActivity(h.host, threadId, {
        id: "tool-2",
        payload: { itemType: "mcp_tool_call", status: "completed", data: { server: "evil", tool: "show_chart", mcpApp: reference } }
      });
      await h.host.settle();

      const ok = await h.call(agentHostExtraRoutes.mcpApp(threadId, "call-tool"), {
        itemId: "tool-1",
        name: "reset",
        arguments: { hard: true }
      });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.body, { content: [{ type: "text", text: "reset" }] });
      assert.deepEqual(h.calls, [{ threadId, server: "charts", tool: "reset", arguments: { hard: true } }]);

      const foreign = await h.call(agentHostExtraRoutes.mcpApp(threadId, "call-tool"), {
        itemId: "tool-2",
        name: "reset",
        arguments: {}
      });
      assert.equal(foreign.status, 404);
      assert.equal(foreign.body.error.code, "ITEM_NOT_FOUND");

      const context = await h.call(agentHostExtraRoutes.mcpApp(threadId, "model-context"), {
        itemId: "tool-1",
        content: [{ type: "text", text: "x" }]
      });
      assert.equal(context.status, 409);
      assert.equal(context.body.error.message, "This agent cannot take context from an MCP app.");

      const unknown = await h.call(`/threads/${threadId}/mcp-apps/delete`, { itemId: "tool-1" });
      assert.equal(unknown.status, 400);
      assert.equal(h.calls.length, 1);
    } finally {
      await h.stop();
    }
  });

  it("an app's answer never carries a secret the thread was handed (masked, as its rows are)", async () => {
    const secret = "S3cret-Deploy-Key-4711";
    const redactor = new SessionSecretRedactor();
    const h = await setup({
      secrets: {
        link: (threadId, parentThreadId) => redactor.link(threadId, parentThreadId),
        maskValue: (threadId, value) => redactor.maskValue(threadId, value)
      },
      answer: `deployed with ${secret}`
    });
    try {
      const threadId = await h.host.createThread();
      redactor.remember(threadId, [secret]);
      await pushActivity(h.host, threadId, {
        id: "tool-1",
        payload: {
          itemType: "mcp_tool_call",
          status: "completed",
          data: { server: "charts", tool: "show_chart", arguments: {}, mcpApp: reference }
        }
      });
      await h.host.settle();
      const answer = await h.call(agentHostExtraRoutes.mcpApp(threadId, "call-tool"), {
        itemId: "tool-1",
        name: "reset",
        arguments: {}
      });
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.body, { content: [{ type: "text", text: `deployed with ${SECRET_REDACTED_TEXT}` }] });
    } finally {
      await h.stop();
    }
  });
});
