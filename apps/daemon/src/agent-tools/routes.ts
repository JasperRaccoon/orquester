/**
 * Agent tools routes (unified MCP design 2026-10-15 §9.6), both transports — remote HTTP's bearer
 * hook guards them like every `/api` route:
 *
 * - `GET /api/agent-tools` → `AgentToolsResponse` (Settings › Agent tools);
 * - `PUT /api/agent-tools/settings` `UpdateAgentToolsSettingsRequest` → `AgentToolsResponse`
 *   (409 `REVISION_MISMATCH` on a stale revision);
 * - `DELETE /api/agent-tools/grants[?threadId=]` → `RevokeAgentToolGrantsResponse` (Revoke all);
 * - `DELETE /api/agent-tools/grants/:id` → 204 (404 `GRANT_NOT_FOUND`);
 * - `GET` / `PUT agentChatRoutes.agentTools(id)` → `ThreadAgentToolsResponse` (the Tools chip).
 *
 * Every write is the user's: a request carrying an agent or external principal is refused 403
 * `PERMISSION_DENIED`. Refusals answer `{error: {code, message}}`.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { agentToolsRoutes, type AgentToolsErrorCode, type RevokeAgentToolGrantsResponse } from "@orquester/api";
import { agentChatRoutes } from "@orquester/api/agent-chat";

import { registerToolApprovalRoutes, requestPrincipal } from "../agent-chat/tool-approvals.ts";
import type { AgentToolsRuntime } from "./approval-port.ts";
import { AgentToolsError, type AgentToolsService, type AgentToolsThreadInfo } from "./service.ts";

export interface AgentToolsRouteDeps {
  tools: AgentToolsService;
  /** The chat's agent, project and workflow-owned trait, or null when it is not an open chat. */
  thread(id: string): AgentToolsThreadInfo | null;
}

function pattern(path: string): string {
  return decodeURIComponent(path);
}

function refuse(reply: FastifyReply, status: number, code: AgentToolsErrorCode | "INVALID_ARGUMENT" | "THREAD_NOT_FOUND", message: string) {
  return reply.code(status).send({ error: { code, message } });
}

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentToolsError) return refuse(reply, error.status, error.code, error.message);
  throw error;
}

const NOT_A_PERSON = "Only a person changes agent tool settings and grants.";

export function registerAgentToolsRoutes(app: FastifyInstance, deps: AgentToolsRouteDeps): void {
  app.get(agentToolsRoutes.settings, async () => deps.tools.settingsView());

  app.put(agentToolsRoutes.updateSettings, async (request, reply) => {
    if (requestPrincipal(request).kind !== "user") return refuse(reply, 403, "PERMISSION_DENIED", NOT_A_PERSON);
    try {
      return deps.tools.updateSettings(request.body);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete<{ Querystring: { threadId?: string } }>(agentToolsRoutes.grants, async (request, reply) => {
    if (requestPrincipal(request).kind !== "user") return refuse(reply, 403, "PERMISSION_DENIED", NOT_A_PERSON);
    const threadId = typeof request.query.threadId === "string" && request.query.threadId !== "" ? request.query.threadId : undefined;
    try {
      const response: RevokeAgentToolGrantsResponse = { revoked: deps.tools.revokeGrants(threadId) };
      return response;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete<{ Params: { grantId: string } }>(pattern(agentToolsRoutes.grant(":grantId")), async (request, reply) => {
    if (requestPrincipal(request).kind !== "user") return refuse(reply, 403, "PERMISSION_DENIED", NOT_A_PERSON);
    try {
      deps.tools.revokeGrant(request.params.grantId);
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>(pattern(agentChatRoutes.agentTools(":id")), async (request, reply) => {
    const info = deps.thread(request.params.id);
    if (!info) return refuse(reply, 404, "THREAD_NOT_FOUND", "No chat session with that id.");
    return deps.tools.threadView(request.params.id, info);
  });

  app.put<{ Params: { id: string } }>(pattern(agentChatRoutes.agentTools(":id")), async (request, reply) => {
    if (requestPrincipal(request).kind !== "user") return refuse(reply, 403, "PERMISSION_DENIED", NOT_A_PERSON);
    const info = deps.thread(request.params.id);
    if (!info) return refuse(reply, 404, "THREAD_NOT_FOUND", "No chat session with that id.");
    try {
      return deps.tools.updateThreadToolsets(request.params.id, request.body, info);
    } catch (error) {
      return fail(reply, error);
    }
  });
}

/** Every route of the runtime: the approval cards' and agent tools'. */
export function registerAgentToolsRuntimeRoutes(app: FastifyInstance, runtime: AgentToolsRuntime): void {
  registerToolApprovalRoutes(app, { registry: runtime.approvals, isChatSession: (id) => runtime.isChatSession(id) });
  registerAgentToolsRoutes(app, { tools: runtime.tools, thread: (id) => runtime.threadInfo(id) });
}
