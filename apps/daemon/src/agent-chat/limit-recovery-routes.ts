/**
 * Usage-limit recovery's routes (`agentChatRoutes.usageLimit`, `limit-recovery.ts`): arm or
 * cancel the automatic resume, resume now, switch account and continue, dismiss the switch notice.
 * Daemon-owned — never proxied to the host — and answered in the §6.2 error envelope, so the
 * client's command error handling reads them as every chat route. Registered on BOTH transports,
 * inheriting their auth unchanged (bearer on HTTP, none on the unix socket).
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import {
  agentChatRoutes,
  type AgentChatErrorCode,
  type AgentChatErrorEnvelope,
  type UsageLimitActionResponse
} from "@orquester/api/agent-chat";

import { UsageLimitError, type ChatLimitRecovery } from "./limit-recovery.ts";

export interface UsageLimitRouteDeps {
  /** Null until the daemon wired the recovery; the routes then answer 503. */
  recovery(): ChatLimitRecovery | null;
  /** The tab exists and is a chat tab. */
  isChatSession(id: string): boolean;
}

const STATUS: Record<AgentChatErrorCode, number> = {
  INVALID_COMMAND: 400,
  THREAD_NOT_FOUND: 404,
  COMMAND_ID_CONFLICT: 409,
  COMMAND_REJECTED: 409,
  COMPACTION_UNAVAILABLE: 409,
  HOST_UNAVAILABLE: 503,
  INDEX_UNAVAILABLE: 503,
  ITEM_NOT_FOUND: 404,
  PROMPT_NOT_FOUND: 404,
  TURN_NOT_IDLE: 409
};

function envelope(code: AgentChatErrorCode, message: string): AgentChatErrorEnvelope {
  return { error: { code, message } };
}

function refuse(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof UsageLimitError) return reply.code(STATUS[error.code]).send(envelope(error.code, error.message));
  // Anything else may name a host path: logged, never echoed.
  console.error("[limit-recovery] route failed", error);
  return reply.code(409).send(envelope("COMMAND_REJECTED", "The usage-limit action failed."));
}

const pattern = (path: string): string => decodeURIComponent(path);

type Body = Record<string, unknown> | null | undefined;

export function registerUsageLimitRoutes(app: FastifyInstance, deps: UsageLimitRouteDeps): void {
  const route = (
    action: Parameters<typeof agentChatRoutes.usageLimit>[1],
    run: (recovery: ChatLimitRecovery, id: string, body: Record<string, unknown>) => Promise<UsageLimitActionResponse>
  ): void => {
    app.post<{ Params: { id: string }; Body: Body }>(pattern(agentChatRoutes.usageLimit(":id", action)), async (request, reply) => {
      const { id } = request.params;
      if (!deps.isChatSession(id)) return reply.code(404).send(envelope("THREAD_NOT_FOUND", "No chat session with that id."));
      const recovery = deps.recovery();
      if (!recovery) return reply.code(503).send(envelope("HOST_UNAVAILABLE", "The daemon is still starting. Try again in a moment."));
      const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body : {};
      try {
        return await run(recovery, id, body);
      } catch (error) {
        return refuse(reply, error);
      }
    });
  };

  route("auto-resume", (recovery, id, body) => {
    if (typeof body.armed !== "boolean") {
      return Promise.reject(new UsageLimitError("armed must be true or false.", "INVALID_COMMAND"));
    }
    return recovery.setAutoResume(id, body.armed);
  });
  route("resume", (recovery, id, body) => recovery.resumeNow(id, String(body.commandId ?? "")));
  route("switch", (recovery, id, body) => {
    if (body.accountId !== undefined && body.accountId !== null && typeof body.accountId !== "string") {
      return Promise.reject(new UsageLimitError("accountId must be a string.", "INVALID_COMMAND"));
    }
    return recovery.switchAndContinue(id, {
      commandId: String(body.commandId ?? ""),
      ...(typeof body.accountId === "string" ? { accountId: body.accountId } : {})
    });
  });
  route("dismiss-failover", (recovery, id) => recovery.dismissFailover(id));
}
