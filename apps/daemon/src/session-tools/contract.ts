/**
 * Session tools — the contract every toolkit is written against (design
 * `docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md`
 * §1). How to add a toolkit: `README.md` beside this file.
 *
 * This module tree is imported statically by BOTH processes: the agent host
 * reads the definitions to advertise them (Claude's in-process server, the
 * loopback endpoint the other providers reach), and the daemon runs the
 * handlers. So a toolkit module holds definitions, instruction text and
 * handler code that reaches the daemon only through its
 * {@link SessionToolContext} — it never imports a daemon service, and nothing
 * here imports one either: whatever a toolkit imports, the agent host loads.
 */

import type { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentAdapterId } from "@orquester/api/agent-chat";

import type { DaemonApi } from "../mcp/daemon-api.ts";

/**
 * What a handler knows about its caller. Derived by the DAEMON from the
 * authenticated host request and the thread's own tab record — never from the
 * tool's arguments — so a tool can only ever act as the thread that called it.
 */
export interface SessionToolContext {
  /** The calling chat thread (= its session/tab id). */
  readonly threadId: string;
  /** The project root the thread belongs to (`<workspacesDir>/<ws>/<project>`); "" when unbound. */
  readonly projectPath: string;
  /** The thread's working directory (usually `projectPath`). */
  readonly cwd: string;
  /** The provider adapter running the thread. */
  readonly agentId: AgentAdapterId;
  /**
   * Unique per call. The provider's own tool-call id where its MCP request
   * names one (Claude: `_meta["claudecode/toolUseId"]`), else host-minted.
   */
  readonly callId: string;
  /**
   * Aborted when the provider cancels the call, the turn is interrupted, the
   * provider session ends, or the host's connection to the daemon drops.
   * Every wait MUST honour it.
   */
  readonly signal: AbortSignal;
  /**
   * The daemon's own REST API, in-process and unauthenticated (it is bound to
   * the unix-socket app, like the workflow engine's client): every gate and
   * validation the GUI meets applies here by construction.
   */
  readonly api: DaemonApi;
  /**
   * The daemon's in-memory secret requests (`request_secret`): the one port a
   * handler reaches besides `api`, because the value it returns must never
   * cross an API response. Absent where the daemon wires none (tests).
   */
  readonly secretRequests?: SessionSecretRequests;
  now(): number;
}

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
    signal: AbortSignal
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

/** MCP tool annotations (hints to the model; Orquester pre-approves every session tool, §1.3). */
export interface SessionToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** What a tool's successful result is, for readers and the README's table. */
export type SessionToolResultKind = "text" | "json" | "image";

/** The pure half of a tool: what the agent host advertises. */
export interface SessionToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  /** Bare name, `^[a-z][a-z0-9_]{0,47}$` — the harness adds its own prefix. */
  readonly name: string;
  /** Human title (MCP `title`). */
  readonly title: string;
  /**
   * The full guidance: the instruction block is short by design (§1.4), so a
   * rule the model must follow lives here. Refer to other tools by bare name.
   */
  readonly description: string;
  /** zod raw shape; unknown keys are refused at execution. */
  readonly input: Shape;
  readonly annotations: SessionToolAnnotations;
  readonly resultKind: SessionToolResultKind;
  /**
   * `structuredContent` keys whose string values are secrets handed to the
   * agent (`request_secret`'s `value`). The agent host remembers each such
   * value for the thread before it passes the result on, and masks it in
   * everything of that thread it persists (`agent-host/session-tools/
   * secret-redaction.ts`). Absent for every tool that hands out none.
   */
  readonly secretResultKeys?: readonly string[];
}

/** The MCP `CallToolResult` a handler returns — build it with `results.ts`. */
export type SessionToolResult = CallToolResult;

/** A definition plus the daemon-side handler. */
export interface SessionTool<Shape extends z.ZodRawShape = z.ZodRawShape>
  extends SessionToolDefinition<Shape> {
  /**
   * Runs in the daemon. Throw `ToolError(code, message)` (`../mcp/errors.ts`)
   * for an expected failure: it becomes an `isError` result with a safe
   * message. Anything else thrown becomes `INTERNAL` and is logged, never
   * echoed.
   */
  run(args: z.infer<z.ZodObject<Shape>>, ctx: SessionToolContext): Promise<SessionToolResult>;
}

/** One directory under `session-tools/`, listed once in `index.ts`. */
export interface SessionToolkit {
  /** Stable id, `^[a-z][a-z0-9-]*$`. */
  readonly id: string;
  /**
   * At most one short paragraph for the provider's "Orquester" instruction
   * block (§1.4). The whole block stays under
   * `SESSION_TOOL_INSTRUCTIONS_MAX_BYTES`; detail belongs in descriptions.
   */
  readonly instructions?: string;
  // `any`: each tool has its own shape; `defineSessionTool` checks each one.
  readonly tools: readonly SessionTool<any>[];
}

/** Identity helper that infers a tool's argument type from its shape. */
export function defineSessionTool<Shape extends z.ZodRawShape>(tool: SessionTool<Shape>): SessionTool<Shape> {
  return tool;
}

export function defineSessionToolkit(toolkit: SessionToolkit): SessionToolkit {
  return toolkit;
}

/** Annotation presets, as the external `/mcp` server spells them (`../mcp/tool.ts`). */
export const SESSION_TOOL_READ_ONLY: SessionToolAnnotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
export const SESSION_TOOL_MUTATING: SessionToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
export const SESSION_TOOL_DESTRUCTIVE: SessionToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
