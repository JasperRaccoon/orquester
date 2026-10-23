import type { FastifyInstance, FastifyReply } from "fastify";
import { type KnowledgeSettings, knowledgeRoutes } from "@orquester/api";
import { PluginsError } from "../plugins/errors.ts";
import { KnowledgeSettingsError, type KnowledgeSettingsService } from "./settings.ts";

export interface KnowledgeSettingsRoutesDeps {
  settings: Pick<KnowledgeSettingsService, "get" | "update">;
  logger?: Pick<Console, "error">;
}

/**
 * `GET` / `PUT knowledgeRoutes.settings` on both transports (the bearer hook
 * gates the remote one; nothing here is secret). Answered whether or not the
 * plugin is on, so Settings can prepare it before turning it on. `PUT` takes
 * a partial {@link KnowledgeSettings} and answers the settings as stored.
 * Refusals are `{ code, message }`: 400 `KNOWLEDGE_INVALID`, or the plugins
 * service's own (500 `PLUGINS_UNREADABLE` when plugins.json does not read; 500
 * `PLUGINS_ERROR` otherwise, as the plugin routes answer).
 */
export function registerKnowledgeSettingsRoutes(app: FastifyInstance, deps: KnowledgeSettingsRoutesDeps): void {
  const { settings } = deps;
  const logger = deps.logger ?? console;
  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof KnowledgeSettingsError || error instanceof PluginsError) {
      return reply.code(error.status).send({ code: error.code, message: error.message });
    }
    logger.error("knowledge: a settings request failed", error);
    return reply.code(500).send({ code: "PLUGINS_ERROR", message: "The knowledge settings could not be saved." });
  };

  app.get(knowledgeRoutes.settings, async (): Promise<KnowledgeSettings> => settings.get());

  app.put(knowledgeRoutes.settings, async (request, reply): Promise<KnowledgeSettings | FastifyReply> => {
    try {
      return await settings.update(request.body);
    } catch (error) {
      return fail(reply, error);
    }
  });
}
