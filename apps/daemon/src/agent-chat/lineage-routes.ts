/**
 * Thread lineage's routes (spec 2026-10-14 §6): fork, merge back, and the
 * lineage read. Daemon-owned — none is a proxied §6.2 command — and answered
 * in the §6.2 error envelope, so the client's command error handling and the
 * MCP's `daemonError` read them as they read every chat route.
 *
 * Registered on BOTH transports, inheriting their auth unchanged (bearer on
 * HTTP, none on the unix socket), exactly as the chat routes are; the session
 * tools of Task 6 reach them through `DaemonApi`.
 *
 * Unified MCP design 2026-10-15: the principal-gated lineage hints (`principal.ts`) are honoured
 * here — `ForkSessionRequest.agentCreated` and, through a hook on `POST /api/sessions`,
 * `lineage.agentCreated` reach the service only from the matching agent principal — and an agent
 * may act on merges only as itself. The reply-subscription routes (§8.3) are SOCKET-ONLY:
 * {@link registerReplySubscriptionRoutes} is called for the unix app alone.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  ForkSessionRequest,
  ForkSessionResponse,
  MergeBackActionRequest,
  MergeBackActionResponse,
  MergeBackRequest,
  MergeBackResponse,
  SessionLineageResponse
} from "@orquester/api";
import {
  AGENT_CHAT_ERROR_CODES,
  agentChatRoutes,
  isAgentPrincipalFor,
  TARGET_BUSY,
  type AgentChatErrorCode,
  type AgentChatErrorEnvelope,
  type CallerPrincipal,
  type ReplySubscriptionResponse,
  type ReplyWaitResponse
} from "@orquester/api/agent-chat";
import type { FastifyRequest } from "fastify";

import { LineageError, type LineageService } from "./lineage.ts";
import { REPLY_ERROR_STATUS, ReplyError, type ReplyRouter } from "./replies.ts";

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
  PROMPT_NOT_FOUND: 404,
  TURN_NOT_IDLE: 409,
  STREAM_NOT_FOUND: 404
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
  if (error instanceof LineageError && (error.code === "EXCHANGE_LIMIT" || error.code === TARGET_BUSY)) {
    return reply.code(409).send({ error: { code: error.code, message: error.message } });
  }
  const code = codeOf(error);
  // A thrown non-refusal can name a host path: only a refusal's own words leave.
  const known = error instanceof LineageError || (error as { name?: unknown })?.name === "ChatSessionError";
  const message = known && error instanceof Error ? error.message : fallback;
  if (!known) console.error("[lineage] route failed", error);
  return reply.code(STATUS[code]).send(envelope(code, message));
}

const pattern = (path: string): string => decodeURIComponent(path);

/**
 * The request's server-stamped principal (`principal.ts`): set by the principal hook (Task 2) on
 * both apps; a request without one — the GUI, a local client, a build before the hook — is the user.
 */
export function principalOf(request: FastifyRequest): CallerPrincipal | undefined {
  return (request as unknown as { principal?: CallerPrincipal }).principal;
}

/** An agent principal acting through a route about another session: refused (403). */
function actsAsAnother(request: FastifyRequest, sessionId: string): boolean {
  const principal = principalOf(request);
  return principal?.kind === "agent" && principal.threadId !== sessionId;
}

const NOT_AS_ANOTHER = { error: { code: "PERMISSION_DENIED", message: "A chat may act on merges only as itself." } };

/**
 * `POST /api/sessions` with `lineage.agentCreated` (PRINCIPAL-GATED, `CreateAgentChatSessionFields`):
 * the flag stays only when the principal is the agent of `lineage.parentThreadId`; from any other
 * caller — socket callers included — it is removed before the service reads the body. Mutates and
 * returns `body`.
 */
export function gateSessionCreateBody(body: unknown, principal: CallerPrincipal | undefined): unknown {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(body)) return body;
  // Both spellings the service reads (`chatFields`): top-level `lineage` and `chat.lineage`.
  for (const holder of [body, body.chat]) {
    if (!isObject(holder) || !isObject(holder.lineage) || !("agentCreated" in holder.lineage)) continue;
    const fields = holder.lineage;
    const parent = typeof fields.parentThreadId === "string" ? fields.parentThreadId : "";
    if (fields.agentCreated !== true || !isAgentPrincipalFor(principal, parent)) delete fields.agentCreated;
  }
  return body;
}

/** `ForkSessionRequest.agentCreated` (PRINCIPAL-GATED): kept only from the forked chat's own agent. */
export function gateForkBody(body: ForkSessionRequest, parentId: string, principal: CallerPrincipal | undefined): ForkSessionRequest {
  if (!("agentCreated" in body)) return body;
  if (body.agentCreated === true && isAgentPrincipalFor(principal, parentId)) return body;
  const { agentCreated: _ignored, ...rest } = body;
  return rest;
}

export function registerLineageRoutes(app: FastifyInstance, deps: LineageRouteDeps): void {
  // Before the session routes are declared (this runs first), so the hook covers them.
  app.addHook("preHandler", async (request) => {
    if (request.method === "POST" && request.routeOptions.url === "/api/sessions") {
      gateSessionCreateBody(request.body, principalOf(request));
    }
  });

  app.post<{ Params: { id: string }; Body: ForkSessionRequest | undefined }>(
    pattern(agentChatRoutes.fork(":id")),
    async (request, reply): Promise<ForkSessionResponse | FastifyReply> => {
      const { id } = request.params;
      if (!deps.isChatSession(id)) {
        return reply.code(404).send(envelope("THREAD_NOT_FOUND", "No chat session with that id."));
      }
      try {
        return await deps.fork(id, gateForkBody(request.body ?? {}, id, principalOf(request)));
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
      if (actsAsAnother(request, id)) return reply.code(403).send(NOT_AS_ANOTHER);
      try {
        return await lineage.mergeBack(id, request.body ?? {});
      } catch (error) {
        return refuse(reply, error, "Could not merge back.");
      }
    }
  );

  app.post<{ Params: { id: string; mergeId: string }; Body: MergeBackActionRequest | undefined }>(
    pattern(agentChatRoutes.mergeBackItem(":id", ":mergeId")),
    async (request, reply): Promise<MergeBackActionResponse | FastifyReply> => {
      const { id, mergeId } = request.params;
      const lineage = deps.lineage();
      // A pending merge outlives its fork's tab: the route serves any id the queue names,
      // and the service checks the merge belongs to it.
      if (!lineage) {
        return reply.code(503).send(envelope("HOST_UNAVAILABLE", "Orquester is still starting. Try again in a moment."));
      }
      // Deliver now / Discard by the receiving chat or the other one of that entry (the service
      // checks which); an agent only as itself.
      if (actsAsAnother(request, id)) return reply.code(403).send(NOT_AS_ANOTHER);
      try {
        return await lineage.actOnMerge(id, mergeId, request.body ?? ({} as MergeBackActionRequest));
      } catch (error) {
        return refuse(reply, error, "Could not act on the merge.");
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

export interface ReplySubscriptionRouteDeps {
  /** Null until the router is built; the routes then answer 503. */
  replies(): ReplyRouter | null;
  /** The tab exists and is a chat tab. */
  isChatSession(id: string): boolean;
}

function refuseReply(reply: FastifyReply, error: unknown, fallback: string): FastifyReply {
  if (error instanceof ReplyError) {
    return reply.code(REPLY_ERROR_STATUS[error.code]).send({ error: { code: error.code, message: error.message } });
  }
  console.error("[replies] route failed", error);
  return reply.code(500).send({ error: { code: "COMMAND_REJECTED", message: fallback } });
}

/**
 * The reply-subscription routes (unified MCP design 2026-10-15 §8.3) — SOCKET-ONLY: register them
 * on the unix app alone, never on the remote transport. Every field is socket-trusted; with an
 * agent principal, it must be the requester (`fromThreadId`, or the subscription's).
 */
export function registerReplySubscriptionRoutes(app: FastifyInstance, deps: ReplySubscriptionRouteDeps): void {
  app.post<{ Params: { id: string }; Body: unknown }>(
    pattern(agentChatRoutes.replySubscriptions(":id")),
    async (request, reply): Promise<ReplySubscriptionResponse | FastifyReply> => {
      const { id } = request.params;
      if (!deps.isChatSession(id)) {
        return reply.code(404).send(envelope("THREAD_NOT_FOUND", "No chat session with that id."));
      }
      const replies = deps.replies();
      if (!replies) {
        return reply.code(503).send(envelope("HOST_UNAVAILABLE", "Orquester is still starting. Try again in a moment."));
      }
      try {
        return await replies.subscribe(id, request.body, principalOf(request));
      } catch (error) {
        return refuseReply(reply, error, "Could not send the message.");
      }
    }
  );

  app.post<{ Params: { id: string; subscriptionId: string }; Body: unknown }>(
    pattern(agentChatRoutes.replySubscriptionWait(":id", ":subscriptionId")),
    async (request, reply): Promise<ReplyWaitResponse | FastifyReply> => {
      const { id, subscriptionId } = request.params;
      const replies = deps.replies();
      if (!replies) {
        return reply.code(503).send(envelope("HOST_UNAVAILABLE", "Orquester is still starting. Try again in a moment."));
      }
      // The caller going away ends the wait as its timeout would (the reply then comes as a message).
      const gone = new AbortController();
      const onClose = (): void => {
        if (!reply.raw.writableEnded) gone.abort();
      };
      reply.raw.once("close", onClose);
      try {
        return await replies.wait(id, subscriptionId, request.body, { principal: principalOf(request), signal: gone.signal });
      } catch (error) {
        return refuseReply(reply, error, "Could not wait for the reply.");
      } finally {
        reply.raw.off("close", onClose);
      }
    }
  );

  // The waiting tool call was cancelled: release its waiter (the reply then comes as a message).
  app.post<{ Params: { id: string; subscriptionId: string } }>(
    pattern(agentChatRoutes.replySubscriptionRelease(":id", ":subscriptionId")),
    async (request, reply): Promise<{ released: boolean; state: string } | FastifyReply> => {
      const { id, subscriptionId } = request.params;
      const replies = deps.replies();
      if (!replies) {
        return reply.code(503).send(envelope("HOST_UNAVAILABLE", "Orquester is still starting. Try again in a moment."));
      }
      try {
        return await replies.release(id, subscriptionId, principalOf(request));
      } catch (error) {
        return refuseReply(reply, error, "Could not release the wait.");
      }
    }
  );
}
