/**
 * Claude adapter — the `orquester` session-tool server (design 2026-10-14
 * §1.2, §1.3; unified MCP design 2026-10-15 §9.3, §9.4, §12.1).
 *
 * An in-process SDK server — `mcpServers.orquester = {type: "sdk", name,
 * instance}`, the very config `createSdkMcpServer` returns — bound to its
 * thread when the session launches: no network and no credential. SDK
 * 0.3.278 serialises `mcpServers` into `--mcp-config` argv for every server
 * type but this one, which crosses as `{type: "sdk", name}` and is served over
 * the SDK's control channel.
 *
 * The instance is the host's own `orquester` server (`../../session-tools/
 * mcp-server.ts`), not one built from the SDK's `tool()`: `tool()` zod-parses
 * the arguments first (stripping unknown keys, applying defaults), so a call
 * would reach the daemon already rewritten and be refused — or not — in
 * other words than on every other provider. This one advertises the same JSON
 * schema and forwards the arguments raw; the daemon is the one validator.
 *
 * **The list is the thread's** (its manifest), and it changes IN-SESSION: Claude Code 2.1.285
 * re-lists on `notifications/tools/list_changed` from an in-process server (Task 6 probe), so a
 * toolset turned on mid-chat reaches the model's next request ({@link ClaudeSessionToolsLaunch.names}
 * follows it, for `canUseTool`).
 *
 * Pre-approved in every permission mode: `allowedTools` names each launched
 * tool (`mcp__orquester__<tool>`), so the CLI never asks, and `canUseTool`
 * short-circuits the session's current names should it ask anyway (`session.ts`, a tool turned on
 * later included). Each tool, never the server-wide `mcp__orquester` rule.
 *
 * **Denials (§12.1).** Every MCP server the manifest names is denied twice over: `disallowedTools`
 * `mcp__<name>` (the server-level rule — probed: it removes every tool of the server from the
 * model's context) and the flag-settings `deniedMcpServers: [{serverName}]` (probed: the server is
 * never even connected, the SDK's own server untouched). A user-config server named `orquester` is
 * ALWAYS denied this way: probed, such a server and ours race, and its tools can land in our very
 * `mcp__orquester__*` namespace — where by-name pre-approval would wave them through.
 */

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { SESSION_TOOLS_SERVER_NAME } from "@orquester/api/agent-chat";

import type { SessionToolsHost } from "../../session-tools/index.ts";
import { buildSessionToolsMcpServer, type SessionToolsMcpServer } from "../../session-tools/mcp-server.ts";

const TOOL_PREFIX = `mcp__${SESSION_TOOLS_SERVER_NAME}__`;

/** A session tool as Claude names it: `mcp__orquester__<tool>`. */
export function claudeSessionToolName(name: string): string {
  return `${TOOL_PREFIX}${name}`;
}

/** True for one of `names` (bare) as Claude names it. */
export function isClaudeSessionTool(toolName: string, names: ReadonlySet<string>): boolean {
  return toolName.startsWith(TOOL_PREFIX) && names.has(toolName.slice(TOOL_PREFIX.length));
}

/** Claude's spelling of a server inside tool names (`mcp__<server>__<tool>`): unsafe characters as `_`. */
export function claudeServerRuleName(server: string): string {
  return server.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** What `buildClaudeQueryOptions` attaches. */
export interface ClaudeSessionToolsLaunch {
  server: McpSdkServerConfigWithInstance;
  /** The "Orquester" instruction block, appended to the system prompt. */
  instructions: string;
  /** `allowedTools`: each launched tool by its Claude name. */
  allowedTools: string[];
  /** The MCP servers the manifest denies in this chat (§12.1), by their config names. */
  deny: readonly string[];
  /** The bare names the session advertises NOW (an in-session refresh moves them). */
  names(): ReadonlySet<string>;
  /** The session ended: it advertises nothing any more. Idempotent. */
  release(): void;
}

/** `disallowedTools` for a launch's denials: the server-level rule of each denied server but ours. */
export function claudeDisallowedTools(deny: readonly string[]): string[] {
  return [...new Set(deny.filter((name) => name !== SESSION_TOOLS_SERVER_NAME).map((name) => `mcp__${claudeServerRuleName(name)}`))];
}

/** The flag settings' `deniedMcpServers`: every denied server, and always a user server named `orquester`. */
export function claudeDeniedMcpServers(deny: readonly string[]): { serverName: string }[] {
  return [...new Set([SESSION_TOOLS_SERVER_NAME, ...deny])].map((serverName) => ({ serverName }));
}

/**
 * The server for one thread's session. `signal` is the session's own life: a
 * stopped session aborts every call it still has in flight, besides the
 * per-call cancel the CLI sends on an interrupt.
 */
export async function createClaudeSessionToolsLaunch(input: {
  sessionTools: SessionToolsHost;
  threadId: string;
  signal: AbortSignal;
}): Promise<ClaudeSessionToolsLaunch> {
  let names: ReadonlySet<string> = new Set();
  let instance: SessionToolsMcpServer | undefined;
  const { prepared, release } = await input.sessionTools.launchInProcess(input.threadId, "claude", (next) => {
    names = next.names;
    // The CLI re-lists on the notification (probed on 2.1.285); the list is read per request.
    void instance?.toolsChanged();
  });
  names = prepared.names;
  instance = buildSessionToolsMcpServer(input.sessionTools.listSource(input.threadId), (invocation) =>
    input.sessionTools.call({
      threadId: input.threadId,
      name: invocation.name,
      arguments: invocation.arguments,
      ...(invocation.callId !== undefined ? { callId: invocation.callId } : {}),
      signal: AbortSignal.any([invocation.signal, input.signal])
    })
  );
  input.signal.addEventListener("abort", release, { once: true });
  return {
    server: { type: "sdk", name: SESSION_TOOLS_SERVER_NAME, instance },
    instructions: prepared.instructions,
    allowedTools: prepared.tools.map((tool) => claudeSessionToolName(tool.name)),
    deny: prepared.deny,
    names: () => names,
    release
  };
}
