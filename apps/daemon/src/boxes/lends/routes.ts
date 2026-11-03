/**
 * The account-lend routes (`accountLendRoutes`, `@orquester/api` `box-tools.ts`), on both transports:
 * thin calls into {@link AccountLends}, which applies the ownership rule with the request's
 * server-stamped principal (`request.principal`; none = a person). The MCP tools reach them through
 * `DaemonApi.request`, which carries the calling chat's agent principal. No route returns a token.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { accountLendRoutes } from "@orquester/api";

import { requestPrincipal } from "../../agent-chat/tool-approvals.ts";
import { AccountLendError, type AccountLends } from "./service.ts";

/** A lend carries a few short strings. */
const BODY_LIMIT = 16 * 1024;

/** `lends` is read per request: the service is built once the broker exists. */
export function registerAccountLendRoutes(app: FastifyInstance, lends: () => AccountLends | null): void {
  const box = decodeURIComponent(accountLendRoutes.box(":id"));

  async function answer(reply: FastifyReply, call: (service: AccountLends) => unknown): Promise<unknown> {
    const service = lends();
    if (!service) return reply.code(503).send({ code: "BOXES_DISABLED", message: "Lending is not available yet: the daemon is still starting." });
    try {
      return await call(service);
    } catch (error) {
      if (error instanceof AccountLendError) return reply.code(error.status).send({ code: error.code, message: error.message });
      throw error;
    }
  }

  app.get(accountLendRoutes.all, async (request, reply) => answer(reply, (service) => service.list(requestPrincipal(request))));

  app.post<{ Params: { id: string } }>(box, { bodyLimit: BODY_LIMIT }, async (request, reply) =>
    answer(reply, (service) => service.lend(requestPrincipal(request), request.params.id, request.body))
  );

  app.delete<{ Params: { id: string }; Querystring: { threadId?: string } }>(box, async (request, reply) => {
    const threadId = typeof request.query.threadId === "string" && request.query.threadId !== "" ? request.query.threadId : undefined;
    return answer(reply, (service) => service.endAll(requestPrincipal(request), request.params.id, threadId));
  });

  app.post<{ Params: { id: string } }>(decodeURIComponent(accountLendRoutes.preview(":id")), { bodyLimit: BODY_LIMIT }, async (request, reply) =>
    answer(reply, (service) => service.preview(requestPrincipal(request), request.params.id, request.body))
  );

  app.delete<{ Params: { id: string; lendId: string } }>(decodeURIComponent(accountLendRoutes.lend(":id", ":lendId")), async (request, reply) =>
    answer(reply, (service) => service.endOne(requestPrincipal(request), request.params.id, request.params.lendId))
  );
}
