/**
 * Agent host — the requests an MCP App makes of its own MCP server (spec
 * 2026-10-14 §3), `POST /threads/:id/mcp-apps/:operation`.
 *
 * The app is resolved from the tool call that produced it — the stored,
 * unslimmed row the client names by its activity id — so it reaches only that
 * call's server, and only once the row's reference names that very server and
 * tool (`mcpAppReferenceOfActivityPayload`). Each request runs through the
 * thread's LIVE provider session ({@link AdapterMcpApps}), whose MCP client
 * owns the connection and its credentials: a stopped session is reported,
 * never started — an app view must not start a provider.
 *
 * What stays the client's: the consent asked before a non-read-only tool call
 * or a chat message (UI behaviour, as an approval card is). What is enforced
 * here regardless of the client: the app's own server, its existence, a tool's
 * `_meta.ui.visibility` (a tool hidden from apps is refused), the body bounds.
 *
 * Ported in spirit from T3 Code (MIT): `apps/server/src/mcpApps/McpAppRequests.ts`.
 */

import {
  MCP_APP_MODEL_CONTEXT_MAX_BYTES,
  MCP_APP_OPERATIONS,
  mcpAppReferenceOfActivityPayload,
  mcpAppToolCallableByApp,
  normalizeMcpAppToolResult,
  type McpAppOperation,
  type McpAppReference,
  type McpAppToolInfoResponse,
  type ThreadItem
} from "@orquester/api/agent-chat";

import { McpAppSessionUnavailableError, type AgentAdapter } from "./adapter.ts";
import { AgentChatCommandError } from "./orchestration/errors.ts";

const MAX_ID_LENGTH = 512;
const MAX_NAME_LENGTH = 256;
const MAX_URI_LENGTH = 4096;

export interface McpAppRequestDeps {
  threadId: string;
  /** The thread's adapter, or undefined when none is registered for it. */
  adapter: AgentAdapter | undefined;
  /** The stored row, unslimmed (`GET …/items/:itemId`'s read). */
  readItem(itemId: string): Promise<ThreadItem | null>;
}

export function isMcpAppOperation(value: string): value is McpAppOperation {
  return (MCP_APP_OPERATIONS as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function invalid(message: string): AgentChatCommandError {
  return new AgentChatCommandError("INVALID_COMMAND", message);
}

function rejected(message: string): AgentChatCommandError {
  return new AgentChatCommandError("COMMAND_REJECTED", message);
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max ? value : undefined;
}

/** The app behind a completed row of this thread, or ITEM_NOT_FOUND. */
async function resolveApp(deps: McpAppRequestDeps, itemId: string): Promise<McpAppReference> {
  const item = await deps.readItem(itemId);
  const app =
    item !== null && item.kind === "activity" && item.activityKind === "tool.completed"
      ? mcpAppReferenceOfActivityPayload(item.payload)
      : undefined;
  if (app === undefined) {
    throw new AgentChatCommandError("ITEM_NOT_FOUND", "No MCP app behind that tool call.");
  }
  return app;
}

/** A provider failure as the message the app is told. */
function providerFailure(error: unknown): AgentChatCommandError {
  if (error instanceof AgentChatCommandError) {
    return error;
  }
  if (error instanceof McpAppSessionUnavailableError) {
    return rejected(error.message);
  }
  const detail = error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.";
  return rejected(`The MCP request failed: ${detail}`);
}

/** Text blocks as written and structured content as JSON, one string; only text is declared. */
function modelContextText(body: Record<string, unknown>): string {
  const texts: string[] = [];
  if (body.content !== undefined) {
    if (!Array.isArray(body.content)) {
      throw invalid("Model context needs content blocks or an object of structured content.");
    }
    for (const block of body.content) {
      const record = asRecord(block);
      if (record?.type !== "text" || typeof record.text !== "string") {
        throw invalid("Only text content blocks can inform the agent.");
      }
      texts.push(record.text);
    }
  }
  if (body.structuredContent !== undefined) {
    if (asRecord(body.structuredContent) === undefined) {
      throw invalid("Model context needs content blocks or an object of structured content.");
    }
    texts.push(JSON.stringify(body.structuredContent));
  }
  const text = texts.join("\n");
  if (new TextEncoder().encode(text).byteLength > MCP_APP_MODEL_CONTEXT_MAX_BYTES) {
    throw invalid("Model context is too large.");
  }
  return text;
}

/**
 * Run one request. `body` is the JSON the daemon forwarded: `itemId` plus
 * the operation's own fields (`packages/api` `McpApp…Request`). Throws
 * {@link AgentChatCommandError}s, which the server maps to the §6.2 envelope.
 */
export async function runMcpAppRequest(
  deps: McpAppRequestDeps,
  operation: McpAppOperation,
  body: unknown
): Promise<unknown> {
  const request = asRecord(body);
  const itemId = boundedString(request?.itemId, MAX_ID_LENGTH);
  if (request === undefined || itemId === undefined) {
    throw invalid("An MCP app request names its tool call (`itemId`).");
  }
  const app = await resolveApp(deps, itemId);
  const apps = deps.adapter?.mcpApps;
  if (apps === undefined) {
    throw rejected("This agent cannot run MCP app requests.");
  }

  switch (operation) {
    case "model-context": {
      const text = modelContextText(request);
      if (!apps.modelContext || apps.setModelContext === undefined) {
        throw rejected("This agent cannot take context from an MCP app.");
      }
      apps.setModelContext(
        deps.threadId,
        `mcp-app:${itemId}`,
        text.trim() === "" ? null : { server: app.server, tool: app.tool, text }
      );
      return {};
    }

    case "tool-info": {
      const name = boundedString(request.name, MAX_NAME_LENGTH);
      if (name === undefined) {
        throw invalid("tool-info needs a tool name.");
      }
      let tools;
      try {
        tools = await apps.listTools(deps.threadId, app.server);
      } catch (error) {
        throw providerFailure(error);
      }
      const tool = tools.find((candidate) => candidate.name === name);
      const info: McpAppToolInfoResponse = {
        callable: tool !== undefined && mcpAppToolCallableByApp(tool.meta),
        readOnly: tool?.readOnly === true,
        ...(tool?.title === undefined ? {} : { title: tool.title }),
        ...(tool === undefined ? {} : { tool: tool.definition }),
        modelContext: apps.modelContext && apps.setModelContext !== undefined
      };
      return info;
    }

    case "call-tool": {
      const name = boundedString(request.name, MAX_NAME_LENGTH);
      const args = request.arguments === undefined ? {} : asRecord(request.arguments);
      if (name === undefined || args === undefined) {
        throw invalid("tools/call needs a tool name and object arguments.");
      }
      try {
        // The spec forbids an app calling a tool hidden from apps; checked
        // here, since a client's own check is only a courtesy to its user.
        const tools = await apps.listTools(deps.threadId, app.server);
        const tool = tools.find((candidate) => candidate.name === name);
        if (tool === undefined || !mcpAppToolCallableByApp(tool.meta)) {
          throw rejected("This app cannot call that tool.");
        }
        return normalizeMcpAppToolResult(
          await apps.callTool(deps.threadId, { server: app.server, tool: name, arguments: args })
        );
      } catch (error) {
        throw providerFailure(error);
      }
    }

    case "read-resource": {
      const uri = boundedString(request.uri, MAX_URI_LENGTH);
      if (uri === undefined) {
        throw invalid("resources/read needs a uri.");
      }
      try {
        const result = await apps.readResource(deps.threadId, { server: app.server, uri });
        return { contents: Array.isArray(result.contents) ? result.contents : [] };
      } catch (error) {
        throw providerFailure(error);
      }
    }
  }
}
