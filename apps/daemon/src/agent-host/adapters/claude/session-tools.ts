/**
 * Claude adapter — the `orquester` session-tool server (design 2026-10-14
 * §1.2, §1.3).
 *
 * An in-process SDK server (`createSdkMcpServer`), bound to its thread when
 * the session launches: no network and no credential. SDK 0.3.278 serialises
 * `mcpServers` into `--mcp-config` argv for every server type but this one,
 * which crosses as `{type: "sdk", name}` and is served over the SDK's control
 * channel — so nothing secret could reach argv even if there were a secret.
 *
 * Pre-approved in every permission mode: `allowedTools` names each registered
 * tool (`mcp__orquester__<tool>`), so the CLI never asks, and `canUseTool`
 * short-circuits the same names should it ask anyway (`session.ts`). Each
 * tool, never the server-wide `mcp__orquester` rule: the external-MCP guide
 * (`docs/orquester-mcp.md`) installs Orquester's own full-drive `/mcp` under
 * that very name at user scope, and a server-wide rule would pre-approve
 * its tools too wherever it shadowed this one.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance
} from "@anthropic-ai/claude-agent-sdk";
import { SESSION_TOOLS_SERVER_NAME } from "@orquester/api/agent-chat";

import type { SessionToolsHost } from "../../session-tools/index.ts";
import { callIdFromMeta, SESSION_TOOLS_SERVER_VERSION } from "../../session-tools/mcp-server.ts";

const TOOL_PREFIX = `mcp__${SESSION_TOOLS_SERVER_NAME}__`;

/** A session tool as Claude names it: `mcp__orquester__<tool>`. */
export function claudeSessionToolName(name: string): string {
  return `${TOOL_PREFIX}${name}`;
}

/** True for one of `names` (bare) as Claude names it. */
export function isClaudeSessionTool(toolName: string, names: ReadonlySet<string>): boolean {
  return toolName.startsWith(TOOL_PREFIX) && names.has(toolName.slice(TOOL_PREFIX.length));
}

/** What `buildClaudeQueryOptions` attaches. */
export interface ClaudeSessionToolsLaunch {
  server: McpSdkServerConfigWithInstance;
  /** The "Orquester" instruction block, appended to the system prompt. */
  instructions: string;
  /** `allowedTools`: each registered tool by its Claude name. */
  allowedTools: string[];
}

/** The `extra` the SDK's MCP server hands a tool handler: only these fields are read. */
interface HandlerExtra {
  signal?: AbortSignal;
  _meta?: unknown;
}

/**
 * The server for one thread's session. `signal` is the session's own life: a
 * stopped session aborts every call it still has in flight, besides the
 * per-call cancel the CLI sends on an interrupt.
 */
export function createClaudeSessionToolsLaunch(input: {
  sessionTools: SessionToolsHost;
  threadId: string;
  signal: AbortSignal;
}): ClaudeSessionToolsLaunch {
  const tools = input.sessionTools.tools.map((definition) =>
    tool(
      definition.name,
      definition.description,
      definition.input,
      async (args, extra) => {
        const { signal, _meta } = (extra ?? {}) as HandlerExtra;
        const callSignal = signal === undefined ? input.signal : AbortSignal.any([signal, input.signal]);
        const callId = callIdFromMeta(_meta);
        return input.sessionTools.call({
          threadId: input.threadId,
          name: definition.name,
          arguments: args,
          ...(callId !== undefined ? { callId } : {}),
          signal: callSignal
        });
      },
      { annotations: definition.annotations }
    )
  );
  return {
    server: createSdkMcpServer({
      name: SESSION_TOOLS_SERVER_NAME,
      version: SESSION_TOOLS_SERVER_VERSION,
      tools
    }),
    instructions: input.sessionTools.instructions,
    allowedTools: input.sessionTools.tools.map((definition) => claudeSessionToolName(definition.name))
  };
}
