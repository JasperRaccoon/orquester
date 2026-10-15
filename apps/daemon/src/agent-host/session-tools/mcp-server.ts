/**
 * Agent host — the `orquester` MCP server a thread's provider talks to (design 2026-10-14 §1.1;
 * unified MCP design 2026-10-15 §9.4). Its `tools/list` is the THREAD's current list (the manifest's
 * names over the static catalog, `definitions.ts`), read on every request, so a list that changes
 * reaches the provider as soon as it re-lists — {@link SessionToolsMcpServer.toolsChanged} sends
 * `notifications/tools/list_changed` (Claude's in-process server; the loopback endpoint builds one
 * server per request and pushes nothing). Claude gets it as the SDK's in-process server
 * (`adapters/claude/session-tools.ts`).
 *
 * The host advertises and forwards; it never runs a handler. Arguments are forwarded RAW and
 * validated by the daemon, strictly, so every provider meets the same refusal text.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import { SESSION_TOOLS_SERVER_NAME } from "@orquester/api/agent-chat";

export const SESSION_TOOLS_SERVER_VERSION = "2.0.0";

/** One call as the server hands it to the host. */
export interface SessionToolInvocation {
  name: string;
  arguments: unknown;
  /** The provider's tool-call id, when its request names one. */
  callId?: string;
  /** The JSON-RPC id of the `tools/call`, which a `notifications/cancelled` names. */
  requestId?: string | number;
  signal: AbortSignal;
}

/**
 * The provider's own tool-call id from a request's `_meta`, where it sends
 * one. Claude Code 2.1.x sends `claudecode/toolUseId` (found in the CLI's
 * strings); nothing else is relied on.
 */
export function callIdFromMeta(meta: unknown): string | undefined {
  if (meta === null || typeof meta !== "object") return undefined;
  const value = (meta as Record<string, unknown>)["claudecode/toolUseId"];
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}

/** What a server lists and accepts, read per request. */
export interface SessionToolsListSource {
  /** The tools to list now. */
  list(): readonly Tool[];
  /**
   * Whether a call by `name` is forwarded: every name the host knows (the daemon refuses a tool that
   * is off in the chat with TOOL_NOT_ENABLED, in its own words), not only the listed ones.
   */
  accepts(name: string): boolean;
}

/** The SDK's `McpServer` (what Claude's SDK config takes) with the list wired to a source. */
export interface SessionToolsMcpServer extends McpServer {
  /** Tell a connected client the list changed (`notifications/tools/list_changed`); a no-op unconnected. */
  toolsChanged(): Promise<void>;
}

export function buildSessionToolsMcpServer(
  source: SessionToolsListSource,
  invoke: (invocation: SessionToolInvocation) => Promise<CallToolResult>
): SessionToolsMcpServer {
  const server = new McpServer({ name: SESSION_TOOLS_SERVER_NAME, version: SESSION_TOOLS_SERVER_VERSION }) as SessionToolsMcpServer;
  // The low-level handlers, not `registerTool`: the list is the thread's, read per request, as the
  // static catalog serialised it (`definitions.ts`).
  server.server.registerCapabilities({ tools: { listChanged: true } });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...source.list()] }));
  // Our own tools/call: forward the RAW arguments, so the daemon's strict
  // parse is the one validator for every provider (the SDK's would strip
  // unknown keys and answer a refusal in its own words).
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!source.accepts(request.params.name)) {
      throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name.slice(0, 100)} not found`);
    }
    const callId = callIdFromMeta(request.params._meta);
    return invoke({
      name: request.params.name,
      arguments: request.params.arguments ?? {},
      ...(callId !== undefined ? { callId } : {}),
      requestId: extra.requestId,
      signal: extra.signal
    });
  });
  server.toolsChanged = async () => {
    if (!server.isConnected()) return;
    await server.server.sendToolListChanged().catch(() => undefined);
  };
  return server;
}

/**
 * The inert server a denied MCP server name is shadowed with (Grok: an ACP `mcpServers` entry of
 * the same name replaces the user's config entry — probed on 1.0.46): it lists no tools and refuses
 * every call. Holds nothing and acts as no thread.
 */
export function buildDeniedMcpServer(): McpServer {
  return buildSessionToolsMcpServer({ list: () => [], accepts: () => false }, async () => ({ content: [], isError: true }));
}
