/**
 * chat-client — driving chat sessions from inside the daemon, the way the Orquester MCP does
 * (workflows spec §2 "Driving agents").
 *
 * The workflow engine and the MCP share ONE set of helpers, all over `DaemonApi`: every call runs a
 * daemon route in-process (`app.inject`), so every gate the GUI has — the family gate, the
 * seeded-account gate, the claudex model gate, the tab-then-thread order, `HOST_UNAVAILABLE` —
 * applies by construction, and nothing here touches a service directly (the MCP invariant, kept for
 * the engine as well).
 *
 * The helpers still live beside the MCP tools that grew them (`mcp/reads.ts`, `mcp/wait.ts`,
 * `mcp/views.ts`, `mcp/agents.ts`); this module RE-EXPORTS the very same functions — never
 * wrappers — so the two callers cannot drift (`chat-client/index.test.ts` pins the identity).
 * Import from here outside `mcp/`.
 *
 * Errors are the MCP's `ToolError {code, message}`: a daemon code passed through (`INVALID_OWNER`,
 * `HOST_UNAVAILABLE`, `COMMAND_REJECTED`, …) or `SESSION_NOT_FOUND` / `NOT_A_CHAT_SESSION`.
 */

import type { FastifyInstance } from "fastify";
import type { Broadcaster } from "../broadcaster.ts";
import type { AgentChatService } from "../agent-chat/service.ts";
import { InjectDaemonApi } from "../mcp/daemon-api.ts";

// --- the seam ---------------------------------------------------------------
export { InjectDaemonApi } from "../mcp/daemon-api.ts";
export type { DaemonApi, DaemonMethod, DaemonResponse } from "../mcp/daemon-api.ts";

// --- errors -----------------------------------------------------------------
export { ToolError, daemonError, expectOk } from "../mcp/errors.ts";

// --- reads and commands -----------------------------------------------------
export {
  findSession,
  listSessions,
  mintCommandId,
  readThread,
  requireChatSession,
  sendCommand
} from "../mcp/reads.ts";

// --- waits (Broadcaster-driven, never sleeps) -------------------------------
export { turnBaseline, turnOutcome, waitForTurn, watchSessions } from "../mcp/wait.ts";
export type { TurnBaseline, TurnOutcome, WatchOptions, WatchScope, WatchState } from "../mcp/wait.ts";

// --- what a turn said -------------------------------------------------------
export { assistantTextForTurn, lastReply, latestSettledTurn } from "../mcp/views.ts";

// --- agents, models, accounts ------------------------------------------------
export {
  EFFORT_OPTION_IDS,
  findAgent,
  findModel,
  launchesProxyModel,
  loadAgents,
  resolveModelSelection,
  validateAccountId
} from "../mcp/agents.ts";
export type {
  AgentAccountView,
  AgentModelOptionView,
  AgentModelView,
  AgentSupports,
  AgentView,
  ResolvedSelection
} from "../mcp/agents.ts";

// --- the activity ladder a summary resolves to -------------------------------
export { resolveChatActivity } from "../agent-chat/activity-ladder.ts";
export type { ChatActivityResolution, ChatActivityRung } from "../agent-chat/activity-ladder.ts";

export interface InternalDaemonApiOptions {
  /**
   * Bind to the ALWAYS-ON unix-socket app (`createServer(..., {authRequired: false, mode:
   * "local"})`). Never the HTTP app: it is hot-reloadable (a daemon config change rebuilds it), so
   * a reference to it goes stale, and it requires a bearer this client does not carry.
   */
  app: FastifyInstance;
  broadcaster: Broadcaster;
  /** For attachment uploads; `null` answers 503 `HOST_UNAVAILABLE`, as the MCP does. */
  agentChat: Pick<AgentChatService, "uploadAttachment"> | null;
  fsRoot: string;
  workspacesDir: string;
}

/**
 * The daemon's own client of itself: an `InjectDaemonApi` that sends NO authorization header.
 * It must be bound to the always-on unix-socket app (`authRequired: false`) — the HTTP app is
 * hot-reloadable and goes stale, and would answer every call 401 without a bearer anyway. The unix
 * app is built after the services, so the engine receives this late (`workflows.attachApi(api)`).
 */
export function createInternalDaemonApi(opts: InternalDaemonApiOptions): InjectDaemonApi {
  return new InjectDaemonApi({
    app: opts.app,
    authorization: undefined,
    agentChat: opts.agentChat,
    broadcaster: opts.broadcaster,
    fsRoot: opts.fsRoot,
    workspacesDir: opts.workspacesDir
  });
}
