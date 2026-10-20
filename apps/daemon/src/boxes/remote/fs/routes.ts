/**
 * The `/api/fs/*` routes for paths inside a box project (spec §8.7).
 *
 * {@link registerBoxFsRouting} installs ONE `preHandler` hook on the daemon's
 * app. For each file route it finds the request's target path, asks the
 * `BoxRegistry` where it lives, and:
 *
 * - host (no registry, the plugin off, a host project): does nothing — the
 *   route's own handler in `index.ts` runs, unchanged;
 * - a box project: answers the request here, through the box link, with the
 *   same request validation, status codes, error codes and response shapes as
 *   the host handler, and the host handler never runs;
 * - a box that is not usable: 409 `BOX_NOT_READY` / 410 `BOX_DESTROYED`.
 *
 * Containment: the box project's folder is the sandbox root. Each target is
 * realpath'd IN THE BOX (its deepest existing ancestor) and must stay inside
 * the project's folder (also realpath'd in the box); the folder itself must
 * be inside the daemon's `fsRoot` (checked on the host, where its stub is).
 * Every path in and out is a host path; Windows boxes map both ways
 * (`paths.ts`), error messages included.
 */

import { posix } from "node:path";

import { cachedAsyncBuffer } from "hyparquet";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type {
  FsCapabilitiesResponse,
  FsCreateRequest,
  FsEntry,
  FsListResponse,
  FsReadResponse,
  FsRenameRequest,
  FsUploadRequest,
  FsUploadResponse,
  FsWriteRequest
} from "@orquester/api";
import { MAX_UPLOAD_BYTES } from "@orquester/api";
import { assertInsideFsRoot, FsSandboxError } from "@orquester/config/fs";

import { fsPathFromQuery } from "../../../fs-path-query.ts";
import { ParquetRequestError, readParquetWindow } from "../../../parquet.ts";
import { FsSearchError } from "../../../search.ts";
import {
  UploadTooLargeError,
  cappedUploadBody,
  declaredLengthExceedsCap,
  isUploadTooLarge,
  refuseUpload,
  uploadTempPath
} from "../../../upload-stream.ts";
import type { BoxRegistry } from "../../contracts.ts";
import { archiveToolOf, listBoxArchiveEntries, spawnBoxDirZip, zipToolOf } from "./archive.ts";
import { BoxFsUnavailableError, errnoOf, fsError } from "./errors.ts";
import { boxTools } from "./exec.ts";
import { locateProjectFs, type BoxProjectFs } from "./project-fs.ts";
import { listBoxProjectFiles, searchBoxProjectFiles } from "./search.ts";

export interface BoxFsRoutingDeps {
  /** The registry, read per request (absent while the plugin is off: everything is host). */
  boxes: () => BoxRegistry | undefined;
  /** The daemon's file sandbox root, read per request (it follows `PUT /api/config/daemon`). */
  fsRoot: () => string;
  /** `/api/fs/raw`'s in-memory cap (the host route's own). */
  rawMaxBytes: number;
  /**
   * Close the sessions, browser tabs and desktops rooted at a deleted tree, as
   * `DELETE /api/fs` does on the host: `safe` is the checked path, `raw` the
   * request's own (resolved) spelling.
   */
  closeUnder: (safe: string, raw: string) => Promise<void>;
}

interface RouteContext {
  request: FastifyRequest;
  reply: FastifyReply;
  fs: BoxProjectFs;
  projectRoot: string;
  /** Contain a target path (see the module doc); answers its host form. */
  contain: (target: string) => Promise<string>;
}

interface BoxRoute {
  /** The path that decides where the request goes; undefined = let the host handler answer (its 400). */
  target(request: FastifyRequest): string | undefined;
  serve(context: RouteContext): Promise<void>;
  /** How a refusal is sent (uploads close the connection: their body may be unread). */
  upload?: true;
}

type Query = Record<string, string | undefined>;

const queryOf = (request: FastifyRequest): Query => (request.query ?? {}) as Query;
const bodyOf = <T>(request: FastifyRequest): Partial<T> => (request.body ?? {}) as Partial<T>;
const queryPath = (request: FastifyRequest): string | undefined =>
  fsPathFromQuery(queryOf(request) as { path?: string; p?: string });

/** Same as `index.ts`: an `attachment` disposition with an ASCII fallback and the RFC 5987 UTF-8 name. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** A box error message with box paths spelled as host paths (Windows boxes). */
function hostMessage(fs: BoxProjectFs, message: string): string {
  const map = fs.connection.paths;
  if (map.kind !== "windows-prefix") return message;
  const prefix = map.prefix.replace(/[\\/]+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return message.replace(new RegExp(`${prefix}(?:[\\\\/][^'"\\s,]*)?`, "gi"), (boxPath) => fs.paths.toHost(boxPath) ?? boxPath);
}

function sendError(reply: FastifyReply, error: unknown, fallback: string, fs?: BoxProjectFs): FastifyReply {
  if (error instanceof BoxFsUnavailableError) {
    return reply.code(error.status).send({ code: error.code, message: error.message });
  }
  if (error instanceof FsSandboxError) {
    return reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
  }
  if (error instanceof FsSearchError) {
    return reply.code(error.status).send({ code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) });
  }
  const message = error instanceof Error ? error.message : fallback;
  return reply.code(400).send({ code: "FS_ERROR", message: fs ? hostMessage(fs, message) : message });
}

/** A request whose client went away: nobody reads an answer; drop the socket. */
function abandon(reply: FastifyReply): void {
  reply.hijack();
  reply.raw.destroy();
}

/** An abort controller tied to the client closing the response (as the host search routes do). */
function abortOnClose(reply: FastifyReply): { signal: AbortSignal; release: () => void } {
  const abort = new AbortController();
  const onClose = (): void => abort.abort();
  reply.raw.on("close", onClose);
  return { signal: abort.signal, release: () => reply.raw.off("close", onClose) };
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

function routes(deps: BoxFsRoutingDeps): Record<string, BoxRoute> {
  return {
    // File browser: list a directory.
    "GET /api/fs": {
      target: queryPath,
      async serve({ request, reply, fs, contain }) {
        try {
          const safe = await contain(queryPath(request)!);
          const listed = await fs.readdir(safe);
          const entries: FsEntry[] = await Promise.all(
            listed.map(async (entry) => {
              const full = posix.join(safe, entry.name);
              const kind = entry.kind === "dir" ? "dir" : "file";
              let size = entry.kind === "file" ? entry.size : 0;
              // The host stats (follows) each non-directory: a symlink shows its target's size.
              if (entry.kind === "symlink" || entry.kind === "other") {
                size = (await fs.stat(full).catch(() => null))?.size ?? 0;
              }
              return { name: entry.name, path: full, kind, size };
            })
          );
          entries.sort((a, b) => (a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
          const parent = posix.dirname(safe);
          const response: FsListResponse = { path: safe, parent: parent === safe ? null : parent, entries };
          await reply.send(response);
        } catch (error) {
          await sendError(reply, error, "Cannot read directory.", fs);
        }
      }
    },

    // File browser: recursive file listing for quick-open (run in the box).
    "GET /api/fs/files": {
      target: queryPath,
      async serve({ request, reply, fs, contain }) {
        const { signal, release } = abortOnClose(reply);
        try {
          const safe = await contain(queryPath(request)!);
          await reply.send(await listBoxProjectFiles(fs, safe, { includeIgnored: queryOf(request).includeIgnored === "1", signal }));
        } catch (error) {
          if (signal.aborted) return abandon(reply);
          await sendError(reply, error, "Cannot list project files.", fs);
        } finally {
          release();
        }
      }
    },

    // File browser: content search across a project subtree (ripgrep in the box).
    "GET /api/fs/search": {
      target: (request) => (queryOf(request).q ? queryPath(request) : undefined),
      async serve({ request, reply, fs, contain }) {
        const query = queryOf(request);
        const { signal, release } = abortOnClose(reply);
        try {
          const safe = await contain(queryPath(request)!);
          // `engine` is never read from the query, as on the host.
          await reply.send(
            await searchBoxProjectFiles(fs, safe, {
              query: query.q!,
              caseSensitive: query.caseSensitive === "1",
              wholeWord: query.wholeWord === "1",
              regex: query.regex === "1",
              include: query.include,
              exclude: query.exclude,
              maxResults: query.maxResults,
              includeIgnored: query.includeIgnored === "1",
              signal
            })
          );
        } catch (error) {
          if (signal.aborted) return abandon(reply);
          await sendError(reply, error, "Cannot search files.", fs);
        } finally {
          release();
        }
      }
    },

    // Read a file's text content (capped at 1 MB).
    "GET /api/fs/read": {
      target: queryPath,
      async serve({ request, reply, fs, contain }) {
        try {
          const safe = await contain(queryPath(request)!);
          const info = await fs.stat(safe);
          if (!info) throw fsError("ENOENT", `no such file or directory, open '${safe}'`);
          if (info.kind === "dir") throw fsError("EISDIR", "illegal operation on a directory, read");
          const cap = 1024 * 1024;
          const buffer = await fs.read(safe, { length: cap });
          const size = Math.max(info.size, buffer.length);
          const response: FsReadResponse = {
            path: safe,
            content: buffer.subarray(0, cap).toString("utf8"),
            size,
            truncated: size > cap
          };
          await reply.send(response);
        } catch (error) {
          await sendError(reply, error, "Cannot read file.", fs);
        }
      }
    },

    // Read a file's RAW bytes for the preview viewers (capped like the host route).
    "GET /api/fs/raw": {
      target: queryPath,
      async serve({ request, reply, fs, contain }) {
        try {
          const safe = await contain(queryPath(request)!);
          const info = await fs.stat(safe);
          if (!info) throw fsError("ENOENT", `no such file or directory, stat '${safe}'`);
          if (info.kind !== "file") {
            await reply.code(400).send({ code: "FS_ERROR", message: "Not a file." });
            return;
          }
          if (info.size > deps.rawMaxBytes) {
            await reply.code(413).send({
              code: "FS_TOO_LARGE",
              message: `File exceeds the ${Math.floor(deps.rawMaxBytes / (1024 * 1024))} MB preview limit.`
            });
            return;
          }
          // One byte past the cap: a file that grew since the stat is refused, never cut.
          const buffer = await fs.read(safe, { length: deps.rawMaxBytes + 1 });
          if (buffer.length > deps.rawMaxBytes) {
            await reply.code(413).send({
              code: "FS_TOO_LARGE",
              message: `File exceeds the ${Math.floor(deps.rawMaxBytes / (1024 * 1024))} MB preview limit.`
            });
            return;
          }
          await reply.header("X-Content-Type-Options", "nosniff").type("application/octet-stream").send(buffer);
        } catch (error) {
          await sendError(reply, error, "Cannot read file.", fs);
        }
      }
    },

    // List an archive's contents (7z/bsdtar in the box).
    "GET /api/fs/archive": {
      target: queryPath,
      async serve({ request, reply, fs, contain }) {
        try {
          const safe = await contain(queryPath(request)!);
          await reply.send(await listBoxArchiveEntries(fs, safe));
        } catch (error) {
          await sendError(reply, error, "Cannot read archive.", fs);
        }
      }
    },

    // A parquet file's schema + a window of rows: ranged reads over the link, never the whole file.
    "GET /api/fs/parquet": {
      target: queryPath,
      async serve({ request, reply, fs, contain }) {
        const { offset, limit, orderBy, desc } = queryOf(request);
        try {
          const safe = await contain(queryPath(request)!);
          const info = await fs.stat(safe);
          if (!info) throw fsError("ENOENT", `no such file or directory, stat '${safe}'`);
          if (info.kind !== "file") {
            await reply.code(400).send({ code: "FS_ERROR", message: "Not a file." });
            return;
          }
          const byteLength = info.size;
          await reply.send(
            await readParquetWindow(
              safe,
              {
                offset: offset === undefined ? undefined : Number(offset),
                limit: limit === undefined ? undefined : Number(limit),
                orderBy,
                desc: desc === "1"
              },
              {
                key: `box:${fs.boxId}:${safe}`,
                open: async () =>
                  cachedAsyncBuffer({
                    byteLength,
                    slice: async (start, end) => {
                      const stop = Math.min(end ?? byteLength, byteLength);
                      const bytes = await fs.read(safe, { offset: start, length: Math.max(0, stop - start) });
                      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
                    }
                  }),
                mtimeMs: async () => info.mtimeMs
              }
            )
          );
        } catch (error) {
          if (error instanceof ParquetRequestError) {
            await reply.code(400).send({ code: "FS_ERROR", message: error.message });
            return;
          }
          await sendError(reply, error, "Cannot read parquet file.", fs);
        }
      }
    },

    // Capabilities of the box that holds `?path=` (the host route answers for the host without one).
    "GET /api/fs/capabilities": {
      target: queryPath,
      async serve({ reply, fs }) {
        try {
          const tools = await boxTools(fs);
          const zip = zipToolOf(tools);
          const response: FsCapabilitiesResponse = {
            folderZip: zip !== null,
            zipTool: zip?.bin ?? null,
            archiveTool: archiveToolOf(tools)?.bin ?? null,
            regexSearch: tools.rg
          };
          await reply.send(response);
        } catch (error) {
          await sendError(reply, error, "Cannot probe the box.", fs);
        }
      }
    },

    // Download a file (streamed out of the box) or a folder (zipped in the box, streamed).
    "GET /api/fs/download": {
      target: queryPath,
      async serve({ request, reply, fs, contain }) {
        let safe: string;
        try {
          safe = await contain(queryPath(request)!);
        } catch (error) {
          await sendError(reply, error, "Cannot resolve path.", fs);
          return;
        }
        let info;
        try {
          info = await fs.stat(safe);
        } catch (error) {
          if (error instanceof BoxFsUnavailableError) {
            await sendError(reply, error, "Not found.");
            return;
          }
          info = null;
        }
        if (!info) {
          await reply.code(404).send({ code: "FS_ERROR", message: "Not found." });
          return;
        }
        const name = posix.basename(safe);

        if (info.kind === "file") {
          // The response closing (done, or the client gone) ends the box read; after a full transfer it is a no-op.
          const abort = new AbortController();
          reply.raw.on("close", () => abort.abort());
          let stream;
          try {
            stream = await fs.readStream(safe, { signal: abort.signal });
          } catch (error) {
            await sendError(reply, error, "Cannot read file.", fs);
            return;
          }
          await reply
            .header("Content-Disposition", contentDisposition(name))
            .header("Content-Length", String(info.size))
            .header("X-Content-Type-Options", "nosniff")
            .type("application/octet-stream")
            .send(stream);
          return;
        }

        if (info.kind === "dir") {
          let child;
          try {
            child = await spawnBoxDirZip(fs, safe);
          } catch (error) {
            await sendError(reply, error, "Cannot zip the folder.", fs);
            return;
          }
          if (!child) {
            await reply.code(501).send({ code: "FS_UNSUPPORTED", message: "No zip tool (bsdtar/zip/7z) in the project's box." });
            return;
          }
          reply.hijack();
          reply.raw.writeHead(200, {
            "content-type": "application/zip",
            "content-disposition": contentDisposition(`${name}.zip`),
            "x-content-type-options": "nosniff",
            "cache-control": "no-cache"
          });
          // As on the host: a failed or killed zip tool means a truncated zip, so the transfer must fail visibly.
          child.stdout.pipe(reply.raw);
          child.stderr.resume();
          child.on("error", () => reply.raw.destroy());
          child.on("exit", (code) => {
            if (code !== 0) reply.raw.destroy();
          });
          reply.raw.on("close", () => child.kill());
          return;
        }

        await reply.code(400).send({ code: "FS_ERROR", message: "Not a file or folder." });
      }
    },

    // Write (save) a file's text content.
    "PUT /api/fs/write": {
      target: (request) => {
        const body = bodyOf<FsWriteRequest>(request);
        return body.path && typeof body.content === "string" ? body.path : undefined;
      },
      async serve({ request, reply, fs, contain }) {
        const body = bodyOf<FsWriteRequest>(request);
        try {
          const safe = await contain(body.path!);
          const existing = await fs.stat(safe);
          if (existing?.kind === "dir") throw fsError("EISDIR", `illegal operation on a directory, open '${safe}'`);
          // The box writes temp + rename: keep the file's own permissions, as an in-place write would.
          await fs.writeFile(safe, body.content!, existing ? { mode: existing.mode & 0o7777 } : {});
          await reply.send({ ok: true });
        } catch (error) {
          await sendError(reply, error, "Cannot write file.", fs);
        }
      }
    },

    // Create a file or directory.
    "POST /api/fs/create": {
      target: (request) => {
        const body = bodyOf<FsCreateRequest>(request);
        return body.path && (body.kind === "file" || body.kind === "dir") ? body.path : undefined;
      },
      async serve({ request, reply, fs, contain }) {
        const body = bodyOf<FsCreateRequest>(request);
        try {
          const safe = await contain(body.path!);
          if (body.kind === "dir") {
            await fs.mkdir(safe, { recursive: true });
          } else {
            await fs.mkdir(posix.dirname(safe), { recursive: true });
            // The box link has no exclusive create: check, then write (a race can only meet an empty file).
            if (await fs.stat(safe, { followSymlinks: false })) throw fsError("EEXIST", `file already exists, open '${safe}'`);
            await fs.writeFile(safe, "");
          }
          await reply.send({ ok: true });
        } catch (error) {
          await sendError(reply, error, "Cannot create entry.", fs);
        }
      }
    },

    // Rename in place (same parent); a name conflict is 409 FS_EXISTS. See the host route for the parent-only realpath.
    "POST /api/fs/rename": {
      target: (request) => {
        const body = bodyOf<FsRenameRequest>(request);
        return body.path && typeof body.newName === "string" && body.newName.trim() ? body.path : undefined;
      },
      async serve({ request, reply, fs, projectRoot, contain }) {
        const body = bodyOf<FsRenameRequest>(request);
        const newName = body.newName!.trim();
        if (/[\\/]/.test(newName) || newName === "." || newName === "..") {
          await reply.code(400).send({ code: "INVALID_REQUEST", message: "newName must be a plain file or folder name." });
          return;
        }
        try {
          const resolvedPath = posix.resolve(body.path!);
          if (resolvedPath === projectRoot) {
            // The project row and every store are keyed by this path; its box folder must keep it.
            await reply.code(400).send({ code: "FS_ERROR", message: "Cannot rename a box project's folder." });
            return;
          }
          const parent = await contain(posix.dirname(resolvedPath));
          const source = posix.join(parent, posix.basename(resolvedPath));
          if (newName === posix.basename(source)) {
            await reply.send({ ok: true });
            return;
          }
          const target = posix.join(parent, newName);
          const sourceStat = await fs.stat(source, { followSymlinks: false });
          if (!sourceStat) throw fsError("ENOENT", `no such file or directory, lstat '${source}'`);
          const existing = await fs.stat(target, { followSymlinks: false });
          // Same entry (a case-only rename on a case-insensitive box): its identity, or on a box that
          // reports none (Windows), the same name but for case.
          const sameEntry =
            existing !== null &&
            (existing.identity !== null && sourceStat.identity !== null
              ? existing.identity === sourceStat.identity
              : fs.connection.sys.os !== "linux" && newName.toLowerCase() === posix.basename(source).toLowerCase());
          if (existing && !sameEntry) {
            await reply.code(409).send({ code: "FS_EXISTS", message: `A file or folder named "${newName}" already exists.` });
            return;
          }
          await fs.rename(source, target);
          await reply.send({ ok: true });
        } catch (error) {
          await sendError(reply, error, "Cannot rename entry.", fs);
        }
      }
    },

    // Upload one file: the body streams straight into the box (temp file beside the target, then renamed).
    "POST /api/fs/upload": {
      upload: true,
      target: (request) => {
        const { destDir, relativePath } = queryOf(request);
        return destDir && relativePath ? destDir : undefined;
      },
      async serve({ request, reply, fs, contain }) {
        const { destDir, relativePath, onConflict = "error" } = queryOf(request) as Partial<FsUploadRequest>;
        if (onConflict !== "error" && onConflict !== "overwrite" && onConflict !== "rename") {
          refuseUpload(reply, 400, "INVALID_REQUEST", "onConflict must be error, overwrite or rename.");
          return;
        }
        const segments = relativePath!.split(/[\\/]+/).filter((segment) => segment.length > 0);
        if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
          refuseUpload(reply, 400, "INVALID_REQUEST", "relativePath is invalid.");
          return;
        }
        if (declaredLengthExceedsCap(request.headers)) {
          refuseUpload(reply, 413, "UPLOAD_TOO_LARGE", new UploadTooLargeError().message);
          return;
        }
        const leaf = segments[segments.length - 1]!;
        const fileConflict: FsUploadResponse = { path: "", name: leaf, size: 0, conflict: true, conflictKind: "file" };
        const isTypeClash = (error: unknown): boolean => {
          const code = errnoOf(error);
          return code === "ENOTDIR" || code === "EEXIST";
        };
        let tmp: string | undefined;
        const counter = { bytes: 0 };
        try {
          const safeDir = await contain(destDir!);
          const target = await contain(posix.join(safeDir, ...segments));
          try {
            await fs.mkdir(safeDir, { recursive: true });
          } catch (error) {
            if (!isTypeClash(error)) throw error;
            reply.header("connection", "close"); // body unread
            await reply.send(fileConflict);
            return;
          }
          tmp = uploadTempPath(safeDir);
          await fs.writeFile(tmp, cappedUploadBody(request.raw, counter));
          const size = counter.bytes;

          try {
            await fs.mkdir(posix.dirname(target), { recursive: true });
          } catch (error) {
            if (!isTypeClash(error)) throw error;
            await fs.rm(tmp, { force: true }).catch(() => undefined);
            await reply.send(fileConflict);
            return;
          }

          if (onConflict === "error") {
            const existing = await fs.stat(target);
            if (existing) {
              await fs.rm(tmp, { force: true }).catch(() => undefined);
              await reply.send({ ...fileConflict, conflictKind: existing.kind === "dir" ? "dir" : "file" });
              return;
            }
            await fs.rename(tmp, target);
            await reply.send({ path: target, name: leaf, size });
            return;
          }
          if (onConflict === "rename") {
            const renamed = await nextAvailableName(fs, target);
            await fs.rename(tmp, renamed);
            await reply.send({ path: renamed, name: posix.basename(renamed), size });
            return;
          }
          // "overwrite": the rename replaces a file; a directory there fails (FS_ERROR below).
          await fs.rename(tmp, target);
          await reply.send({ path: target, name: leaf, size });
        } catch (error) {
          if (tmp) await fs.rm(tmp, { force: true }).catch(() => undefined);
          if (error instanceof BoxFsUnavailableError) {
            refuseUpload(reply, error.status, error.code, error.message);
            return;
          }
          if (error instanceof FsSandboxError) {
            refuseUpload(reply, 403, "FS_FORBIDDEN", error.message);
            return;
          }
          // The box link may wrap the body's own error: the byte count tells the cap apart.
          if (isUploadTooLarge(error) || counter.bytes > MAX_UPLOAD_BYTES) {
            refuseUpload(reply, 413, "UPLOAD_TOO_LARGE", new UploadTooLargeError().message);
            return;
          }
          const status = errnoOf(error) === "ENOSPC" ? 507 : 400;
          refuseUpload(
            reply,
            status,
            "FS_ERROR",
            error instanceof Error ? hostMessage(fs, error.message) : "Cannot store the uploaded file."
          );
        }
      }
    },

    // Delete a file or folder (and close what runs under it). The box project's own folder goes only with the project.
    "DELETE /api/fs": {
      target: (request) => queryOf(request).path || undefined,
      async serve({ request, reply, fs, projectRoot, contain }) {
        const path = queryOf(request).path!;
        try {
          const safe = await contain(path);
          if (safe === projectRoot) {
            await reply.code(400).send({ code: "FS_ERROR", message: "Delete the project to remove a box project's folder." });
            return;
          }
          await deps.closeUnder(safe, posix.resolve(path));
          await fs.rm(safe, { recursive: true, force: false });
          await reply.send({ ok: true });
        } catch (error) {
          await sendError(reply, error, "Cannot delete entry.", fs);
        }
      }
    }
  };
}

/** The next free `name (n).ext` beside `desired` in the box (the host route's keep-both rule). */
async function nextAvailableName(fs: BoxProjectFs, desired: string): Promise<string> {
  const dir = posix.dirname(desired);
  const base = posix.basename(desired);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let n = 1; ; n++) {
    const candidate = posix.join(dir, `${stem} (${n})${ext}`);
    if ((await fs.stat(candidate, { followSymlinks: false })) === null) return candidate;
  }
}

/**
 * Route `/api/fs/*` requests for box-project paths to the box (see the module
 * doc). Registered once per app; host paths fall through to `index.ts`.
 */
export function registerBoxFsRouting(app: FastifyInstance, deps: BoxFsRoutingDeps): void {
  const table = routes(deps);
  app.addHook("preHandler", async (request, reply) => {
    const method = request.method === "HEAD" ? "GET" : request.method;
    const route = table[`${method} ${request.routeOptions.url}`];
    if (!route) return;
    const target = route.target(request);
    if (!target) return;
    let location;
    try {
      location = locateProjectFs(deps.boxes(), target);
    } catch (error) {
      if (!(error instanceof BoxFsUnavailableError)) throw error;
      if (route.upload) return refuseUpload(reply, error.status, error.code, error.message);
      return reply.code(error.status).send({ code: error.code, message: error.message });
    }
    if (location.kind === "host") return;
    const { fs, projectRoot } = location;
    const contain = async (path: string): Promise<string> => {
      // The project's folder inside the daemon's sandbox (its host stub), then the target inside the folder, in the box.
      await assertInsideFsRoot(deps.fsRoot(), projectRoot);
      return fs.assertInside(projectRoot, path);
    };
    await route.serve({ request, reply, fs, projectRoot, contain });
    return reply;
  });
}
