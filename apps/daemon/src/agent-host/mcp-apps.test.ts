/**
 * The host's MCP App requests (spec 2026-10-14 §3): the app resolved from its
 * stored row (own server+tool only), every request run against THAT server
 * through the adapter's live session, the visibility rule, the bounds, and
 * the model context.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { McpAppReference, ThreadItem } from "@orquester/api/agent-chat";

import { McpAppSessionUnavailableError, type AdapterMcpApps, type AgentAdapter } from "./adapter.ts";
import { runMcpAppRequest, type McpAppRequestDeps } from "./mcp-apps.ts";
import { AgentChatCommandError } from "./orchestration/errors.ts";

const reference: McpAppReference = {
  attachmentId: "thread_1-0f8fad5b-d9cb-469f-a165-70867728950e-html",
  server: "charts",
  tool: "show_chart",
  resourceUri: "ui://charts/view"
};

const row = (data: Record<string, unknown>, overrides: Partial<ThreadItem> = {}): ThreadItem =>
  ({
    kind: "activity",
    id: "item-1",
    tone: "tool",
    activityKind: "tool.completed",
    summary: "charts: show_chart",
    payload: { itemType: "mcp_tool_call", status: "completed", data },
    turnId: "t1",
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
    ...overrides
  }) as ThreadItem;

const appRow = row({ server: "charts", tool: "show_chart", arguments: {}, mcpApp: reference });

function setup(options: { item?: ThreadItem | null; apps?: Partial<AdapterMcpApps> | null } = {}) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const contexts: Array<{ key: string; context: unknown }> = [];
  const apps: AdapterMcpApps = {
    modelContext: true,
    listTools: async (threadId, server) => {
      calls.push({ method: "listTools", input: { threadId, server } });
      return [
        { name: "show_chart", readOnly: true, title: "Show chart", meta: { ui: { visibility: ["model", "app"] } }, definition: { name: "show_chart" } },
        { name: "reset", readOnly: false, definition: { name: "reset" } },
        { name: "secret", readOnly: false, meta: { ui: { visibility: ["model"] } }, definition: { name: "secret" } }
      ];
    },
    callTool: async (threadId, input) => {
      calls.push({ method: "callTool", input: { threadId, ...input } });
      return { content: [{ type: "text", text: "ok" }], structuredContent: null, _meta: null } as never;
    },
    readResource: async (threadId, input) => {
      calls.push({ method: "readResource", input: { threadId, ...input } });
      return { contents: [{ uri: input.uri, text: "x" }] };
    },
    setModelContext: (_threadId, key, context) => contexts.push({ key, context }),
    ...options.apps
  };
  const deps: McpAppRequestDeps = {
    threadId: "thread-1",
    adapter: (options.apps === null ? {} : { mcpApps: apps }) as AgentAdapter,
    readItem: async () => (options.item === undefined ? appRow : options.item)
  };
  return { deps, calls, contexts };
}

async function refusal(work: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof AgentChatCommandError, String(error));
    return { code: error.code, message: error.message };
  }
  assert.fail("expected a refusal");
}

describe("runMcpAppRequest", () => {
  it("a row with no app, another server's app, or not a completed row is ITEM_NOT_FOUND", async () => {
    for (const item of [
      null,
      row({ server: "charts", tool: "show_chart" }),
      row({ server: "other", tool: "show_chart", mcpApp: reference }),
      row({ server: "charts", tool: "show_chart", mcpApp: reference }, { activityKind: "tool.updated" })
    ]) {
      const { deps, calls } = setup({ item });
      const answer = await refusal(runMcpAppRequest(deps, "tool-info", { itemId: "item-1", name: "show_chart" }));
      assert.equal(answer.code, "ITEM_NOT_FOUND");
      assert.equal(calls.length, 0, "nothing reaches a server");
    }
  });

  it("tool-info answers what the app's own server says", async () => {
    const { deps, calls } = setup();
    assert.deepEqual(await runMcpAppRequest(deps, "tool-info", { itemId: "item-1", name: "show_chart" }), {
      callable: true,
      readOnly: true,
      title: "Show chart",
      tool: { name: "show_chart" },
      modelContext: true
    });
    assert.deepEqual(await runMcpAppRequest(deps, "tool-info", { itemId: "item-1", name: "secret" }), {
      callable: false,
      readOnly: false,
      tool: { name: "secret" },
      modelContext: true
    });
    assert.deepEqual(await runMcpAppRequest(deps, "tool-info", { itemId: "item-1", name: "missing" }), {
      callable: false,
      readOnly: false,
      modelContext: true
    });
    assert.deepEqual(calls[0], { method: "listTools", input: { threadId: "thread-1", server: "charts" } });
  });

  it("tools/call reaches only the app's own server, and never a tool hidden from apps", async () => {
    const { deps, calls } = setup();
    // A `server` in the body is not the app's to choose.
    const result = await runMcpAppRequest(deps, "call-tool", {
      itemId: "item-1",
      name: "reset",
      arguments: { hard: true },
      server: "elsewhere"
    });
    assert.deepEqual(result, { content: [{ type: "text", text: "ok" }] });
    assert.deepEqual(calls.at(-1), {
      method: "callTool",
      input: { threadId: "thread-1", server: "charts", tool: "reset", arguments: { hard: true } }
    });
    for (const name of ["secret", "missing"]) {
      const answer = await refusal(runMcpAppRequest(deps, "call-tool", { itemId: "item-1", name, arguments: {} }));
      assert.deepEqual(answer, { code: "COMMAND_REJECTED", message: "This app cannot call that tool." });
    }
    assert.equal(calls.filter((call) => call.method === "callTool").length, 1);
  });

  it("resources/read reads from the app's own server", async () => {
    const { deps, calls } = setup();
    assert.deepEqual(await runMcpAppRequest(deps, "read-resource", { itemId: "item-1", uri: "ui://charts/data" }), {
      contents: [{ uri: "ui://charts/data", text: "x" }]
    });
    assert.deepEqual(calls.at(-1), { method: "readResource", input: { threadId: "thread-1", server: "charts", uri: "ui://charts/data" } });
  });

  it("malformed bodies are INVALID_COMMAND before anything runs", async () => {
    const { deps, calls } = setup();
    for (const [operation, body] of [
      ["tool-info", {}],
      ["tool-info", { itemId: "item-1" }],
      ["call-tool", { itemId: "item-1", name: "reset", arguments: [1] }],
      ["read-resource", { itemId: "item-1", uri: "" }],
      ["read-resource", { itemId: "item-1", uri: "x".repeat(5000) }],
      ["model-context", { itemId: "item-1", content: [{ type: "image", data: "" }] }],
      ["model-context", { itemId: "item-1", structuredContent: [1] }],
      ["model-context", { itemId: "item-1", content: [{ type: "text", text: "x".repeat(17 * 1024) }] }]
    ] as const) {
      const answer = await refusal(runMcpAppRequest(deps, operation, body));
      assert.equal(answer.code, "INVALID_COMMAND", `${operation} ${JSON.stringify(body).slice(0, 60)}`);
    }
    assert.equal(calls.filter((call) => call.method !== "listTools").length, 0);
  });

  it("model context is kept per app for the next turn, and cleared by blank text", async () => {
    const { deps, contexts } = setup();
    await runMcpAppRequest(deps, "model-context", {
      itemId: "item-1",
      content: [{ type: "text", text: "3 points" }],
      structuredContent: { points: 3 }
    });
    await runMcpAppRequest(deps, "model-context", { itemId: "item-1", content: [] });
    assert.deepEqual(contexts, [
      { key: "mcp-app:item-1", context: { server: "charts", tool: "show_chart", text: '3 points\n{"points":3}' } },
      { key: "mcp-app:item-1", context: null }
    ]);
    const grokLike = setup({ apps: { modelContext: false, setModelContext: undefined } });
    const answer = await refusal(runMcpAppRequest(grokLike.deps, "model-context", { itemId: "item-1", content: [] }));
    assert.deepEqual(answer, { code: "COMMAND_REJECTED", message: "This agent cannot take context from an MCP app." });
    assert.equal(
      ((await runMcpAppRequest(grokLike.deps, "tool-info", { itemId: "item-1", name: "show_chart" })) as { modelContext: boolean })
        .modelContext,
      false
    );
  });

  it("a stopped session, a provider failure and an adapter without MCP Apps are refusals the app can show", async () => {
    const stopped = setup({
      apps: {
        listTools: async () => {
          throw new McpAppSessionUnavailableError();
        }
      }
    });
    const answer = await refusal(runMcpAppRequest(stopped.deps, "call-tool", { itemId: "item-1", name: "reset", arguments: {} }));
    assert.equal(answer.code, "COMMAND_REJECTED");
    assert.match(answer.message, /session is not running/);

    const failing = setup({
      apps: {
        readResource: async () => {
          throw new Error("server crashed");
        }
      }
    });
    assert.deepEqual(await refusal(runMcpAppRequest(failing.deps, "read-resource", { itemId: "item-1", uri: "ui://x" })), {
      code: "COMMAND_REJECTED",
      message: "The MCP request failed: server crashed"
    });

    const none = setup({ apps: null });
    assert.deepEqual(await refusal(runMcpAppRequest(none.deps, "read-resource", { itemId: "item-1", uri: "ui://x" })), {
      code: "COMMAND_REJECTED",
      message: "This agent cannot run MCP app requests."
    });
  });
});
