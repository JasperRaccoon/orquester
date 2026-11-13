// The Storage view's guarded actions (design §4): delete, rename and download any
// scanned path on the host the service user may touch, outside the /api/fs
// sandbox. Every request is re-judged by the guard against the real filesystem
// (a symlinked parent is judged where it points), then mirrors its /api/fs
// sibling: DELETE /api/fs's side effects (closing what is rooted in the tree on
// every delete, the workspaces notice inside the workspaces root), rename's
// no-overwrite rule, download's streaming and zip.

import { constants } from "node:fs";
import { lstat, open, readlink, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  storageRoutes,
  type StorageDeleteRequest,
  type StorageDeleteResponse,
  type StorageErrorCode,
  type StorageRenameRequest,
  type StorageRenameResponse
} from "@orquester/api";

import { sendFileDownload, sendFolderZip } from "../download";
import { fsPathFromQuery } from "../fs-path-query";
import type { StorageGuard } from "./guard";
import type { StorageTreeMutations } from "./types";

export interface StorageActionRouteDeps {
  guard: StorageGuard;
  tree: StorageTreeMutations;
  /** Close the sessions, browser tabs and desktops rooted in a tree about to be deleted (DELETE /api/fs's). */
  closeTreeUsers(canonicalPath: string, rawPath: string): Promise<void>;
  /** A dir was created/renamed/deleted under `parentDir` (a realpath) — DELETE /api/fs's and rename's. */
  notifyWorkspacesChanged(parentDir: string): Promise<void>;
  /** False off Linux: every route answers 501. */
  supported: boolean;
}

export function registerStorageActionRoutes(app: FastifyInstance, deps: StorageActionRouteDeps): void {
  const { guard, tree } = deps;

  app.post(storageRoutes.delete, async (request, reply): Promise<StorageDeleteResponse | void> => {
    if (!deps.supported) return unsupported(reply);
    const body = request.body as Partial<StorageDeleteRequest> | null | undefined;
    const path = validPath(body?.path);
    if (!path || (body?.confirm !== undefined && typeof body.confirm !== "string")) {
      return fail(reply, 400, "INVALID_REQUEST", "An absolute path (and an optional confirm name) is required.");
    }
    try {
      const checked = await guard.check("delete", path);
      if (!checked.ok) return fail(reply, checked.status, checked.code, checked.message);
      const target = checked.path;
      const name = basename(target);
      if (checked.actions.confirmDelete && body?.confirm !== name) {
        return fail(reply, 400, "STORAGE_CONFIRM_MISMATCH", `Type "${name}" to confirm deleting it.`);
      }
      // Outside the workspaces root the delete needs the typed confirm. Sessions,
      // tabs and desktops can be rooted anywhere (a project symlinked to /data/proj),
      // so whatever is rooted in the tree is closed first for every delete.
      const inWorkspaces = !checked.actions.confirmDelete;
      const freedBytes = tree.sizeOf(target);
      await deps.closeTreeUsers(target, resolve(path));
      // `force: false`: a path that vanished meanwhile is an error, not a silent no-op.
      // A final symlink is removed itself, never followed (the guard judged the link).
      await rm(target, { recursive: true, force: false });
      if (inWorkspaces) await deps.notifyWorkspacesChanged(dirname(target));
      await keepTreeInStep(request.log, () => tree.applyDelete(target));
      return { ok: true, freedBytes };
    } catch (error) {
      return osError(reply, error, "Cannot delete entry.");
    }
  });

  // Same parent only (not a move), never onto an existing entry. Like
  // /api/fs/rename the leaf stays literal (renaming a symlink renames the link),
  // a case-only rename of the same inode goes through, and sessions inside a
  // renamed dir are left alone (their cwd follows the inode).
  app.post(storageRoutes.rename, async (request, reply): Promise<StorageRenameResponse | void> => {
    if (!deps.supported) return unsupported(reply);
    const body = request.body as Partial<StorageRenameRequest> | null | undefined;
    const path = validPath(body?.path);
    if (!path || typeof body?.newName !== "string" || !body.newName.trim()) {
      return fail(reply, 400, "INVALID_REQUEST", "path and newName required.");
    }
    const newName = body.newName.trim();
    if (/[\\/]/.test(newName) || newName === "." || newName === "..") {
      return fail(reply, 400, "INVALID_REQUEST", "newName must be a plain file or folder name.");
    }
    try {
      const checked = await guard.check("rename", path);
      if (!checked.ok) return fail(reply, checked.status, checked.code, checked.message);
      const source = checked.path;
      if (newName === basename(source)) return { ok: true, path: source };
      const parent = dirname(source);
      const target = join(parent, newName);
      const targetActions = guard.actionsFor(target, checked.stats.isDirectory() ? "dir" : "file");
      if (targetActions.rename) {
        return fail(reply, 403, "STORAGE_FORBIDDEN", `Can't rename it to "${newName}": ${targetActions.rename}`);
      }
      // A rename must not turn something download refuses into something it allows.
      if (checked.actions.download && !targetActions.download) {
        return fail(reply, 403, "STORAGE_FORBIDDEN", `Can't rename it to "${newName}": that would make it downloadable. ${checked.actions.download}`);
      }
      const existing = await lstat(target).catch(() => null);
      if (existing && !(existing.dev === checked.stats.dev && existing.ino === checked.stats.ino)) {
        return fail(reply, 409, "STORAGE_EXISTS", `A file or folder named "${newName}" already exists.`);
      }
      await rename(source, target);
      await deps.notifyWorkspacesChanged(parent);
      await keepTreeInStep(request.log, () => tree.applyRename(source, target));
      return { ok: true, path: target };
    } catch (error) {
      return osError(reply, error, "Cannot rename entry.");
    }
  });

  // Like /api/fs/download: a file streamed, a folder zipped on the fly (symlinks
  // inside stored as links). Also accepts ?token= (the onRequest hook) so a
  // native <a download> works. The guard judges the real target, so a symlink
  // (or a symlinked parent) into a secret is refused.
  app.get<{ Querystring: { path?: string; p?: string } }>(storageRoutes.download, async (request, reply) => {
    if (!deps.supported) return unsupported(reply);
    const path = validPath(fsPathFromQuery(request.query));
    if (!path) return fail(reply, 400, "INVALID_REQUEST", "An absolute path is required.");
    try {
      const checked = await guard.check("download", path);
      if (!checked.ok) return fail(reply, checked.status, checked.code, checked.message);
      const target = checked.path;
      const name = basename(target);
      if (checked.stats.isFile()) {
        // Open without following a link and confirm the descriptor is the file the
        // guard judged: a component swapped for a symlink since then can't
        // redirect the read.
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || (await readlink(`/proc/self/fd/${handle.fd}`)) !== target) {
            await handle.close();
            return fail(reply, 400, "STORAGE_ERROR", "The file changed while it was being opened.");
          }
          // The helper reads no more than `opened.size` bytes and none at all for an empty file.
          if (opened.size === 0) await handle.close();
          return sendFileDownload(reply, name, opened.size, (range) => handle.createReadStream(range));
        } catch (error) {
          await handle.close().catch(() => undefined);
          throw error;
        }
      }
      if (checked.stats.isDirectory()) {
        if (!sendFolderZip(request, reply, target, name)) {
          return fail(reply, 501, "STORAGE_UNSUPPORTED", "No zip tool (bsdtar/zip/7z) on the server PATH.");
        }
        return;
      }
      return fail(reply, 400, "STORAGE_ERROR", "Not a file or folder.");
    } catch (error) {
      return osError(reply, error, "Cannot read entry.");
    }
  });
}

/** An absolute path without NUL bytes, or undefined. */
function validPath(value: unknown): string | undefined {
  return typeof value === "string" && isAbsolute(value) && !value.includes("\0") ? value : undefined;
}

/**
 * The entry is already gone/renamed on disk; a saved scan that failed to follow
 * is stale until the next scan, not a failed action — so log it, don't fail.
 */
async function keepTreeInStep(log: { warn(obj: unknown, msg: string): void }, update: () => Promise<void>): Promise<void> {
  try {
    await update();
  } catch (error) {
    log.warn({ err: error }, "storage: the saved scan could not follow an action");
  }
}

function fail(reply: FastifyReply, status: number, code: StorageErrorCode, message: string): FastifyReply {
  return reply.code(status).send({ code, message });
}

function unsupported(reply: FastifyReply): FastifyReply {
  return fail(reply, 501, "STORAGE_UNSUPPORTED", "Host storage is only available on Linux.");
}

function osError(reply: FastifyReply, error: unknown, fallback: string): FastifyReply {
  return fail(reply, 400, "STORAGE_ERROR", error instanceof Error ? error.message : fallback);
}
