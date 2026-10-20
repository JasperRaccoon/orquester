/**
 * The "Secret files" plugin for box projects (spec §8.7): a vault's files are
 * the clone's runtime config, so for a clone that lives in a box they are read,
 * written and watched IN THE BOX — through `ProjectFs`, git run in the box, and
 * `fs.watch` events — with the same safety rules as on the host (`files.ts`):
 *
 * - every parent below the clone root a real directory (no symlink, no nested
 *   repository), the file a regular file whose realpath stays in the clone;
 * - reads capped at SECRET_FILE_MAX_BYTES, retried when the file is swapped
 *   between the checks and the read (the identity is compared after the read);
 * - writes land in a temp file beside the target, whose realpath must be the
 *   path asked for (a parent swapped for a symlink is caught), then are renamed
 *   into place; `createOnly` never replaces anything (a hard link `ln` in a
 *   POSIX box; elsewhere a last check right before the rename);
 * - a clone root whose realpath leaves the workspaces root is never written.
 *
 * {@link boxAwareSecretFileIo} hands the service one set of file operations that
 * picks the host helpers or these per clone path, so the service itself is the
 * same for both.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { posix } from "node:path";

import { SECRET_FILE_MAX_BYTES, secretFilePathProblem, type BoxFsChangeEvent } from "@orquester/api";

import {
  CloneFileError,
  EXISTS_MESSAGE,
  REFUSAL_MESSAGES,
  UNREADABLE_CODES,
  defaultGitRunner,
  readCloneFile,
  scanCandidates,
  trackedPaths,
  writeCloneFile,
  type CloneFileRead,
  type CloneFileRefusal,
  type GitRunner,
  type WriteCloneFileOptions
} from "../../../secret-files/files.ts";
import {
  defaultDirIdentity,
  defaultWatch,
  type SecretFilesDirIdentityFn,
  type SecretFilesFileOps,
  type SecretFilesWatchFn
} from "../../../secret-files/service.ts";
import type { BoxRegistry } from "../../contracts.ts";
import { BoxFsUnavailableError, errnoOf } from "./errors.ts";
import { runBoxCommand } from "./exec.ts";
import { locateProjectFs, type BoxProjectFs, type ProjectFsStat } from "./project-fs.ts";

const READ_ATTEMPTS = 3;

type Inspected =
  | { kind: "file"; abs: string; parentAbs: string; rootReal: string; stats: ProjectFsStat }
  | { kind: "missing"; parentExists: boolean; abs: string; parentAbs: string; rootReal: string }
  | { kind: "refused"; refusal: CloneFileRefusal };

/** As `files.ts`: an fs error met while resolving a path, as a result; anything else rethrows. */
function classifyPathError(error: unknown): "missing" | CloneFileRefusal {
  if (error instanceof BoxFsUnavailableError) return "unreadable";
  const code = errnoOf(error);
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  if (code === "ELOOP") return "symlink";
  if (code && UNREADABLE_CODES.has(code)) return "unreadable";
  throw error;
}

function isInside(rootReal: string, candidate: string): boolean {
  return candidate.startsWith(rootReal.endsWith("/") ? rootReal : `${rootReal}/`);
}

function segmentsOf(relPath: string): string[] {
  const problem = secretFilePathProblem(relPath);
  if (problem) throw new Error(`Invalid secret file path: ${problem}`);
  return relPath.split("/");
}

/** `files.ts`'s `inspect`, in the box (host-form paths throughout; the box realpaths). */
async function inspect(fs: BoxProjectFs, cloneRoot: string, relPath: string): Promise<Inspected> {
  const segments = segmentsOf(relPath);
  let rootReal: string;
  try {
    rootReal = await fs.realpath(cloneRoot);
  } catch (error) {
    const result = classifyPathError(error);
    if (result === "missing") return { kind: "missing", parentExists: false, abs: "", parentAbs: "", rootReal: "" };
    return { kind: "refused", refusal: result };
  }
  let parentAbs = rootReal;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = posix.join(parentAbs, segments[i]!);
    let stats: ProjectFsStat | null;
    try {
      stats = await fs.stat(next, { followSymlinks: false });
    } catch (error) {
      const result = classifyPathError(error);
      if (result !== "missing") return { kind: "refused", refusal: result };
      stats = null;
    }
    if (stats === null) {
      return { kind: "missing", parentExists: false, abs: posix.join(rootReal, ...segments), parentAbs: next, rootReal };
    }
    if (stats.kind === "symlink") return { kind: "refused", refusal: "symlink" };
    if (stats.kind !== "dir") {
      return { kind: "missing", parentExists: false, abs: posix.join(rootReal, ...segments), parentAbs: next, rootReal };
    }
    // Another repository's ground (a nested repo, submodule or linked worktree).
    try {
      if ((await fs.stat(posix.join(next, ".git"), { followSymlinks: false })) !== null) return { kind: "refused", refusal: "outside" };
    } catch (error) {
      const result = classifyPathError(error);
      if (result !== "missing") return { kind: "refused", refusal: result };
    }
    parentAbs = next;
  }
  const abs = posix.join(parentAbs, segments[segments.length - 1]!);
  let stats: ProjectFsStat | null;
  try {
    stats = await fs.stat(abs, { followSymlinks: false });
  } catch (error) {
    const result = classifyPathError(error);
    if (result !== "missing") return { kind: "refused", refusal: result };
    stats = null;
  }
  if (stats === null) return { kind: "missing", parentExists: true, abs, parentAbs, rootReal };
  if (stats.kind === "symlink") return { kind: "refused", refusal: "symlink" };
  if (stats.kind !== "file") return { kind: "refused", refusal: "not-a-file" };
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch (error) {
    const result = classifyPathError(error);
    if (result === "missing") return { kind: "missing", parentExists: true, abs, parentAbs, rootReal };
    return { kind: "refused", refusal: result };
  }
  if (!isInside(rootReal, real)) return { kind: "refused", refusal: "outside" };
  if (stats.size > SECRET_FILE_MAX_BYTES) return { kind: "refused", refusal: "too-large" };
  return { kind: "file", abs, parentAbs, rootReal, stats };
}

/** True when the entry at `abs` is still the very file `expected` described (same identity, a regular file). */
function sameFile(now: ProjectFsStat | null, expected: ProjectFsStat): boolean {
  if (now === null || now.kind !== "file") return false;
  if (now.identity !== null && expected.identity !== null) return now.identity === expected.identity;
  // A box that reports no identity (Windows): the same size and modification time.
  return now.size === expected.size && now.mtimeMs === expected.mtimeMs;
}

/** `readCloneFile` for a clone in a box. */
export async function readBoxCloneFile(fs: BoxProjectFs, cloneRoot: string, relPath: string): Promise<CloneFileRead> {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    const found = await inspect(fs, cloneRoot, relPath);
    if (found.kind === "missing") return { kind: "missing", parentExists: found.parentExists };
    if (found.kind === "refused") return { kind: "refused", refusal: found.refusal };
    let content: Buffer;
    try {
      // At most MAX + 1 bytes whatever the size said: a file growing under us is still capped.
      content = await fs.read(found.abs, { length: SECRET_FILE_MAX_BYTES + 1 });
    } catch (error) {
      const result = classifyPathError(error);
      if (result === "missing") continue;
      return { kind: "refused", refusal: result };
    }
    // The box reads by path: prove afterwards that it read the file the walk checked.
    let after: ProjectFsStat | null;
    try {
      after = await fs.stat(found.abs, { followSymlinks: false });
    } catch (error) {
      const result = classifyPathError(error);
      if (result === "missing") continue;
      return { kind: "refused", refusal: result };
    }
    if (!sameFile(after, found.stats)) continue;
    if (content.byteLength > SECRET_FILE_MAX_BYTES) return { kind: "refused", refusal: "too-large" };
    return { kind: "file", content: new Uint8Array(content), mode: found.stats.mode & 0o777, mtimeMs: found.stats.mtimeMs };
  }
  return { kind: "refused", refusal: "unreadable" };
}

/** `writeCloneFile` for a clone in a box. */
export async function writeBoxCloneFile(
  fs: BoxProjectFs,
  cloneRoot: string,
  relPath: string,
  content: Uint8Array,
  mode?: number,
  options: WriteCloneFileOptions = {}
): Promise<void> {
  if (content.byteLength > SECRET_FILE_MAX_BYTES) {
    throw new CloneFileError(REFUSAL_MESSAGES["too-large"], { refusal: "too-large" });
  }
  const found = await inspect(fs, cloneRoot, relPath);
  if (found.kind === "refused") throw new CloneFileError(REFUSAL_MESSAGES[found.refusal], { refusal: found.refusal });
  if (found.kind === "missing" && !found.parentExists) {
    throw new CloneFileError("The file's folder doesn't exist in this project.", { parentMissing: true });
  }
  if (options.containedIn !== undefined) {
    // Compared realpath to realpath in the box, so a box whose paths realpath elsewhere (macOS
    // `/var` → `/private/var`) is judged on the same spelling.
    const rootOf = await fs.realpath(options.containedIn).catch(() => null);
    if (rootOf === null || !(found.rootReal === rootOf || isInside(rootOf, found.rootReal))) {
      throw new CloneFileError(REFUSAL_MESSAGES.outside, { refusal: "outside" });
    }
  }
  if (options.createOnly && found.kind === "file") throw new CloneFileError(EXISTS_MESSAGE, { exists: true });
  const { abs, parentAbs } = found;
  const fileMode = (mode ?? 0o600) & 0o777;
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  const tmp = posix.join(parentAbs, `.${name}.${randomBytes(8).toString("hex")}.orq-tmp`);
  let created = false;
  try {
    await fs.writeFile(tmp, content, { mode: fileMode });
    created = true;
    // The umask may have narrowed the create mode.
    await fs.chmod(tmp, fileMode);
    // A parent swapped for a symlink after the walk would have put the temp file elsewhere.
    const tmpReal = await fs.realpath(tmp);
    if (tmpReal !== tmp || !isInside(found.rootReal, tmpReal)) {
      throw new CloneFileError(REFUSAL_MESSAGES.symlink, { refusal: "symlink" });
    }
    if (options.createOnly) {
      await createFrom(fs, tmp, abs);
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      created = false;
      return;
    }
    // Re-check the target right before the rename (a rename replaces a link, never follows it).
    const again = await fs.stat(abs, { followSymlinks: false });
    if (again?.kind === "symlink") throw new CloneFileError(REFUSAL_MESSAGES.symlink, { refusal: "symlink" });
    if (again && again.kind !== "file") throw new CloneFileError(REFUSAL_MESSAGES["not-a-file"], { refusal: "not-a-file" });
    await fs.rename(tmp, abs);
    created = false;
  } catch (error) {
    if (created) await fs.rm(tmp, { force: true }).catch(() => undefined);
    if (error instanceof CloneFileError) throw error;
    const code = errnoOf(error);
    if (code === "ELOOP") throw new CloneFileError(REFUSAL_MESSAGES.symlink, { refusal: "symlink" });
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new CloneFileError("The file's folder doesn't exist in this project.", { parentMissing: true });
    }
    throw error;
  }
}

/**
 * Create `abs` from the written temp file without replacing anything. A POSIX
 * box has `ln` (link(2): fails when anything is at the path). Without hard
 * links (a Windows box, a file system that refuses them) the last check runs
 * right before the rename instead.
 */
async function createFrom(fs: BoxProjectFs, tmp: string, abs: string): Promise<void> {
  if (fs.connection.sys.os !== "win32") {
    const run = await runBoxCommand(fs, { command: "ln", args: ["--", fs.toBox(tmp), fs.toBox(abs)], timeoutMs: 30_000, maxStdoutBytes: 64 * 1024 });
    if (run.code === 0) return;
  }
  if ((await fs.stat(abs, { followSymlinks: false })) !== null) throw new CloneFileError(EXISTS_MESSAGE, { exists: true });
  await fs.rename(tmp, abs);
}

/** `git` run in the box, with the host runner's environment and bounds. Rejects on a non-zero exit or abort. */
export function boxGitRunner(fs: BoxProjectFs): GitRunner {
  return async (cwd, args, signal) => {
    const run = await runBoxCommand(fs, {
      command: "git",
      args,
      cwd,
      env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      ...(signal ? { signal } : {}),
      timeoutMs: 30_000,
      maxStdoutBytes: 32 * 1024 * 1024
    });
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    if (run.code !== 0 || run.overflow || run.timedOut) {
      throw new Error(`git ${args[0] ?? ""} failed in the box (${run.timedOut ? "timed out" : run.overflow ? "output too large" : `exit ${run.code}`}).`);
    }
    return run.stdout.toString("utf8");
  };
}

/**
 * Watch one directory of a box clone (non-recursive) through `fs.watch`. The
 * box's watch dies with the link, so a link drop or return reports a change
 * (the service's check runs and re-arms) and then the watch as failed.
 */
export function watchBoxDir(fs: BoxProjectFs, dir: string, onChange: (filename: string | null) => void, onError: (error: Error) => void) {
  const watchId = `secret-files:${randomUUID()}`;
  let closed = false;
  const stopEvents = fs.connection.onEvent("fs.change", (data) => {
    const event = data as BoxFsChangeEvent | null;
    if (closed || event?.watchId !== watchId) return;
    if (!Array.isArray(event.changes) || event.changes.length === 0) {
      onChange(null);
      return;
    }
    for (const change of event.changes) onChange(typeof change?.path === "string" ? fs.paths.api.basename(change.path) : null);
  });
  const stopStatus = fs.connection.onStatus(() => {
    if (closed) return;
    onChange(null);
    fail(new Error("The box link changed; the watch is re-armed by the next check."));
  });
  // A failed watch is dead: it reports once, then stays silent until the service closes it.
  let dead = false;
  const fail = (error: Error): void => {
    if (closed || dead) return;
    dead = true;
    stopEvents();
    stopStatus();
    onError(error);
  };
  const handle = {
    close: () => {
      if (closed) return;
      closed = true;
      stopEvents();
      stopStatus();
      if (fs.connection.connected) void fs.connection.request("fs.unwatch", { watchId }).catch(() => undefined);
    }
  };
  if (!fs.connection.connected) throw fs.notConnected();
  void fs.connection.request("fs.watch", { watchId, path: fs.toBox(dir), recursive: false }).catch((error: unknown) =>
    fail(error instanceof Error ? error : new Error("The box could not watch the folder."))
  );
  return handle;
}

export interface BoxAwareSecretFileIo {
  files: Pick<SecretFilesFileOps, "readCloneFile" | "writeCloneFile" | "scanCandidates" | "trackedPaths">;
  watch: SecretFilesWatchFn;
  dirIdentity: SecretFilesDirIdentityFn;
}

/**
 * The secret-files service's disk operations, each routed by its clone (or
 * directory) path: the host helpers for host projects, the box versions above
 * for box projects. A box that is not usable reads as `unreadable`, refuses
 * writes, and has no watches (the reconcile pass re-arms them once it is back).
 */
export function boxAwareSecretFileIo(boxes: () => BoxRegistry | undefined): BoxAwareSecretFileIo {
  const boxFs = (path: string): BoxProjectFs | null => {
    const location = locateProjectFs(boxes(), path);
    return location.kind === "box" ? location.fs : null;
  };
  return {
    files: {
      readCloneFile: async (cloneRoot, relPath) => {
        let fs: BoxProjectFs | null;
        try {
          fs = boxFs(cloneRoot);
        } catch (error) {
          if (error instanceof BoxFsUnavailableError) return { kind: "refused", refusal: "unreadable" };
          throw error;
        }
        return fs ? readBoxCloneFile(fs, cloneRoot, relPath) : readCloneFile(cloneRoot, relPath);
      },
      writeCloneFile: async (cloneRoot, relPath, content, mode, options) => {
        const fs = boxFs(cloneRoot);
        return fs ? writeBoxCloneFile(fs, cloneRoot, relPath, content, mode, options) : writeCloneFile(cloneRoot, relPath, content, mode, options);
      },
      scanCandidates: async (cloneRoot, signal) => {
        let fs: BoxProjectFs | null;
        try {
          fs = boxFs(cloneRoot);
        } catch (error) {
          if (error instanceof BoxFsUnavailableError) return [];
          throw error;
        }
        return scanCandidates(cloneRoot, fs ? boxGitRunner(fs) : defaultGitRunner, signal);
      },
      trackedPaths: async (cloneRoot, relPaths, signal) => {
        const fs = boxFs(cloneRoot);
        return trackedPaths(cloneRoot, relPaths, fs ? boxGitRunner(fs) : defaultGitRunner, signal);
      }
    },
    watch: (dir, onChange, onError) => {
      const fs = boxFs(dir);
      return fs ? watchBoxDir(fs, dir, onChange, onError) : defaultWatch(dir, onChange, onError);
    },
    dirIdentity: async (dir) => {
      let fs: BoxProjectFs | null;
      try {
        fs = boxFs(dir);
      } catch {
        return null;
      }
      if (!fs) return defaultDirIdentity(dir);
      const stats = await fs.stat(dir).catch(() => null);
      if (stats?.kind !== "dir") return null;
      // A box that reports no inode (Windows): one stable value, so the watch stays armed; a
      // replaced directory is then noticed by the reconcile pass instead.
      return stats.identity ?? `box:${fs.boxId}`;
    }
  };
}
