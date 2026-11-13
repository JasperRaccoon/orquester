import type { FastifyInstance } from "fastify";
import { selfUpdateRoutes, type SelfUpdateErrorCode, type SelfUpdateStartResponse, type SelfUpdateStatusResponse } from "@orquester/api";
import type { SelfUpdateService } from "./service.ts";

export interface SelfUpdateRoutesDeps {
  service: SelfUpdateService;
}

const REFUSALS: Record<"busy" | "unavailable", { code: SelfUpdateErrorCode; message: string }> = {
  busy: { code: "SELF_UPDATE_BUSY", message: "An update is already running." },
  unavailable: { code: "SELF_UPDATE_UNAVAILABLE", message: "This install cannot update itself; update it with ./deploy.sh deploy." }
};

/**
 * `/api/self-update` (spec 2026-11-13). Both transports, behind the same bearer hook as every
 * `/api` route. GET reports the update check and the host updater's last run; POST asks the host
 * updater to run — 202, or 409 `{ code, message }` when a run is going or pending, or this install
 * has no updater.
 */
export function registerSelfUpdateRoutes(app: FastifyInstance, deps: SelfUpdateRoutesDeps): void {
  const { service } = deps;

  app.get(selfUpdateRoutes.status, async (): Promise<SelfUpdateStatusResponse> => service.status());

  app.post(selfUpdateRoutes.status, async (_request, reply) => {
    const result = await service.requestUpdate();
    if (typeof result === "object") return reply.code(202).send(result satisfies SelfUpdateStartResponse);
    return reply.code(409).send(REFUSALS[result]);
  });
}
