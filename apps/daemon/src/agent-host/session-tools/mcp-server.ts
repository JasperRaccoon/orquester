/**
 * Agent host — the `orquester` MCP server a thread's provider talks to,
 * built from the registered definitions (design §1.1). The loopback endpoint
 * builds one per HTTP request (stateless); Claude gets the same tools through
 * the SDK's in-process server (`adapters/claude/session-tools.ts`).
 *
 * The host advertises and forwards; it never runs a handler. Arguments are
 * validated by the daemon, strictly, so every provider meets the same refusal
 * text — the SDK's own shape check here only shapes `tools/list`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SESSION_TOOLS_SERVER_NAME } from "@orquester/api/agent-chat";

import type { SessionToolDefinition } from "../../session-tools/contract.ts";

export const SESSION_TOOLS_SERVER_VERSION = "1.0.0";

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

/** The JSON Schema-producing input for `registerTool`: an empty shape lists as a strict empty object. */
export function advertisedInputSchema(tool: SessionToolDefinition): z.ZodRawShape | z.ZodTypeAny {
  return Object.keys(tool.input).length > 0 ? tool.input : z.object({}).strict();
}

export function buildSessionToolsMcpServer(
  tools: readonly SessionToolDefinition[],
  invoke: (invocation: SessionToolInvocation) => Promise<CallToolResult>
): McpServer {
  const server = new McpServer({ name: SESSION_TOOLS_SERVER_NAME, version: SESSION_TOOLS_SERVER_VERSION });
  const known = new Set<string>();
  for (const tool of tools) {
    known.add(tool.name);
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: advertisedInputSchema(tool) as z.ZodRawShape,
        annotations: tool.annotations
      },
      // Never invoked: the tools/call handler below replaces the SDK's.
      async () => ({ content: [] })
    );
  }
  // Our own tools/call: forward the RAW arguments, so the daemon's strict
  // parse is the one validator for every provider (the SDK's would strip
  // unknown keys and answer a refusal in its own words).
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!known.has(request.params.name)) {
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
  return server;
}
