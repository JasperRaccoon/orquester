/**
 * Thread lineage's routes (spec 2026-10-14 §6): fork, merge back, and the
 * lineage read. Daemon-owned — none is a proxied §6.2 command — and answered
 * in the §6.2 error envelope, so the client's command error handling and the
 * MCP's `daemonError` read them as they read every chat route.
 *
 * Registered on BOTH transports, inheriting their auth unchanged (bearer on
 * HTTP, none on the unix socket), exactly as the chat routes are; the session
 * tools of Task 6 reach them through `DaemonApi`.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  ForkSessionRequest,
  ForkSessionResponse,
  MergeBackRequest,
  MergeBackResponse,
  SessionLineageResponse
} from "@orquester/api";
import {
  AGENT_CHAT_ERROR_CODES,
  agentChatRoutes,
  type AgentChatErrorCode,
  type AgentChatErrorEnvelope
} from "@orquester/api/agent-chat";

import { LineageError, type LineageService } from "./lineage.ts";

export interface LineageRouteDeps {
  /** Null until the daemon's own API exists; the routes then answer 503. */
  lineage(): LineageService | null;
  /** The tab exists and is a chat tab. */
  isChatSession(id: string): boolean;
  /** `AgentChatService.forkSession`, with the new tab's order in the parent's project. */
  fork(parentId: string, body: ForkSessionRequest): Promise<ForkSessionResponse>;
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
  PROMPT_NOT_FOUND: 404
};

function envelope(code: AgentChatErrorCode, message: string): AgentChatErrorEnvelope {
  return { error: { code, message } };
}

/** A daemon-side refusal's code on the closed §6.2 list; anything else is a 409 rejection. */
function codeOf(error: unknown): AgentChatErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (AGENT_CHAT_ERROR_CODES as readonly string[]).includes(code)
    ? (code as AgentChatErrorCode)
    : "COMMAND_REJECTED";
}

function refuse(reply: FastifyReply, error: unknown, fallback: string): FastifyReply {
  const code = codeOf(error);
  // A thrown non-refusal can name a host path: only a refusal's own words leave.
  const known = error instanceof LineageError || (error as { name?: unknown })?.name === "ChatSessionError";
  const message = known && error instanceof Error ? error.message : fallback;
  if (!known) console.error("[lineage] route failed", error);
  return reply.code(STATUS[code]).send(envelope(code, message));
}

const pattern = (path: string): string => decodeURIComponent(path);

export function registerLineageRoutes(app: FastifyInstance, deps: LineageRouteDeps): void {
  app.post<{ Params: { id: string }; Body: ForkSessionRequest | undefined }>(
    pattern(agentChatRoutes.fork(":id")),
    async (request, reply): Promise<ForkSessionResponse | FastifyReply> => {
      const { id } = request.params;
      if (!deps.isChatSession(id)) {
        return reply.code(404).send(envelope("THREAD_NOT_FOUND", "No chat session with that id."));
      }
      try {
        return await deps.fork(id, request.body ?? {});
      } catch (error) {
        return refuse(reply, error, "Could not fork the conversation.");
      }
    }
  );

  app.post<{ Params: { id: string }; Body: MergeBackRequest | undefined }>(
    pattern(agentChatRoutes.mergeBack(":id")),
    async (request, reply): Promise<MergeBackResponse | FastifyReply> => {
      const { id } = request.params;
      const lineage = deps.lineage();
      if (!deps.isChatSession(id)) {
        return reply.code(404).send(envelope("THREAD_NOT_FOUND", "No chat session with that id."));
      }
      if (!lineage) {
        return reply.code(503).send(envelope("HOST_UNAVAILABLE", "Orquester is still starting. Try again in a moment."));
      }
      try {
        return await lineage.mergeBack(id, request.body ?? {});
      } catch (error) {
        return refuse(reply, error, "Could not merge back.");
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    pattern(agentChatRoutes.lineage(":id")),
    async (request, reply): Promise<SessionLineageResponse | FastifyReply> => {
      const { id } = request.params;
      const lineage = deps.lineage();
      if (!deps.isChatSession(id)) {
        return reply.code(404).send(envelope("THREAD_NOT_FOUND", "No chat session with that id."));
      }
      if (!lineage) {
        return reply.code(503).send(envelope("HOST_UNAVAILABLE", "Orquester is still starting. Try again in a moment."));
      }
      try {
        return lineage.view(id);
      } catch (error) {
        return refuse(reply, error, "Could not read the session's lineage.");
      }
    }
  );
}
