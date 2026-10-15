import type { FastifyInstance, FastifyReply } from "fastify";
import {
  type PluginId,
  type PluginInfo,
  type PluginsResponse,
  type SetPluginEnabledRequest,
  type SetPluginWorkspaceRequest,
  isPluginId,
  pluginRoutes
} from "@orquester/api";
import { isValidName } from "@orquester/config";
import { PluginsError, type PluginsService } from "./plugins-service.ts";

/** The service surface the routes use. */
export type PluginRoutesService = Pick<
  PluginsService,
  "list" | "hasWorkspace" | "setWorkspaceEnabled" | "setEnabled" | "checkNow" | "rollback" | "removeDownloads"
>;

/**
 * Settings → Plugins (spec §5.3), on both transports: the bearer hook gates the
 * remote one, and nothing here returns a secret. `:id` must be a built-in
 * plugin (404), `:workspace` a valid name (400) of an existing workspace
 * directory (404). A global plugin is switched by `PUT /:id`, a workspace one
 * by `PUT /:id/workspaces/:workspace` (the other answers 409 `PLUGIN_SCOPE`);
 * the version routes answer 409 `PLUGIN_BUNDLED` for a plugin with no updates. Refusals are `{ code, message }`. Progress of a check goes
 * out as `plugins.changed` events (a check answers 202 with no body); the other
 * mutating routes answer the plugin's `PluginInfo` as it stands. The paths are
 * `pluginRoutes`' with fastify params in place of its encoded segments.
 */
export function registerPluginRoutes(app: FastifyInstance, deps: { plugins: PluginRoutesService }): void {
  const { plugins } = deps;

  app.get(pluginRoutes.list, async (_request, reply): Promise<PluginsResponse | FastifyReply> => {
    try {
      return await plugins.list();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put<{ Params: { id: string; workspace: string }; Body: SetPluginWorkspaceRequest }>(
    `${pluginRoutes.list}/:id/workspaces/:workspace`,
    async (request, reply): Promise<PluginInfo | FastifyReply> => {
      const { id, workspace } = request.params;
      if (!isPluginId(id)) return notFound(reply, id);
      if (!isValidName(workspace)) {
        return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid workspace name." });
      }
      if (typeof request.body?.enabled !== "boolean") {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "`enabled` must be a boolean." });
      }
      try {
        if (!(await plugins.hasWorkspace(workspace))) {
          return reply.code(404).send({ code: "WORKSPACE_NOT_FOUND", message: `Workspace "${workspace}" does not exist.` });
        }
        return await plugins.setWorkspaceEnabled(id, workspace, request.body.enabled);
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.put<{ Params: { id: string }; Body: SetPluginEnabledRequest }>(
    `${pluginRoutes.list}/:id`,
    async (request, reply): Promise<PluginInfo | FastifyReply> => {
      const { id } = request.params;
      if (!isPluginId(id)) return notFound(reply, id);
      if (typeof request.body?.enabled !== "boolean") {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "`enabled` must be a boolean." });
      }
      try {
        return await plugins.setEnabled(id, request.body.enabled);
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  // 202 with no body: the check runs on the plugin's job queue, its progress goes out as events.
  app.post<{ Params: { id: string } }>(`${pluginRoutes.list}/:id/check`, async (request, reply): Promise<FastifyReply> => {
    const { id } = request.params;
    if (!isPluginId(id)) return notFound(reply, id);
    try {
      await plugins.checkNow(id);
      return reply.code(202).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  const action = (method: "POST" | "DELETE", suffix: string, run: (id: PluginId) => Promise<PluginInfo>): void => {
    app.route<{ Params: { id: string } }>({
      method,
      url: `${pluginRoutes.list}/:id/${suffix}`,
      handler: async (request, reply): Promise<PluginInfo | FastifyReply> => {
        const { id } = request.params;
        if (!isPluginId(id)) return notFound(reply, id);
        try {
          return await run(id);
        } catch (error) {
          return sendError(reply, error);
        }
      }
    });
  };
  action("POST", "rollback", (id) => plugins.rollback(id));
  action("DELETE", "downloads", (id) => plugins.removeDownloads(id));
}

function notFound(reply: FastifyReply, id: string): FastifyReply {
  return reply.code(404).send({ code: "PLUGIN_NOT_FOUND", message: `No built-in plugin "${id.slice(0, 100)}".` });
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PluginsError) {
    return reply.code(error.status).send({ code: error.code, message: error.message });
  }
  return reply.code(500).send({
    code: "PLUGINS_ERROR",
    message: error instanceof Error ? error.message : "Plugin operation failed."
  });
}
