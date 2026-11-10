import type { FastifyInstance, FastifyReply } from "fastify";
import { gptImageRoutes, type GptImageSettingsResponse } from "@orquester/api";

import { PluginsError } from "../plugins/errors.ts";
import { GptImageSettingsError, type GptImageService } from "./service.ts";

export interface GptImageRoutesDeps {
  service: Pick<GptImageService, "settingsResponse" | "updateSettings">;
  logger?: Pick<Console, "error">;
}

/**
 * `GET` / `PUT gptImageRoutes.settings` on both transports (the bearer hook gates the remote one;
 * nothing here is secret: accounts are listed by id, label, email and plan, never a token). Answered
 * whether or not the plugin is on, so Settings can prepare it. `PUT` takes an
 * `UpdateGptImageSettingsRequest` and answers the new `GptImageSettingsResponse`. Refusals are
 * `{ code, message }`: 400 `GPT_IMAGE_INVALID` or `GPT_IMAGE_UNKNOWN_ACCOUNT`, the plugins service's
 * own (500 `PLUGINS_UNREADABLE`), else 500 `PLUGINS_ERROR`.
 */
export function registerGptImageRoutes(app: FastifyInstance, deps: GptImageRoutesDeps): void {
  app.register(async (scope) => {
    const logger = deps.logger ?? console;
    const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
      if (error instanceof GptImageSettingsError || error instanceof PluginsError) {
        return reply.code(error.status).send({ code: error.code, message: error.message });
      }
      logger.error("gpt-image: a settings request failed", error instanceof Error ? error.message : String(error));
      return reply.code(500).send({ code: "PLUGINS_ERROR", message: "The GPT Image settings could not be saved." });
    };
    // Fastify's own refusals (bad JSON, a body over the limit) answer in the same envelope.
    scope.setErrorHandler((error: { statusCode?: number; message?: string }, _request, reply) => {
      const status = typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
      if (status === 500) return fail(reply, error);
      return reply.code(status).send({ code: status === 413 ? "GPT_IMAGE_TOO_LARGE" : "GPT_IMAGE_INVALID", message: "The request could not be read." });
    });
    scope.get(gptImageRoutes.settings, async (): Promise<GptImageSettingsResponse> => deps.service.settingsResponse());
    scope.put(gptImageRoutes.settings, async (request, reply): Promise<GptImageSettingsResponse | FastifyReply> => {
      try {
        return await deps.service.updateSettings(request.body);
      } catch (error) {
        return fail(reply, error);
      }
    });
  });
}
