import type { FastifyInstance } from "fastify";
import { selfUpdateRoutes, type SelfUpdateRefusal, type SelfUpdateStartResponse, type SelfUpdateStatusResponse } from "@orquester/api";
import type { SelfUpdateService } from "./service.ts";

export interface SelfUpdateRoutesDeps {
  service: SelfUpdateService;
}

/**
 * `/api/self-update` (spec 2026-11-13). Both transports, behind the same bearer hook as every
 * `/api` route. GET reports the update check and the host updater's last run; POST asks the host
 * updater to run — 202 `{ started, requestedAt }`, or 409 {@link SelfUpdateRefusal} when a run is going
 * or pending (with when it began, to follow it) or this install has no updater.
 */
export function registerSelfUpdateRoutes(app: FastifyInstance, deps: SelfUpdateRoutesDeps): void {
  const { service } = deps;

  app.get(selfUpdateRoutes.status, async (): Promise<SelfUpdateStatusResponse> => service.status());

  app.post(selfUpdateRoutes.status, async (_request, reply) => {
    const result = await service.requestUpdate();
    if (result === "unavailable") {
      return reply.code(409).send({
        code: "SELF_UPDATE_UNAVAILABLE",
        message: "This install cannot update itself; update it with ./deploy.sh deploy."
      } satisfies SelfUpdateRefusal);
    }
    if ("busy" in result) {
      return reply
        .code(409)
        .send({ code: "SELF_UPDATE_BUSY", message: "An update is already running.", requestedAt: result.requestedAt } satisfies SelfUpdateRefusal);
    }
    return reply.code(202).send(result satisfies SelfUpdateStartResponse);
  });
}
