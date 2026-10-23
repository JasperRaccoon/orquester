/**
 * The plugin's HTTP routes (`boxRoutes` in packages/api): boxes, setup logs, kinds, providers and
 * their offers, Windows images, the connection route and the Blacksmith setup. Registered on both
 * transports like the other plugin routes; the bearer hook gates the remote one. While the plugin
 * is off everything but reads and destroying a box answers 409 `BOXES_DISABLED`. Refusals are `{ code, message }` and
 * never carry a secret. (The box-authenticated `agentBinary`/`connect` routes are the hub's; the
 * config-changes routes are the sync module's.)
 */

import type { FastifyInstance, FastifyReply } from "fastify";

import {
  type BlacksmithSetupResponse,
  type BoxConnectionSettings,
  type BoxesResponse,
  type BoxKindsResponse,
  type BoxOffersResponse,
  type BoxProviderInfo,
  type BoxProvidersResponse,
  type BoxResponse,
  type SetBlacksmithSetupRequest,
  type SetBoxConnectionRequest,
  type SetBoxProviderCredentialsRequest,
  boxRoutes
} from "@orquester/api";

import { BoxError } from "./errors.ts";
import type { BoxService } from "./index.ts";

/** Answer a thrown error: a `BoxError` verbatim, an account/git error (`status`) as `ACCOUNT_ERROR`, anything else 500. */
export function sendBoxError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof BoxError) {
    return reply.code(error.status).send({ code: error.code, message: error.message, ...(error.commands ? { commands: error.commands } : {}) });
  }
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 600) {
    return reply.code(status).send({ code: "ACCOUNT_ERROR", message: error instanceof Error ? error.message : "Request failed." });
  }
  return reply.code(500).send({ code: "BOXES_ERROR", message: error instanceof Error ? error.message : "Box operation failed." });
}

export function registerBoxRoutes(app: FastifyInstance, service: BoxService): void {
  const disabled = () => new BoxError(409, "BOXES_DISABLED", "Ephemeral AI VMs is turned off in Settings → Plugins.");
  /** A route that changes something or spends money: refused while the plugin is off. */
  const guarded = <T>(run: () => Promise<T>) => async (_request: unknown, reply: FastifyReply): Promise<T | FastifyReply> => {
    try {
      if (!service.enabled()) throw disabled();
      return await run();
    } catch (error) {
      return sendBoxError(reply, error);
    }
  };
  const read = <T>(run: () => Promise<T> | T) => async (_request: unknown, reply: FastifyReply): Promise<T | FastifyReply> => {
    try {
      return await run();
    } catch (error) {
      return sendBoxError(reply, error);
    }
  };
  /** A guarded route whose work continues in the background: 202 with no body. */
  const accepted = (run: () => Promise<void>) => async (_request: unknown, reply: FastifyReply): Promise<FastifyReply> => {
    try {
      if (!service.enabled()) throw disabled();
      await run();
      return reply.code(202).send();
    } catch (error) {
      return sendBoxError(reply, error);
    }
  };
  const box = (id: string) => {
    const summary = service.registry.summary(id);
    if (!summary) throw new BoxError(404, "BOX_NOT_FOUND", "No such box.");
    return summary;
  };

  app.get(boxRoutes.list, read((): BoxesResponse => service.boxesResponse()));

  app.get(boxRoutes.kinds, guarded(async (): Promise<BoxKindsResponse> => ({ kinds: await service.settings.kinds() })));

  app.get(boxRoutes.providers, read((): BoxProvidersResponse => service.settings.providersResponse()));

  app.get(boxRoutes.connection, read((): Promise<BoxConnectionSettings> => service.settings.loadConnectionSettings()));
  app.put<{ Body: SetBoxConnectionRequest }>(boxRoutes.connection, (request, reply) =>
    guarded(() => service.settings.setConnection(request.body))(request, reply)
  );
  app.post(boxRoutes.connectionTest, guarded(() => service.settings.testConnection()));
  app.post(boxRoutes.connectionTailscaleServe, guarded(() => service.settings.setupTailscaleServe()));

  app.get(boxRoutes.blacksmith, read((): BlacksmithSetupResponse => service.settings.blacksmithResponse()));
  app.put<{ Body: SetBlacksmithSetupRequest }>(boxRoutes.blacksmith, (request, reply) =>
    guarded(() => service.settings.setBlacksmith(request.body))(request, reply)
  );
  app.post(boxRoutes.blacksmithTest, accepted(() => service.startBlacksmithTest()));

  app.get<{ Params: { id: string } }>("/api/boxes/:id", (request, reply) =>
    read((): BoxResponse => ({ box: box(request.params.id) }))(request, reply)
  );
  app.get<{ Params: { id: string } }>("/api/boxes/:id/setup-log", async (request, reply) => {
    try {
      box(request.params.id);
      const text = await service.setupLog(request.params.id);
      return reply.header("Content-Type", "text/plain; charset=utf-8").send(text);
    } catch (error) {
      return sendBoxError(reply, error);
    }
  });
  // Not guarded: a box that exists must stay destroyable while the plugin is off (it still bills).
  app.delete<{ Params: { id: string } }>("/api/boxes/:id", (request, reply) =>
    read(async (): Promise<BoxResponse> => {
      const summary = box(request.params.id);
      if (summary.purpose === "project") {
        throw new BoxError(409, "BOX_IS_PROJECT", "This box belongs to a project: delete the project to destroy it.");
      }
      return { box: await service.destroyBox(summary.id, "deleted") };
    })(request, reply)
  );

  app.put<{ Params: { id: string }; Body: SetBoxProviderCredentialsRequest }>("/api/boxes/providers/:id", (request, reply) =>
    guarded((): Promise<BoxProviderInfo> => service.settings.setCredentials(request.params.id, request.body))(request, reply)
  );
  app.delete<{ Params: { id: string } }>("/api/boxes/providers/:id", (request, reply) =>
    guarded((): Promise<BoxProviderInfo> => service.settings.deleteCredentials(request.params.id))(request, reply)
  );
  app.get<{ Params: { id: string }; Querystring: { kind?: string } }>("/api/boxes/providers/:id/offers", (request, reply) =>
    guarded((): Promise<BoxOffersResponse> => service.settings.offers(request.params.id, request.query.kind))(request, reply)
  );
  app.post<{ Params: { id: string } }>("/api/boxes/providers/:id/windows-image", (request, reply) =>
    accepted(() => service.settings.prepareWindowsImage(request.params.id))(request, reply)
  );
}
