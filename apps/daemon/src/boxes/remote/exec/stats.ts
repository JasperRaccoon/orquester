/**
 * `GET /api/boxes/:id/stats` (`boxRoutes.stats`): a connected box's CPU,
 * memory, disk and uptime (`sys.stats` from `orq-agent`), for the plugin page.
 * A user-authenticated route like the plugin's others; it reveals nothing
 * secret. 404 for an unknown box, 409 `BOX_NOT_READY` while it is away or
 * destroyed, 502 `BOX_ERROR` when the box does not answer.
 */

import type { FastifyInstance } from "fastify";

import type { BoxStats } from "@orquester/api";

import type { BoxHub, BoxRegistry } from "../../contracts.ts";

export interface BoxStatsRouteDeps {
  registry: Pick<BoxRegistry, "get">;
  hub: Pick<BoxHub, "get">;
}

/** The route's path pattern; `boxRoutes.stats(id)` builds the same path for clients. */
export const BOX_STATS_ROUTE = "/api/boxes/:id/stats";

export function registerBoxStatsRoute(app: FastifyInstance, deps: BoxStatsRouteDeps): void {
  app.get<{ Params: { id: string } }>(BOX_STATS_ROUTE, async (request, reply): Promise<BoxStats | void> => {
    const record = deps.registry.get(request.params.id);
    if (!record) return reply.code(404).send({ code: "BOX_NOT_FOUND", message: "There is no such box." });
    const connection = deps.hub.get(record.id);
    if (record.state === "destroyed" || !connection?.connected) {
      return reply.code(409).send({ code: "BOX_NOT_READY", message: "The box is not connected right now." });
    }
    try {
      return await connection.request("sys.stats", {}, { timeoutMs: 10_000 });
    } catch (error) {
      return reply.code(502).send({ code: "BOX_ERROR", message: `The box did not report its stats: ${error instanceof Error ? error.message : String(error)}` });
    }
  });
}
