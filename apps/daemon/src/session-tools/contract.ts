/**
 * Session tools — the chat transport's shared types (unified MCP design 2026-10-15 §3.1, §9.4):
 * the one port a chat tool reaches besides `DaemonApi` (`request_secret`'s secret requests), the
 * per-call timeout providers are told, and the result type. The tools themselves are catalog tools
 * (`../mcp/catalog/`); this directory is the transport: route, manifest, instructions, aliases.
 *
 * Imported by both processes (the agent host reads the timeout); types and constants only.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** A request for a secret, as the asking tool states it. */
export interface SessionSecretRequestInput {
  readonly name: string;
  readonly prompt: string;
  readonly purpose?: string;
}

/** How a request ended — the value only when the user provided it. */
export type SessionSecretRequestResult =
  | { readonly outcome: "provided"; readonly value: string }
  | { readonly outcome: "declined" | "cancelled" | "timed_out" };

/**
 * The daemon's secret requests (`agent-chat/secret-requests.ts`): opens a
 * private card in `threadId` and waits for the user's answer, `signal`, or
 * the request's own deadline. The value is held in memory and handed to this
 * one waiter only.
 */
export interface SessionSecretRequests {
  request(
    threadId: string,
    input: SessionSecretRequestInput,
    signal: AbortSignal,
    delivered?: Promise<boolean>
  ): Promise<SessionSecretRequestResult>;
}

/**
 * How long a provider lets a session-tool call run before it gives up on it,
 * where the provider takes a per-server setting (Codex `tool_timeout_sec`,
 * OpenCode's registration `timeout`): a tool that waits — for the user, for
 * another thread — ends its own wait first, by its own deadline, well inside
 * this. Claude's default (~27 h) and Grok's (6 000 s) already exceed it.
 */
export const SESSION_TOOL_CALL_TIMEOUT_MS = 65 * 60 * 1000;

/** The MCP `CallToolResult` a chat call answers with — build it with `results.ts`. */
export type SessionToolResult = CallToolResult;
