/** MCP tool metadata and context budgets, measured at the interfaces the clients consume. */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { serializeChatTools } from "../../agent-host/session-tools/definitions.ts";
import { composeOrquesterInstructions, KNOWLEDGE_WORKER_INSTRUCTIONS } from "../../session-tools/instructions.ts";
import { registerMcp } from "../server.ts";
import { FakeDaemonApi } from "../testing.ts";
import { catalogFor } from "./index.ts";

const REMOVED = [
  "interrupt_session", "stop_session", "close_session", "revert_session", "compact_session", "get_session_lineage",
  "resolve_merge_back", "implement_plan", "answer_question", "dismiss_question", "resolve_approval", "get_cost", "list_files",
  "create_todo", "update_todo", "delete_todo", "toggle_todo_item", "validate_workflow", "list_workflow_runs", "get_workflow_run",
  "list_agent_profiles", "get_agent_profile_item", "create_agent_profile_item", "update_agent_profile_item",
  "set_agent_profile_item_enabled", "delete_agent_profile_item", "copy_agent_profile_item", "trust_agent_profile_hook",
  "get_agent_instructions", "write_agent_instructions", "import_agent_profile_items", "list_marketplace_plugins",
  "desktops_list", "desktop_host_status", "desktop_open", "desktop_launch_app", "desktop_windows", "desktop_window_action",
  "desktop_app_log", "desktop_stop_app", "desktop_close",
  "thread_list", "thread_read", "thread_create", "agent_catalog", "thread_send", "thread_wait", "thread_interrupt",
  "thread_fork", "thread_merge_back", "delegate_task", "task_status", "task_wait", "task_cancel"
];

/** Historical names are keys clients might still try, rather than arbitrary prose words. */
function strays(text: string, allowed: ReadonlySet<string>, known: ReadonlySet<string>): string[] {
  const tokens = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
  return [...new Set(tokens.filter((name) => known.has(name) && !allowed.has(name)))];
}

/** Schema descriptions at the JSON Schema boundary, including nested fields and union arms. */
function descriptions(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(descriptions);
  if (value === null || typeof value !== "object") return [];
  const schema = value as Record<string, unknown>;
  return [
    ...(typeof schema.description === "string" ? [schema.description] : []),
    ...Object.values(schema).flatMap(descriptions)
  ];
}

async function externalCatalog(): Promise<{ tools: Tool[]; instructions: string; version: string }> {
  const app = Fastify();
  registerMcp(app, { createApi: () => new FakeDaemonApi() });
  // light-my-request has consumed the request body; mirror IncomingMessage's destroyed flag
  // so the SDK does not arm its real-socket drain timer against the injected request.
  app.addHook("preHandler", async (request) => { (request.raw as unknown as { destroyed: boolean }).destroyed = true; });
  const request = async (method: string, params: object) => {
    const response = await app.inject({
      method: "POST", url: "/mcp",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method, params }
    });
    assert.equal(response.statusCode, 200, response.body);
    return JSON.parse(response.body).result;
  };
  try {
    const initialized = await request("initialize", {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "catalogue-contract", version: "1" }
    });
    const { tools } = await request("tools/list", {});
    return { tools, instructions: initialized.instructions, version: initialized.serverInfo.version };
  } finally {
    await app.close();
  }
}

// The family-specific trim targets belong to the same advertised-tool boundary as the catalog ceilings.
const TOOL_TARGETS: Readonly<Record<string, number>> = {
  html_preview: 1_700, html_render: 3_000, request_secret: 1_500,
  create_session: 2_900, send_message: 2_300, wait_for_session: 1_200,
  fork_session: 1_900, merge_back_session: 1_100,
  create_workflow: 6_500, update_workflow: 6_500, edit_agent_profile: 6_500
};
const CHAT_ANNOTATIONS: Readonly<Record<string, object>> = {
  html_preview: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  html_render: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  request_secret: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
};
const total = (rows: readonly Tool[]) => Buffer.byteLength(JSON.stringify(rows), "utf8");

test("tools/list and instructions preserve audience names, MCP annotations and context byte budgets", async () => {
  const external = await externalCatalog();
  const chat = await serializeChatTools(catalogFor("chat"));
  const known = new Set([...chat.map((tool) => tool.name), ...REMOVED]);
  assert.equal(external.version, "3.0.0");
  assert.ok(Buffer.byteLength(external.instructions, "utf8") <= 2_048);
  assert.deepEqual(strays(external.instructions, new Set(external.tools.map((tool) => tool.name)), known), []);
  const chatNames = new Set(chat.map((tool) => tool.name));
  for (const workflowOwned of [false, true]) {
    for (const knowledgeCollections of [[], ["SEO", "Ads"]]) {
      assert.deepEqual(strays(composeOrquesterInstructions({ workflowOwned, knowledgeCollections }), chatNames, known), []);
    }
  }
  assert.deepEqual(strays(KNOWLEDGE_WORKER_INSTRUCTIONS, chatNames, known), []);
  for (const [audience, rows] of [["external", external.tools], ["chat", chat]] as const) {
    const allowed = new Set(rows.map((tool) => tool.name));
    for (const row of rows) {
      const bytes = Buffer.byteLength(JSON.stringify(row), "utf8");
      assert.ok(bytes <= (TOOL_TARGETS[row.name] ?? 3_000), `${audience} ${row.name}: ${bytes} bytes`);
      assert.ok(Buffer.byteLength(row.description ?? "", "utf8") <= (["html_render", "html_preview"].includes(row.name) ? 2_000 : 1_000), `${audience} ${row.name}: description`);
      for (const text of [row.description ?? "", ...descriptions(row.inputSchema)]) {
        assert.deepEqual(strays(text, allowed, known), [], `${audience} ${row.name}`);
      }
      for (const text of descriptions(row.inputSchema)) {
        assert.ok(Buffer.byteLength(text, "utf8") <= 160, `${audience} ${row.name}: field description`);
      }
      if (audience === "chat" && CHAT_ANNOTATIONS[row.name]) assert.deepEqual(row.annotations, CHAT_ANNOTATIONS[row.name], row.name);
    }
  }
  assert.ok(total(external.tools) <= 81_920, `external tools/list: ${total(external.tools)} bytes`);
  const groups = new Map(catalogFor("chat").map((tool) => [tool.name, tool.toolset]));
  const boxRows = chat.filter((tool) => groups.get(tool.name) === "boxes");
  const knowledgeRows = chat.filter((tool) => groups.get(tool.name) === "knowledge");
  const workerRows = knowledgeRows.filter((tool) => tool.name.startsWith("knowledge_worker_"));
  const deviceRows = chat.filter((tool) => groups.get(tool.name) === "devices");
  const baseRows = chat.filter((tool) => !boxRows.includes(tool) && !knowledgeRows.includes(tool) && !deviceRows.includes(tool));
  const added = (rows: readonly Tool[]) => rows.reduce((sum, row) => sum + total([row]) - 1, 0);
  assert.ok(total(baseRows) <= 57_344, `chat tools/list: ${total(baseRows)} bytes`);
  assert.ok(added(boxRows) <= 6_144, `box tools: ${added(boxRows)} bytes`);
  // Six user tools since knowledge_update and knowledge_delete: the boxes family's ceiling.
  assert.ok(added(knowledgeRows.filter((tool) => !workerRows.includes(tool))) <= 6_144, "knowledge tools exceed 6 KiB");
  assert.ok(total(workerRows) <= 1_280, `worker tools/list: ${total(workerRows)} bytes`);
  assert.deepEqual(deviceRows.map((tool) => tool.name), ["list_devices", "open_device", "device_action", "device_install", "close_device"]);
  assert.ok(added(deviceRows) <= 6_144, `device tools: ${added(deviceRows)} bytes`);
});
