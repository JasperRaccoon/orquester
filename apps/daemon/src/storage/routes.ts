import type { FastifyInstance, FastifyReply } from "fastify";
import {
  storageRoutes,
  type StorageErrorCode,
  type StorageScanRequest,
  type StorageStatusResponse,
  type StorageTreeResponse
} from "@orquester/api";

import { StorageError, storageErrors } from "./errors.ts";
import type { StorageScanService } from "./scan-service.ts";
import type { StorageGuardPort } from "./types.ts";

export interface StorageRoutesDeps {
  service: Pick<StorageScanService, "status" | "startScan" | "cancelScan" | "tree">;
  guard: StorageGuardPort;
}

const PATH_MAX = 4096;

function send(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof StorageError) {
    const body: { code: StorageErrorCode; message: string } = { code: error.code, message: error.message };
    return reply.code(error.status).send(body);
  }
  throw error;
}

/**
 * `GET /api/system/storage`, `POST|DELETE /api/system/storage/scan` and
 * `GET /api/system/storage/tree` (contracts in `@orquester/api` `storage.ts`).
 * Both transports; the bearer hook gates them on HTTP like every `/api` route.
 * Refusals are `{ code, message }`. Off Linux the status says
 * `supported: false` and the others answer 501 STORAGE_UNSUPPORTED.
 */
export function registerStorageRoutes(app: FastifyInstance, deps: StorageRoutesDeps): void {
  app.get(storageRoutes.status, async (): Promise<StorageStatusResponse> => deps.service.status());

  app.post<{ Body: Partial<StorageScanRequest> | undefined }>(
    storageRoutes.scan,
    async (request, reply): Promise<StorageStatusResponse | FastifyReply> => {
      try {
        const volume = request.body?.volume;
        if (typeof volume !== "string" || !volume.startsWith("/") || volume.length > PATH_MAX) {
          throw storageErrors.invalid("`volume` must be a volume's mount point.");
        }
        return await deps.service.startScan(volume);
      } catch (error) {
        return send(reply, error);
      }
    }
  );

  app.delete(storageRoutes.scan, async (_request, reply): Promise<StorageStatusResponse | FastifyReply> => {
    try {
      return await deps.service.cancelScan();
    } catch (error) {
      return send(reply, error);
    }
  });

  app.get<{ Querystring: { volume?: unknown; path?: unknown; depth?: unknown } }>(
    storageRoutes.tree,
    async (request, reply): Promise<StorageTreeResponse | FastifyReply> => {
      try {
        const { volume, path, depth } = request.query;
        if (typeof volume !== "string" || !volume.startsWith("/") || volume.length > PATH_MAX) {
          throw storageErrors.invalid("`volume` must be a volume's mount point.");
        }
        if (path !== undefined && (typeof path !== "string" || !path.startsWith("/") || path.length > PATH_MAX)) {
          throw storageErrors.invalid("`path` must be an absolute path.");
        }
        let levels: number | undefined;
        if (depth !== undefined) {
          levels = typeof depth === "string" && /^\d{1,3}$/.test(depth) ? Number(depth) : Number.NaN;
          if (Number.isNaN(levels)) throw storageErrors.invalid("`depth` must be a whole number.");
        }
        const normalized = path === undefined || path === "/" ? path : path.replace(/\/+$/, "");
        return await deps.service.tree(volume, { path: normalized, depth: levels, guard: deps.guard });
      } catch (error) {
        return send(reply, error);
      }
    }
  );
}
