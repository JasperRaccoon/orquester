/**
 * The temporary-box routes (`temporaryBoxRoutes`, `@orquester/api` `box-tools.ts`), on both
 * transports: thin calls into {@link TemporaryBoxTools}, which applies the ownership rule with the
 * request's server-stamped principal (`request.principal`; none = a person). The box MCP tools
 * reach them through `DaemonApi.request`, which carries the calling chat's agent principal.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { temporaryBoxRoutes, type BoxResponse, type TemporaryBoxDestroyReason, type TemporaryBoxesResponse } from "@orquester/api";

import { requestPrincipal } from "../../agent-chat/tool-approvals.ts";
import type { BoxOutcome, TemporaryBoxTools } from "./tools.ts";

/** A create carries a few short strings. */
const CREATE_BODY_LIMIT = 16 * 1024;

function send<T>(reply: FastifyReply, outcome: BoxOutcome<T>, body: (value: T) => unknown): unknown {
  if (!outcome.ok) return reply.code(outcome.status).send({ code: outcome.code, message: outcome.message });
  return body(outcome.value);
}

export function registerTemporaryBoxRoutes(app: FastifyInstance, tools: TemporaryBoxTools): void {
  const boxPattern = decodeURIComponent(temporaryBoxRoutes.box(":id"));

  app.get<{ Querystring: { threadId?: string } }>(temporaryBoxRoutes.list, async (request, reply) => {
    const threadId = typeof request.query.threadId === "string" && request.query.threadId !== "" ? request.query.threadId : undefined;
    return send(reply, tools.list(requestPrincipal(request), threadId), (boxes): TemporaryBoxesResponse => ({ boxes }));
  });

  app.post(temporaryBoxRoutes.list, { bodyLimit: CREATE_BODY_LIMIT }, async (request, reply) => {
    return send(reply, await tools.create(requestPrincipal(request), request.body), (box): BoxResponse => ({ box }));
  });

  app.get<{ Params: { id: string } }>(boxPattern, async (request, reply) => {
    return send(reply, tools.get(requestPrincipal(request), request.params.id), (box): BoxResponse => ({ box }));
  });

  app.delete<{ Params: { id: string }; Querystring: { reason?: string } }>(boxPattern, async (request, reply) => {
    const raw = request.query.reason;
    if (raw !== undefined && raw !== "agent" && raw !== "provisioning-failed") {
      return reply.code(400).send({ code: "BOX_INVALID_REQUEST", message: "reason must be agent or provisioning-failed." });
    }
    const reason: TemporaryBoxDestroyReason = raw ?? "agent";
    return send(reply, await tools.destroy(requestPrincipal(request), request.params.id, reason), (box): BoxResponse => ({ box }));
  });
}
