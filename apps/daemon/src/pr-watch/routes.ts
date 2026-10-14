/**
 * Pull request watches — the routes (`agentChatRoutes.prWatches` / `prWatch`; contract in
 * `@orquester/api` `agent-chat/pr-watch.ts`). Both transports: the bearer hook gates HTTP, as for
 * every chat route. The `watch_pull_request` session tools call them through the daemon's
 * in-process API; the GUI lists and stops watches with them.
 */

import type { FastifyInstance, FastifyReply } from "fastify";

import {
  agentChatRoutes,
  type CreatePullRequestWatchRequest,
  type CreatePullRequestWatchResponse,
  type DeletePullRequestWatchResponse,
  type PullRequestWatchErrorEnvelope,
  type PullRequestWatchListQuery,
  type PullRequestWatchListResponse
} from "@orquester/api/agent-chat";

import { PullRequestWatchError, type PullRequestWatchService } from "./service.ts";

const pattern = (path: string): string => decodeURIComponent(path);

const UNAVAILABLE: PullRequestWatchErrorEnvelope = {
  error: { code: "UNAVAILABLE", message: "Pull request watches are starting; retry in a few seconds." }
};

function refuse(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PullRequestWatchError) {
    const body: PullRequestWatchErrorEnvelope = { error: { code: error.code, message: error.message } };
    return reply.code(error.status).send(body);
  }
  throw error;
}

function readRequest(body: unknown): CreatePullRequestWatchRequest | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { url, number, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  if (url !== undefined && typeof url !== "string") return null;
  if (number !== undefined && typeof number !== "number") return null;
  return { ...(url !== undefined ? { url } : {}), ...(number !== undefined ? { number } : {}) };
}

export function registerPullRequestWatchRoutes(app: FastifyInstance, deps: { service: () => PullRequestWatchService | null }): void {
  app.get<{ Params: { id: string }; Querystring: { url?: string; number?: string } }>(
    pattern(agentChatRoutes.prWatches(":id")),
    async (request, reply) => {
      const service = deps.service();
      if (!service) return reply.code(503).send(UNAVAILABLE);
      const { url, number } = request.query ?? {};
      try {
        if (url !== undefined || number !== undefined) {
          const parsed = number === undefined ? undefined : Number(number);
          if (parsed !== undefined && (!Number.isSafeInteger(parsed) || parsed <= 0)) {
            const invalid: PullRequestWatchErrorEnvelope = { error: { code: "INVALID_ARGUMENT", message: "number must be a positive whole number." } };
            return reply.code(400).send(invalid);
          }
          const query: PullRequestWatchListQuery = url !== undefined ? { url } : { number: parsed! };
          const body: PullRequestWatchListResponse = { watches: await service.match(request.params.id, query) };
          return body;
        }
        const body: PullRequestWatchListResponse = { watches: service.list(request.params.id) };
        return body;
      } catch (error) {
        return refuse(reply, error);
      }
    }
  );

  app.post<{ Params: { id: string } }>(pattern(agentChatRoutes.prWatches(":id")), async (request, reply) => {
    const service = deps.service();
    if (!service) return reply.code(503).send(UNAVAILABLE);
    const body = readRequest(request.body);
    if (!body) {
      const invalid: PullRequestWatchErrorEnvelope = {
        error: { code: "INVALID_ARGUMENT", message: "The body is {url} or {number}." }
      };
      return reply.code(400).send(invalid);
    }
    try {
      const created: CreatePullRequestWatchResponse = await service.create(request.params.id, body);
      return reply.code(created.created ? 201 : 200).send(created);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.delete<{ Params: { id: string; watchId: string } }>(pattern(agentChatRoutes.prWatch(":id", ":watchId")), async (request, reply) => {
    const service = deps.service();
    if (!service) return reply.code(503).send(UNAVAILABLE);
    try {
      await service.remove(request.params.id, request.params.watchId);
      const body: DeletePullRequestWatchResponse = { removed: true };
      return body;
    } catch (error) {
      return refuse(reply, error);
    }
  });
}
