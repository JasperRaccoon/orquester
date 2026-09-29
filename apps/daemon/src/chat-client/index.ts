/** Shared DaemonApi helpers for workflows and MCP, preserving the daemon route gates. */

import type { FastifyInstance } from "fastify";
import type { Broadcaster } from "../broadcaster.ts";
import type { AgentChatService } from "../agent-chat/service.ts";
import { InjectDaemonApi, type LivePath } from "../mcp/daemon-api.ts";

export type { DaemonApi } from "../mcp/daemon-api.ts";
export { ToolError, expectOk } from "../mcp/errors.ts";
export { listSessions, readThread, sendCommand } from "../mcp/reads.ts";
export { turnBaseline } from "../mcp/wait.ts";
export type { TurnBaseline } from "../mcp/wait.ts";
export { assistantTextForTurn } from "../mcp/views.ts";
export {
  findAgent,
  loadAgents,
  resolveModelSelection,
  validateAccountId
} from "../mcp/agents.ts";
export type { AgentView } from "../mcp/agents.ts";
export { resolveChatActivity } from "../agent-chat/activity-ladder.ts";

interface InternalDaemonApiOptions {
  /**
   * Bind to the ALWAYS-ON unix-socket app (`createServer(..., {authRequired: false, mode:
   * "local"})`). Never the HTTP app: it is hot-reloadable (a daemon config change rebuilds it), so
   * a reference to it goes stale, and it requires a bearer this client does not carry.
   */
  app: FastifyInstance;
  broadcaster: Broadcaster;
  /** For attachment uploads; `null` answers 503 `HOST_UNAVAILABLE`, as the MCP does. */
  agentChat: Pick<AgentChatService, "uploadAttachment"> | null;
  /** Getters for a long-lived client: `PUT /api/config/daemon` moves both in place. */
  fsRoot: LivePath;
  workspacesDir: LivePath;
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
