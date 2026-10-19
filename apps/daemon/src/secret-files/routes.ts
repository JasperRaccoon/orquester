import type { FastifyInstance, FastifyReply } from "fastify";
import {
  secretFilesRoutes,
  type SecretFileCandidatesResponse,
  type SecretFileCompareResponse,
  type SecretVaultResponse,
  type SecretVaultsResponse
} from "@orquester/api";
import { USER_PRINCIPAL } from "@orquester/api/agent-chat";
import { type SecretFilesLogger, type SecretFilesService, SecretFilesError, actorOf, toSecretFilesError } from "./service.ts";

export interface SecretFilesRoutesDeps {
  /** The one shared service: both transports register against the same instance. */
  service: SecretFilesService;
  logger?: SecretFilesLogger;
}

type VaultQuery = { workspace?: unknown; repoKey?: unknown };

/**
 * `/api/secret-files/*` (spec 2026-10-19 §9; paths from `secretFilesRoutes`). Both transports,
 * behind the same bearer hook as every `/api` route — no `?token=` exemption. Every refusal is
 * `{ code, message }` with a {@link SecretFilesError} code and status; a message never quotes file
 * content, and an unexpected error answers a fixed message (its own is only logged, by code).
 *
 * Reads (list, vault, candidates, compare) answer while the plugin is off; every mutation answers
 * 409 `SECRET_FILES_DISABLED` then. Who pushes is `request.principal` (server-stamped): an in-chat
 * agent's version is stamped with its thread.
 */
export function registerSecretFilesRoutes(app: FastifyInstance, deps: SecretFilesRoutesDeps): void {
  const { service } = deps;
  const logger = deps.logger ?? console;
  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    const mapped = toSecretFilesError(error);
    if (!(error instanceof SecretFilesError) && mapped.code === "SECRET_FILES_ERROR") {
      logger.error(`secret-files: a request failed (${error instanceof Error ? error.name : typeof error})`);
    }
    return reply.code(mapped.status).send({ code: mapped.code, message: mapped.message });
  };

  app.get(secretFilesRoutes.list, async (_request, reply): Promise<SecretVaultsResponse | void> => {
    try {
      return await service.list();
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Querystring: VaultQuery }>(secretFilesRoutes.vault, async (request, reply): Promise<SecretVaultResponse | void> => {
    try {
      return { vault: await service.getVault(request.query.workspace, request.query.repoKey) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete<{ Querystring: VaultQuery }>(secretFilesRoutes.vault, async (request, reply) => {
    try {
      await service.deleteVault(request.query.workspace, request.query.repoKey);
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Querystring: VaultQuery & { path?: unknown } }>(
    secretFilesRoutes.candidates,
    async (request, reply): Promise<SecretFileCandidatesResponse | void> => {
      try {
        return await service.candidates(request.query);
      } catch (error) {
        return fail(reply, error);
      }
    }
  );

  app.post(secretFilesRoutes.setup, async (request, reply): Promise<SecretVaultResponse | void> => {
    try {
      return { vault: await service.setup(request.body, actorOf(request.principal ?? USER_PRINCIPAL)) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.put(secretFilesRoutes.files, async (request, reply): Promise<SecretVaultResponse | void> => {
    try {
      return { vault: await service.updateFiles(request.body, actorOf(request.principal ?? USER_PRINCIPAL)) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post(secretFilesRoutes.push, async (request, reply): Promise<SecretVaultResponse | void> => {
    try {
      return { vault: await service.push(request.body, actorOf(request.principal ?? USER_PRINCIPAL)) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post(secretFilesRoutes.reset, async (request, reply): Promise<SecretVaultResponse | void> => {
    try {
      return { vault: await service.reset(request.body, actorOf(request.principal ?? USER_PRINCIPAL)) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Querystring: VaultQuery & { projectPath?: unknown; path?: unknown } }>(
    secretFilesRoutes.compare,
    async (request, reply): Promise<SecretFileCompareResponse | void> => {
      try {
        return await service.compare(request.query);
      } catch (error) {
        return fail(reply, error);
      }
    }
  );
}
