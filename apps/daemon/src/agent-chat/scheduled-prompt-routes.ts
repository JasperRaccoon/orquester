/**
 * Scheduled prompts' routes (`agentChatRoutes.scheduledPrompts`, `scheduled-prompts.ts`): schedule,
 * cancel, send now. Daemon-owned — never proxied to the host — and answered in the §6.2 error
 * envelope, so the client's command error handling reads them as every chat route. Registered on
 * BOTH transports, inheriting their auth unchanged (bearer on HTTP, none on the unix socket).
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { agentChatRoutes, type AgentChatErrorCode, type AgentChatErrorEnvelope } from "@orquester/api/agent-chat";

import { ScheduledPromptError, type ChatScheduledPrompts } from "./scheduled-prompts.ts";

export interface ScheduledPromptRouteDeps {
  /** Null until the daemon wired the service; the routes then answer 503. */
  scheduler(): ChatScheduledPrompts | null;
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
  TURN_NOT_IDLE: 409,
  STREAM_NOT_FOUND: 404
};

function envelope(code: AgentChatErrorCode, message: string): AgentChatErrorEnvelope {
  return { error: { code, message } };
}

function refuse(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ScheduledPromptError) return reply.code(STATUS[error.code]).send(envelope(error.code, error.message));
  // Anything else may name a host path: logged, never echoed.
  console.error("[scheduled-prompts] route failed", error);
  return reply.code(409).send(envelope("COMMAND_REJECTED", "The scheduled prompt action failed."));
}

const pattern = (path: string): string => decodeURIComponent(path);

type Params = { id: string; promptId: string };

export function registerScheduledPromptRoutes(app: FastifyInstance, deps: ScheduledPromptRouteDeps): void {
  const handle = async (
    reply: FastifyReply,
    id: string,
    run: (scheduler: ChatScheduledPrompts) => Promise<unknown>
  ): Promise<unknown> => {
    if (!deps.isChatSession(id)) return reply.code(404).send(envelope("THREAD_NOT_FOUND", "No chat session with that id."));
    const scheduler = deps.scheduler();
    if (!scheduler) return reply.code(503).send(envelope("HOST_UNAVAILABLE", "The daemon is still starting. Try again in a moment."));
    try {
      return await run(scheduler);
    } catch (error) {
      return refuse(reply, error);
    }
  };

  app.post<{ Params: Pick<Params, "id">; Body: unknown }>(pattern(agentChatRoutes.scheduledPrompts(":id")), (request, reply) =>
    handle(reply, request.params.id, (scheduler) => scheduler.create(request.params.id, request.body))
  );
  app.delete<{ Params: Params }>(pattern(agentChatRoutes.scheduledPrompt(":id", ":promptId")), (request, reply) =>
    handle(reply, request.params.id, (scheduler) => scheduler.cancel(request.params.id, request.params.promptId))
  );
  app.post<{ Params: Params }>(pattern(agentChatRoutes.scheduledPromptSend(":id", ":promptId")), (request, reply) =>
    handle(reply, request.params.id, (scheduler) => scheduler.sendNow(request.params.id, request.params.promptId))
  );
}
