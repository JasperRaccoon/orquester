/**
 * `ProjectFs`: the file operations every file feature needs, against the place a
 * project's files live (spec §8.7). {@link HostProjectFs} is node:fs on this
 * machine; {@link BoxProjectFs} is the same operations over a `BoxConnection`
 * (`fs.*` requests and the file-read / file-write channels). {@link locateProjectFs}
 * picks one per path through `BoxRegistry.locate`.
 *
 * Paths in and out are always HOST paths; `BoxProjectFs` maps them to box paths
 * (`paths.ts`) on the way in and back on the way out, so callers never see a
 * Windows box path.
 *
 * The daemon's existing host file code (the `/api/fs/*` handlers, `search.ts`,
 * `FsTools`, the secret-files helpers) keeps its own node:fs paths for host
 * projects, unchanged; the code written for box projects is written against
 * this interface, and `HostProjectFs` lets it run (and be compared) on the host.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { BoxFsStat } from "@orquester/api";
import { assertInsideFsRoot, FsSandboxError } from "@orquester/config/fs";

import type { BoxConnection, BoxExecOptions, BoxProcess, BoxRegistry } from "../../contracts.ts";
import { BoxFsUnavailableError, errnoOf, fsError, linkDownError } from "./errors.ts";
import { BoxPaths, hostJoin } from "./paths.ts";

export type ProjectFsEntryKind = BoxFsStat["kind"];

export interface ProjectFsStat {
  kind: ProjectFsEntryKind;
  size: number;
  mtimeMs: number;
  mode: number;
  /** Device + inode (`dev:ino`), for "is it the same file" checks; null where the box cannot tell. */
  identity: string | null;
}

export interface ProjectFsDirEntry {
  name: string;
  kind: ProjectFsEntryKind;
  size: number;
  mtimeMs: number;
}

export interface ProjectFsReadOptions {
  offset?: number;
  length?: number;
  signal?: AbortSignal;
}

export interface ProjectFsWriteOptions {
  mode?: number;
  /** Create missing parent directories. */
  mkdirs?: boolean;
}

export interface ProjectFs {
  readonly location: "host" | "box";
  /**
   * The sandbox check of the file routes: `target` (lexically resolved) with its
   * deepest existing ancestor realpath'd where the files live, which must be
   * `root` or inside it (also realpath'd there). Answers the checked path in host
   * form; throws `FsSandboxError` when it escapes (`..`, a symlink out).
   */
  assertInside(root: string, target: string): Promise<string>;
  /** Null when nothing is there. `followSymlinks: false` = lstat. */
  stat(path: string, options?: { followSymlinks?: boolean }): Promise<ProjectFsStat | null>;
  readdir(path: string): Promise<ProjectFsDirEntry[]>;
  realpath(path: string): Promise<string>;
  readStream(path: string, options?: ProjectFsReadOptions): Promise<Readable>;
  /** The bytes of a range (or the whole file), collected in memory: callers bound `length`. */
  read(path: string, options?: ProjectFsReadOptions): Promise<Buffer>;
  /** Atomic where the files live supports it (the box always writes temp + rename). */
  writeFile(path: string, data: Readable | Uint8Array | string, options?: ProjectFsWriteOptions): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

function kindOf(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): ProjectFsEntryKind {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "dir";
  if (stats.isFile()) return "file";
  return "other";
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export class HostProjectFs implements ProjectFs {
  readonly location = "host" as const;

  assertInside(root: string, target: string): Promise<string> {
    return assertInsideFsRoot(root, target);
  }

  async stat(path: string, options: { followSymlinks?: boolean } = {}): Promise<ProjectFsStat | null> {
    try {
      const s = options.followSymlinks === false ? await lstat(path) : await stat(path);
      return { kind: kindOf(s), size: s.size, mtimeMs: s.mtimeMs, mode: s.mode, identity: `${s.dev}:${s.ino}` };
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return null;
      throw error;
    }
  }

  async readdir(path: string): Promise<ProjectFsDirEntry[]> {
    const dirents = await readdir(path, { withFileTypes: true });
    return Promise.all(
      dirents.map(async (dirent) => {
        const s = await lstat(posix.join(path, dirent.name)).catch(() => null);
        return { name: dirent.name, kind: kindOf(dirent), size: s?.size ?? 0, mtimeMs: s?.mtimeMs ?? 0 };
      })
    );
  }

  realpath(path: string): Promise<string> {
    return realpath(path);
  }

  async readStream(path: string, options: ProjectFsReadOptions = {}): Promise<Readable> {
    const start = options.offset ?? 0;
    if (options.length === 0) return Readable.from([]);
    const end = options.length !== undefined ? start + options.length - 1 : undefined;
    const stream = createReadStream(path, { start, end, signal: options.signal });
    // Surface ENOENT/EISDIR here, like the box's channel open does.
    await new Promise<void>((resolve, reject) => {
      stream.once("open", () => resolve());
      stream.once("error", reject);
    });
    return stream;
  }

  async read(path: string, options: ProjectFsReadOptions = {}): Promise<Buffer> {
    return collect(await this.readStream(path, options));
  }

  async writeFile(path: string, data: Readable | Uint8Array | string, options: ProjectFsWriteOptions = {}): Promise<void> {
    if (options.mkdirs) await mkdir(posix.dirname(path), { recursive: true });
    const tmp = `${path}.orq-tmp-${process.pid}-${Date.now()}`;
    const source = typeof data === "string" || data instanceof Uint8Array ? Readable.from([data]) : data;
    try {
      await pipeline(source, createWriteStream(tmp, { flags: "wx", mode: options.mode }));
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await mkdir(path, { recursive: options.recursive ?? false });
  }

  rename(from: string, to: string): Promise<void> {
    return rename(from, to);
  }

  rm(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    return rm(path, options);
  }
}

// ---------------------------------------------------------------------------
// Box
// ---------------------------------------------------------------------------

/** `ProjectFs` over a box link. Every method maps host paths to box paths and box errors to errno-style ones. */
export class BoxProjectFs implements ProjectFs {
  readonly location = "box" as const;
  readonly paths: BoxPaths;

  constructor(readonly connection: BoxConnection) {
    this.paths = new BoxPaths(connection.paths);
  }

  get boxId(): string {
    return this.connection.boxId;
  }

  /** Box path of a host path. */
  toBox(hostPath: string): string {
    return this.paths.toBox(hostPath);
  }

  /** Host path of a box path the box answered with; throws when the box answered a path outside the mapping. */
  toHost(boxPath: string): string {
    const host = this.paths.toHost(boxPath);
    if (host === null) throw new FsSandboxError(`Path is outside the sandbox: ${boxPath}`);
    return host;
  }

  async assertInside(root: string, target: string): Promise<string> {
    const resolvedRoot = posix.resolve(root);
    const resolved = posix.resolve(target);
    const rootBox = this.toBox(resolvedRoot);
    const realRoot = await this.realpathBox(rootBox).catch(() => rootBox);
    // The deepest existing ancestor of the target, realpath'd in the box, plus the missing tail.
    let ancestor = resolved;
    let realAncestor: string | null = null;
    for (;;) {
      realAncestor = await this.realpathBox(this.toBox(ancestor)).catch((error: unknown) => {
        if (error instanceof BoxFsUnavailableError) throw error;
        return null;
      });
      if (realAncestor !== null) break;
      const parent = posix.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const tail = posix.relative(ancestor, resolved);
    const tailSegments = tail ? tail.split("/") : [];
    const finalBox = this.paths.join(realAncestor ?? this.toBox(ancestor), ...tailSegments);
    const inside = this.paths.segmentsInside(realRoot, finalBox);
    if (inside === null) throw new FsSandboxError(`Path is outside the sandbox: ${target}`);
    // Answered under the root's HOST spelling: a box whose root realpaths elsewhere (macOS
    // `/var` → `/private/var`) still answers the host path every store knows.
    return hostJoin(resolvedRoot, inside);
  }

  async stat(path: string, options: { followSymlinks?: boolean } = {}): Promise<ProjectFsStat | null> {
    const found = await this.call(() =>
      this.connection.request("fs.stat", {
        path: this.toBox(path),
        ...(options.followSymlinks === false ? { followSymlinks: false } : {})
      })
    );
    if (found === null) return null;
    return { kind: found.kind, size: found.size, mtimeMs: found.mtimeMs, mode: found.mode, identity: found.identity };
  }

  async readdir(path: string): Promise<ProjectFsDirEntry[]> {
    const entries = await this.call(() => this.connection.request("fs.readdir", { path: this.toBox(path) }));
    return entries.map((entry) => ({ name: entry.name, kind: entry.kind, size: entry.size, mtimeMs: entry.mtimeMs }));
  }

  async realpath(path: string): Promise<string> {
    return this.toHost(await this.realpathBox(this.toBox(path)));
  }

  /** realpath of a BOX path, answered as a box path. */
  realpathBox(boxPath: string): Promise<string> {
    return this.call(() => this.connection.request("fs.realpath", { path: boxPath }));
  }

  async readStream(path: string, options: ProjectFsReadOptions = {}): Promise<Readable> {
    if (options.length === 0) return Readable.from([]);
    return this.call(() =>
      this.connection.readFile(this.toBox(path), {
        ...(options.offset !== undefined ? { offset: options.offset } : {}),
        ...(options.length !== undefined ? { length: options.length } : {}),
        ...(options.signal ? { signal: options.signal } : {})
      })
    );
  }

  async read(path: string, options: ProjectFsReadOptions = {}): Promise<Buffer> {
    const stream = await this.readStream(path, options);
    return this.call(() => collect(stream));
  }

  writeFile(path: string, data: Readable | Uint8Array | string, options: ProjectFsWriteOptions = {}): Promise<void> {
    return this.call(() =>
      this.connection.writeFile(this.toBox(path), data, {
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
        ...(options.mkdirs ? { mkdirs: true } : {})
      })
    );
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.call(() => this.connection.request("fs.mkdir", { path: this.toBox(path), recursive: options.recursive ?? false }));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.call(() => this.connection.request("fs.rename", { from: this.toBox(from), to: this.toBox(to) }));
  }

  async rm(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    await this.call(() =>
      // Both flags always explicit: an `orq-agent` passing an absent one on as `undefined` must not refuse the call.
      this.connection.request("fs.rm", { path: this.toBox(path), recursive: options.recursive ?? false, force: options.force ?? false })
    );
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.call(() => this.connection.request("fs.chmod", { path: this.toBox(path), mode }));
  }

  /** A process in the box; `cwd` is a host path (mapped here). */
  exec(options: Omit<BoxExecOptions, "cwd"> & { cwd?: string }): BoxProcess {
    if (!this.connection.connected) throw this.notConnected();
    const { cwd, ...rest } = options;
    return this.connection.exec({ ...rest, ...(cwd !== undefined ? { cwd: this.toBox(cwd) } : {}) });
  }

  notConnected(): BoxFsUnavailableError {
    return new BoxFsUnavailableError("BOX_NOT_READY", this.boxId, "The project's box is not connected right now. Try again once it is back.");
  }

  /** Run one box call: refused at once while the link is down; a link that drops mid-call answers 409. */
  private async call<T>(run: () => Promise<T>): Promise<T> {
    if (!this.connection.connected) throw this.notConnected();
    try {
      return await run();
    } catch (error) {
      throw linkDownError(error, this.boxId) ?? normalizeBoxError(error);
    }
  }
}

/** An `orq-agent` error answer as an Error with an errno-style `code` (the box sends `{ code, message }`). */
function normalizeBoxError(error: unknown): unknown {
  if (error instanceof Error) return error;
  const code = errnoOf(error);
  const message = (error as { message?: unknown } | null)?.message;
  return fsError(code ?? "EIO", typeof message === "string" ? message : "The box could not complete the file operation.");
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type ProjectFsLocation =
  | { kind: "host" }
  | {
      kind: "box";
      boxId: string;
      /** The box project's host path: the sandbox root of every box path below it. */
      projectRoot: string;
      fs: BoxProjectFs;
    };

/** Where `path` lives: the host (no registry, the plugin off, a host project) or a ready box. */
export function locateProjectFs(registry: BoxRegistry | undefined, path: string): ProjectFsLocation {
  if (!registry || !path.startsWith("/")) return { kind: "host" };
  const location = registry.locate(posix.resolve(path));
  if (location.kind === "host") return location;
  const { boxId, record, connection } = location;
  const projectRoot = record.project?.path;
  if (record.state === "destroyed" || record.state === "destroying") {
    throw new BoxFsUnavailableError(
      "BOX_DESTROYED",
      boxId,
      record.state === "destroyed"
        ? "This project's box was destroyed; its files are gone."
        : "This project's box is being destroyed."
    );
  }
  if (record.state === "destroy-failed") {
    throw new BoxFsUnavailableError("BOX_NOT_READY", boxId, "This project's box could not be destroyed; retry the delete.");
  }
  if (!projectRoot) {
    throw new BoxFsUnavailableError("BOX_NOT_READY", boxId, "This project's box has no project record yet.");
  }
  if (!connection || !connection.connected) {
    throw new BoxFsUnavailableError(
      "BOX_NOT_READY",
      boxId,
      record.state === "provisioning"
        ? "This project's box is still being set up."
        : "This project's box is not connected right now. Try again once it is back."
    );
  }
  return { kind: "box", boxId, projectRoot: posix.resolve(projectRoot), fs: new BoxProjectFs(connection) };
}
