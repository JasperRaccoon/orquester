/**
 * Config sync — the host side: walking a config root the way a CLI reads it (symlinks followed,
 * so the account home's links into the shared system config are materialized as real files in
 * the box), view hashes cached by (size, mtime), and atomic writes that go through symlinks to
 * their targets (an approved change to `<home>/skills/x` lands in the shared `~/.claude/skills`).
 */

import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, posix } from "node:path";
import { pipeline } from "node:stream/promises";

import type { BoxPathMap } from "@orquester/api";

import { syncCodec, type CodecContext } from "./codecs.ts";
import { isDeniedRealPath, isInsidePath, isSafeRelPath, isSyncedRel, SYNC_TEMP_MARKER, type SyncRule } from "./rules.ts";

/**
 * Errors that mean a path is not there: gone, a file where a dir was expected, a link loop (a
 * dangling link). Anything else (EACCES, EIO, EMFILE…) says nothing about the path and must
 * never be read as a deletion.
 */
export function isAbsentError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

/** The result of a host fs call, or null when the path is absent; any other failure is thrown. */
export async function orAbsent<T>(operation: Promise<T>): Promise<T | null> {
  try {
    return await operation;
  } catch (error) {
    if (isAbsentError(error)) return null;
    throw error;
  }
}

/** Files larger than this never sync (logged once per walk). */
export const MAX_SYNC_FILE_BYTES = 64 * 1024 * 1024;
/** A root with more files than this stops at the cap (logged). */
export const MAX_SYNC_FILES_PER_ROOT = 20_000;
const MAX_DEPTH = 24;

export interface HostFile {
  /** The path as the CLI sees it (under the root, through any links). */
  path: string;
  rel: string;
  /** Its realpath (where the bytes are, and where an approved change is written). */
  real: string;
  size: number;
  mtimeMs: number;
  mode: number;
}

/** A host directory a watcher must cover: `recursive` for linked dirs, the parent of a linked file otherwise. */
export interface HostWatchTarget {
  dir: string;
  recursive: boolean;
  /** For a parent-of-a-linked-file target: the one name in `dir` that matters. */
  name: string | null;
  /** The logical path `dir` (or `dir/name`) stands for. */
  logical: string;
}

export interface HostTree {
  files: Map<string, HostFile>;
  /** Logical dirs (included ones and everything below them). */
  dirs: Set<string>;
  watch: HostWatchTarget[];
  /** Paths skipped by the deny list or the size cap (never their content). */
  skipped: string[];
  /**
   * Paths whose state could not be read (permissions, I/O errors): nothing at or below them is
   * known, so a pass neither pushes nor deletes there.
   */
  unreadable: string[];
}

export function relOf(root: string, path: string): string | null {
  if (!isInsidePath(path, root) || path === root) return null;
  return path.slice(root.endsWith("/") ? root.length : root.length + 1);
}

/**
 * Walk `root` under `rule`: only included top-level entries, excluded names skipped, the deny
 * list checked on the logical path and on every realpath. A symlink cycle (a dir whose realpath
 * is already an ancestor's) is not entered. Only a path that is not there counts as absent: one
 * whose state cannot be read lands in `unreadable` (see {@link HostTree.unreadable}).
 */
export async function walkHost(root: string, rule: SyncRule, denyRoots: readonly string[]): Promise<HostTree> {
  const tree: HostTree = { files: new Map(), dirs: new Set(), watch: [], skipped: [], unreadable: [] };
  /** `operation`'s result; null when absent; `undefined` (and `path` recorded) when unreadable. */
  const read = async <T>(path: string, operation: Promise<T>): Promise<T | null | undefined> => {
    try {
      return await orAbsent(operation);
    } catch {
      tree.unreadable.push(path);
      return undefined;
    }
  };
  const rootReal = await read(root, realpath(root));
  if (!rootReal) return tree;
  tree.watch.push({ dir: rootReal, recursive: true, name: null, logical: root });

  const visit = async (path: string, rel: string, depth: number, ancestors: ReadonlySet<string>): Promise<void> => {
    if (tree.files.size >= MAX_SYNC_FILES_PER_ROOT || depth > MAX_DEPTH) return;
    if (!isSyncedRel(rule, rel)) {
      if (rule.include.has(rel.split("/")[0]!) && !rule.excluded(rel)) tree.skipped.push(path);
      return;
    }
    const link = await read(path, lstat(path));
    if (!link) return;
    const info = await read(path, stat(path));
    if (info === undefined) return;
    const real = await read(path, realpath(path));
    if (real === undefined) return;
    if (info === null || real === null) return; // dangling link
    if (isDeniedRealPath(real, denyRoots) || real.includes(SYNC_TEMP_MARKER)) {
      tree.skipped.push(path);
      return;
    }
    if (info.isDirectory()) {
      if (ancestors.has(real)) return;
      const names = await read(path, readdir(path));
      if (!names) return; // unreadable, or gone meanwhile
      tree.dirs.add(path);
      if (link.isSymbolicLink()) tree.watch.push({ dir: real, recursive: true, name: null, logical: path });
      const next = new Set(ancestors).add(real);
      names.sort();
      for (const name of names) await visit(`${path}/${name}`, `${rel}/${name}`, depth + 1, next);
      return;
    }
    if (!info.isFile()) return;
    if (info.size > MAX_SYNC_FILE_BYTES) {
      tree.skipped.push(path);
      return;
    }
    if (link.isSymbolicLink()) tree.watch.push({ dir: dirname(real), recursive: false, name: basename(real), logical: path });
    tree.files.set(path, { path, rel, real, size: info.size, mtimeMs: info.mtimeMs, mode: info.mode & 0o777 });
  };

  const names = await read(root, readdir(root));
  if (!names) return tree;
  names.sort();
  for (const name of names) {
    if (!rule.include.has(name)) continue;
    await visit(`${root}/${name}`, name, 1, new Set([rootReal]));
  }
  return tree;
}

/**
 * One logical path, as {@link walkHost} would report it (null = absent, excluded, denied or not a
 * file). A path whose state cannot be read throws: it is never "absent".
 */
export async function hostFileAt(root: string, rule: SyncRule, path: string, denyRoots: readonly string[]): Promise<HostFile | null> {
  const rel = relOf(root, path);
  if (rel === null || !isSyncedRel(rule, rel)) return null;
  const info = await orAbsent(stat(path));
  if (info === null || !info.isFile() || info.size > MAX_SYNC_FILE_BYTES) return null;
  const real = await orAbsent(realpath(path));
  if (real === null || isDeniedRealPath(real, denyRoots)) return null;
  return { path, rel, real, size: info.size, mtimeMs: info.mtimeMs, mode: info.mode & 0o777 };
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** A codec context's cache key part (the claude-json view depends on the box's path map). */
export function pathMapKey(paths: BoxPathMap): string {
  return paths.kind === "identity" ? "identity" : `win:${paths.prefix}`;
}

interface CachedHash {
  size: number;
  mtimeMs: number;
  hash: string | null;
}

/**
 * View hashes of host files, keyed by (realpath, codec, path map) and reused while the file's size
 * and mtime stay the same. `null` = the file cannot be synced (a config that does not parse).
 */
export class HostViewHashes {
  private readonly cache = new Map<string, CachedHash>();

  constructor(private readonly maxEntries = 50_000) {}

  async hash(file: HostFile, rule: SyncRule, ctx: CodecContext): Promise<string | null> {
    const codecId = rule.codec(file.rel);
    const key = `${codecId}|${pathMapKey(ctx.paths)}|${file.real}`;
    const cached = this.cache.get(key);
    if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) return cached.hash;
    let hash: string | null;
    if (codecId === "raw") {
      hash = await sha256File(file.real);
    } else {
      const view = syncCodec(codecId).hostView(await readFile(file.real), ctx);
      hash = view === null ? null : sha256(view);
    }
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { size: file.size, mtimeMs: file.mtimeMs, hash });
    return hash;
  }
}

/**
 * Where a write to logical `path` lands: the realpath of the file when it exists, else the
 * realpath of its nearest existing ancestor plus the rest.
 */
export async function hostWriteTarget(path: string): Promise<string> {
  const existing = await realpath(path).catch(() => null);
  if (existing !== null) return existing;
  const missing: string[] = [];
  let dir = path;
  for (;;) {
    missing.unshift(basename(dir));
    dir = dirname(dir);
    const real = await realpath(dir).catch(() => null);
    if (real !== null) return posix.join(real, ...missing);
    if (dir === "/" || dir === ".") return path;
  }
}

/** Opens a new temp file: never through a link, never an existing file. */
const NEW_TEMP_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** Write `data` to `target` (a real path) through a sibling temp file and a rename. */
export async function writeHostFileAtomic(target: string, data: Buffer, mode: number): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeHostStreamAtomic(target, [data], mode, { maxBytes: data.length });
}

/**
 * Stream `source` into `target` (its dir must exist) through a sibling temp file and a rename,
 * hashing on the host as the bytes pass. More than `maxBytes` aborts; `check` sees the size and
 * SHA-256 of what was written and may refuse it (its answer is the error message) before the
 * rename, so a refused or failed write leaves `target` as it was.
 */
export async function writeHostStreamAtomic(
  target: string,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  mode: number,
  options: { maxBytes: number; check?: (written: { bytes: number; sha256: string }) => string | null }
): Promise<{ bytes: number; sha256: string }> {
  const tmp = `${target}${SYNC_TEMP_MARKER}${randomUUID()}`;
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    const handle = await open(tmp, NEW_TEMP_FLAGS, mode);
    try {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > options.maxBytes) throw new Error(`more than ${options.maxBytes} bytes`);
        hash.update(buffer);
        await handle.write(buffer);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    const written = { bytes, sha256: hash.digest("hex") };
    const refused = options.check?.(written) ?? null;
    if (refused !== null) throw new Error(refused);
    await chmod(tmp, mode).catch(() => undefined);
    await rename(tmp, target);
    return written;
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The host file `rel` names below `base`, for a write that must stay there (transcripts mirrored
 * from a box): `rel` must be plain names only, missing dirs are created (0700), and no symlink
 * below `base` is followed — a link (or anything but a dir) where a dir is expected, or anything
 * but a regular file at the target, is refused. The answer is under `realpath(base)`, so the file
 * it names is inside `base`'s realpath by construction.
 */
export async function hostTargetBelow(base: string, rel: string): Promise<string> {
  if (!isSafeRelPath(rel)) throw new Error(`not a plain relative path: ${JSON.stringify(rel)}`);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const baseReal = await realpath(base);
  let dir = baseReal === "/" ? "" : baseReal;
  const segments = rel.split("/");
  for (const segment of segments.slice(0, -1)) {
    const next = `${dir}/${segment}`;
    let info = await orAbsent(lstat(next));
    if (info === null) {
      await mkdir(next, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      info = await lstat(next);
    }
    if (!info.isDirectory()) throw new Error(`${next} is not a plain directory`);
    dir = next;
  }
  const target = `${dir}/${segments[segments.length - 1]!}`;
  const info = await orAbsent(lstat(target));
  if (info !== null && !info.isFile()) throw new Error(`${target} is not a plain file`);
  return target;
}
