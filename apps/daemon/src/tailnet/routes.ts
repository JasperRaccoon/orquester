/**
 * `tailnetRoutes` (`@orquester/api` `tailnet.ts`), on both transports behind the bearer hook. The
 * daemon's HTTPS address and the operator grant are the owner's (any other principal: 403); an
 * agent principal lists, shares and stops only its own chat's previews, and its chat and project
 * come from the principal, never the body. Classified failures answer 409 `TAILNET_PROBLEM` with
 * the problem and its fix.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  tailnetRoutes,
  type CreateTailnetPreviewShareRequest,
  type TailnetHttpsStatus,
  type TailnetPreviewShareResponse,
  type TailnetPreviewSharesResponse
} from "@orquester/api";

import { TailnetError, type TailnetService } from "./service.ts";

export interface TailnetRoutesDeps {
  service: TailnetService;
}

function send(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof TailnetError) {
    return reply.code(error.status).send({ code: error.code, message: error.message, ...(error.problem ? { problem: error.problem } : {}) });
  }
  throw error;
}

const ownerOnly = (request: FastifyRequest, reply: FastifyReply): boolean => {
  if (request.principal.kind === "user") return true;
  void reply.code(403).send({ code: "PERMISSION_DENIED", message: "The tailnet address and Tailscale's operator are the owner's settings." });
  return false;
};

export function registerTailnetRoutes(app: FastifyInstance, deps: TailnetRoutesDeps): void {
  const { service } = deps;

  const owner = (run: () => Promise<TailnetHttpsStatus>) => async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ownerOnly(request, reply)) return reply;
    try {
      return reply.send(await run());
    } catch (error) {
      return send(reply, error);
    }
  };

  app.get(tailnetRoutes.https, owner(() => service.httpsStatus()));
  app.post(tailnetRoutes.https, owner(() => service.enableHttps()));
  app.delete(tailnetRoutes.https, owner(() => service.disableHttps()));
  app.post(tailnetRoutes.operator, owner(() => service.setOperator()));

  app.get(tailnetRoutes.previews, async (request, reply) => {
    const { principal } = request;
    if (principal.kind === "external") return reply.code(403).send({ code: "PERMISSION_DENIED", message: "Previews are shared by agent chats and the owner." });
    return reply.send({ previews: service.previews(principal.kind === "agent" ? principal.threadId : undefined) } satisfies TailnetPreviewSharesResponse);
  });

  app.post<{ Body: CreateTailnetPreviewShareRequest | undefined }>(tailnetRoutes.previews, async (request, reply) => {
    const { principal } = request;
    if (principal.kind === "external") return reply.code(403).send({ code: "PERMISSION_DENIED", message: "Previews are shared by agent chats and the owner." });
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;
    if (typeof body.port !== "number") return reply.code(400).send({ code: "TAILNET_INVALID_REQUEST", message: "`port` must be a number." });
    if (body.threadId !== undefined && body.threadId !== null && (typeof body.threadId !== "string" || body.threadId.length === 0)) {
      return reply.code(400).send({ code: "TAILNET_INVALID_REQUEST", message: "`threadId` must be a chat id or null." });
    }
    try {
      const preview =
        principal.kind === "agent"
          ? await service.sharePreview({ port: body.port, threadId: principal.threadId, ...(principal.projectPath ? { projectPath: principal.projectPath } : {}) })
          : await service.sharePreview({ port: body.port, threadId: typeof body.threadId === "string" ? body.threadId : null });
      return reply.send({ preview } satisfies TailnetPreviewShareResponse);
    } catch (error) {
      return send(reply, error);
    }
  });

  app.delete<{ Params: { port: string } }>(`${tailnetRoutes.previews}/:port`, async (request, reply) => {
    const { principal } = request;
    if (principal.kind === "external") return reply.code(403).send({ code: "PERMISSION_DENIED", message: "Previews are shared by agent chats and the owner." });
    const port = Number(request.params.port);
    if (!Number.isInteger(port)) return reply.code(400).send({ code: "TAILNET_INVALID_REQUEST", message: "The port must be a number." });
    try {
      const previews = await service.stopPreview(port, principal.kind === "agent" ? { threadId: principal.threadId } : {});
      return reply.send({ previews } satisfies TailnetPreviewSharesResponse);
    } catch (error) {
      return send(reply, error);
    }
  });
}
