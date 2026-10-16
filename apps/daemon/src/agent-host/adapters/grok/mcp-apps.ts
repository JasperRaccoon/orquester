/**
 * Grok adapter — MCP Apps (spec 2026-10-14 §3): what the CLI says about a UI
 * resource, and the client→agent extension requests that reach the thread's
 * MCP servers through the CLI's own MCP client. Pure; `session.ts` drives it.
 *
 * Evidence (Grok CLI 1.0.46, probed 2026-10-14 against a stub MCP Apps server,
 * recorded in the spec's appendix; xAI publishes no schema):
 *
 * - The CLI's MCP client always declares `extensions:
 *   {"io.modelcontextprotocol/ui": {mimeTypes: ["text/html;profile=mcp-app"]}}`
 *   to the user's servers (client name `grok-shell-apps`), whatever the ACP
 *   client declares.
 * - A completed `use_tool` call of an MCP tool ends with a `tool_call_update`
 *   whose `_meta` IS the tool definition's `_meta` (`ui.resourceUri`,
 *   `ui.visibility`) and whose `rawOutput` is `{type: "MCP", server_name,
 *   tool_name, output: {OkayOutput: text}}` — `structuredContent` folded into
 *   that text, the result's own `_meta` dropped.
 * - `_x.ai/mcp/read_resource {sessionId, server, uri}` answers
 *   `{result: {contents}}`, each content's `_meta` intact.
 * - `_x.ai/mcp/call {sessionId, server, tool, arguments}` answers
 *   `{result: {content}}` (no `structuredContent`, no `_meta`).
 * - `_x.ai/mcp/list {sessionId}` answers `{result: {servers: [{name, session:
 *   {status, tools: [{name, description, _meta, enabled}]}}]}}` — no
 *   annotations, so no tool reads as read-only here: every app call asks.
 * - Only the underscore spelling exists for these three (the bare `x.ai/…`
 *   answers -32601).
 * - `_x.ai/mcp/tools_changed {sessionId, serverName, tools}` reports a
 *   server's catalog (with each tool's `_meta`) when it connects or changes.
 */

import {
  MCP_APP_RESOURCE_SCHEME,
  SESSION_TOOLS_SERVER_NAME,
  readMcpAppResourceUri,
  type McpAppCallToolResult,
  type McpAppReference,
  type RuntimeEvent
} from "@orquester/api/agent-chat";

import type { AdapterMcpTool } from "../../adapter.ts";
import type { SessionNotification } from "./acp/_generated/schema.ts";

export const GROK_MCP_LIST_METHOD = "_x.ai/mcp/list";
export const GROK_MCP_CALL_METHOD = "_x.ai/mcp/call";
export const GROK_MCP_READ_RESOURCE_METHOD = "_x.ai/mcp/read_resource";
/**
 * Agent → client: one server's tool catalog changed (`{sessionId, serverName,
 * tools}`, seen in the 1.0.46 probe). Bare spelling: the peer registers both.
 */
export const GROK_MCP_TOOLS_CHANGED_METHOD = "x.ai/mcp/tools_changed";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 ? value : undefined;
}

/** The CLI wraps an extension request's answer in `{result: …}`; an unwrapped one reads the same. */
function unwrap(response: unknown): Record<string, unknown> {
  const record = asRecord(response) ?? {};
  return asRecord(record.result) ?? record;
}

/** The completed MCP call a `session/update` reports whose tool names a `ui://` resource. */
export interface GrokMcpAppCall {
  toolCallId: string;
  server: string;
  tool: string;
  resourceUri: string;
}

/**
 * The app a `session/update` frame names, when it is one to capture: a
 * completed `tool_call_update` of an MCP tool (`rawOutput.type === "MCP"`)
 * whose `_meta` names a `ui://` resource. The caller checks the session is
 * the parent's — a subagent's call is a row of the subagent's.
 *
 * Every MCP call reaches Grok's model through `use_tool` (fixture 32): the
 * first frames are titled `use_tool` with `rawInput.tool_name` qualified as
 * `<server>__<tool>`, and only this completed frame — whose `_meta` is the
 * tool definition's, without the `x.ai/tool` vendor block — names the server
 * and the tool apart, in `rawOutput`. Those two fields are the call's
 * identity here and on the row (`mcpCallOfActivityPayload`); the qualified
 * name is never split, as a server name may itself hold `__`. A session-tools
 * server's call (Orquester's own `orquester`, design 2026-10-14 §1) is never
 * an app: its pages are `visual` rows.
 */
export function grokMcpAppCallOf(notification: SessionNotification): GrokMcpAppCall | null {
  const update = asRecord(notification.update);
  if (update?.sessionUpdate !== "tool_call_update" || update.status !== "completed") {
    return null;
  }
  const toolCallId = asName(update.toolCallId);
  const rawOutput = asRecord(update.rawOutput);
  const resourceUri = readMcpAppResourceUri(update._meta);
  if (toolCallId === undefined || rawOutput?.type !== "MCP" || resourceUri === undefined) {
    return null;
  }
  const server = asName(rawOutput.server_name);
  const tool = asName(rawOutput.tool_name);
  if (
    server === undefined ||
    tool === undefined ||
    // Ours in a Grok chat is exactly `orquester` (its ACP entry replaces a user's same-named one,
    // probed): any other name — `orquester_session` included — is a user's server and may be an app.
    server === SESSION_TOOLS_SERVER_NAME ||
    !resourceUri.startsWith(MCP_APP_RESOURCE_SCHEME)
  ) {
    return null;
  }
  return { toolCallId, server, tool, resourceUri };
}

/** The completion of call `toolCallId` with its app (`data.mcpApp`); any other event passes through. */
export function withGrokMcpApp(toolCallId: string, mcpApp: McpAppReference): (event: RuntimeEvent) => RuntimeEvent {
  return (event) => {
    if (event.type !== "item.completed" || event.itemId !== toolCallId) {
      return event;
    }
    const data = asRecord(event.payload.data) ?? {};
    return { ...event, payload: { ...event.payload, data: { ...data, mcpApp } } } as RuntimeEvent;
  };
}

/** `_x.ai/mcp/read_resource`'s contents. */
export function grokResourceContents(response: unknown): unknown[] {
  const contents = unwrap(response).contents;
  return Array.isArray(contents) ? contents : [];
}

/** `_x.ai/mcp/call`'s answer as a `CallToolResult`. */
export function grokCallToolResult(response: unknown): McpAppCallToolResult {
  const result = unwrap(response);
  return {
    content: Array.isArray(result.content) ? result.content : [],
    ...(asRecord(result.structuredContent) !== undefined ? { structuredContent: result.structuredContent } : {}),
    ...(result.isError === true ? { isError: true } : {}),
    ...(asRecord(result._meta) !== undefined ? { _meta: result._meta } : {})
  };
}

/** One server's tools in `_x.ai/mcp/list`'s answer; an unknown server has none. */
export function grokMcpTools(response: unknown, server: string): AdapterMcpTool[] {
  const servers = unwrap(response).servers;
  if (!Array.isArray(servers)) {
    return [];
  }
  const entry = servers.map(asRecord).find((candidate) => candidate?.name === server);
  const tools = asRecord(entry?.session)?.tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools.flatMap((value) => {
    const tool = asRecord(value);
    const name = asName(tool?.name);
    if (tool === undefined || name === undefined || tool.enabled === false) {
      return [];
    }
    const annotations = asRecord(tool.annotations);
    const title = asName(tool.title) ?? asName(annotations?.title);
    return [
      {
        name,
        ...(title === undefined ? {} : { title }),
        readOnly: annotations?.readOnlyHint === true,
        ...(tool._meta === undefined ? {} : { meta: tool._meta }),
        definition: tool
      }
    ];
  });
}
