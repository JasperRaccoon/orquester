import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { type FileHandle, link, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";

import { assertInsideFsRoot } from "@orquester/config/fs";
import {
  isConventionalSecretFileName,
  isInSecretFileToolFolder,
  SECRET_FILE_MAX_BYTES,
  secretFilePathProblem,
  type SecretFileCompare,
  type SecretFileRefusal,
  type SecretKeyChange
} from "@orquester/api";

/**
 * Secret files on disk and their contents (spec §2, §3): path safety inside a
 * clone, the gitignored-candidate scan, reading/writing clone files, and the
 * names-only compare / merge of KEY=VALUE files.
 *
 * Nothing here logs or returns secret values except `readCloneFile` (the
 * content itself, host-only) and `parseEnv` (host-only, for compare/merge).
 */

/**
 * Runs git in a clone (injectable for tests). Resolves stdout; rejects on a non-zero exit, and when
 * `signal` aborts (the child is killed: the daemon is shutting down).
 */
export type GitRunner = (cwd: string, args: string[], signal?: AbortSignal) => Promise<string>;

/** A refusal that can be decided on disk (`tracked` needs git — see `trackedPaths`). */
export type CloneFileRefusal = Exclude<SecretFileRefusal, "tracked">;

export type CloneFileRead =
  | { kind: "file"; content: Uint8Array; mode: number; mtimeMs: number }
  /** No file; `parentExists` says whether its directory exists in the clone. */
  | { kind: "missing"; parentExists: boolean }
  | { kind: "refused"; refusal: CloneFileRefusal };

/**
 * What `writeCloneFile` throws when it won't write: `refusal` for the
 * `readCloneFile` refusals, `parentMissing` when the parent directory doesn't
 * exist (it never creates directories). The message never quotes content.
 */
export class CloneFileError extends Error {
  readonly refusal?: CloneFileRefusal;
  readonly parentMissing?: true;
  /** A `createOnly` write found a file already there (nothing was written). */
  readonly exists?: true;

  constructor(message: string, detail: { refusal?: CloneFileRefusal; parentMissing?: true; exists?: true }) {
    super(message);
    this.name = "CloneFileError";
    if (detail.refusal) this.refusal = detail.refusal;
    if (detail.parentMissing) this.parentMissing = true;
    if (detail.exists) this.exists = true;
  }
}

export interface WriteCloneFileOptions {
  /**
   * Never replace anything: the file is created only if nothing is at the path when it lands
   * (a hard link of the synced temp file, so it appears whole); otherwise a {@link CloneFileError}
   * with `exists` and nothing written. For automatic copies into a clone that had no file.
   */
  createOnly?: boolean;
  /**
   * The directory the clone root's realpath must stay inside (the workspaces root), checked as
   * part of the write; outside → refused `outside`.
   */
  containedIn?: string;
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;
/** How many times a read retries when the file is swapped between lstat and open. */
const READ_ATTEMPTS = 3;

type Inspected =
  | { kind: "file"; abs: string; parentAbs: string; rootReal: string; stats: Stats }
  | { kind: "missing"; parentExists: boolean; abs: string; parentAbs: string; rootReal: string }
  | { kind: "refused"; refusal: CloneFileRefusal };

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export const UNREADABLE_CODES = new Set(["EACCES", "EPERM", "EIO", "ENAMETOOLONG", "EOVERFLOW", "ENXIO"]);

/** Map an fs error met while resolving a path to a result, or rethrow it. */
function classifyPathError(error: unknown): "missing" | CloneFileRefusal {
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  if (code === "ELOOP") return "symlink";
  if (code && UNREADABLE_CODES.has(code)) return "unreadable";
  throw error;
}

function isInside(rootReal: string, candidate: string): boolean {
  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  return candidate.startsWith(prefix);
}

function assertPath(relPath: string): string[] {
  const problem = secretFilePathProblem(relPath);
  if (problem) throw new Error(`Invalid secret file path: ${problem}`);
  return relPath.split("/");
}

/**
 * Resolve `relPath` component by component from the clone's real root with
 * lstat: no symlink anywhere below the root, every parent a real directory,
 * the final entry a regular file (or absent) whose realpath stays inside.
 *
 * A parent directory below the root that holds a `.git` entry (a nested
 * repository, submodule or linked worktree) is another repository's ground:
 * the path is refused as `outside` — `SecretFileRefusal` has no separate
 * value for it, and it is outside this clone's repository.
 */
async function inspect(cloneRoot: string, relPath: string): Promise<Inspected> {
  const segments = assertPath(relPath);
  let rootReal: string;
  try {
    rootReal = await realpath(cloneRoot);
  } catch (error) {
    const result = classifyPathError(error);
    if (result === "missing") return { kind: "missing", parentExists: false, abs: "", parentAbs: "", rootReal: "" };
    return { kind: "refused", refusal: result };
  }
  let parentAbs = rootReal;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = join(parentAbs, segments[i]!);
    let stats: Stats;
    try {
      stats = await lstat(next);
    } catch (error) {
      const result = classifyPathError(error);
      if (result === "missing") {
        return { kind: "missing", parentExists: false, abs: join(rootReal, ...segments), parentAbs: next, rootReal };
      }
      return { kind: "refused", refusal: result };
    }
    if (stats.isSymbolicLink()) return { kind: "refused", refusal: "symlink" };
    // A parent that is a regular file (or anything else) can't hold the file.
    if (!stats.isDirectory()) {
      return { kind: "missing", parentExists: false, abs: join(rootReal, ...segments), parentAbs: next, rootReal };
    }
    try {
      await lstat(join(next, ".git"));
      return { kind: "refused", refusal: "outside" };
    } catch (error) {
      const result = classifyPathError(error);
      if (result !== "missing") return { kind: "refused", refusal: result };
    }
    parentAbs = next;
  }
  const abs = join(parentAbs, segments[segments.length - 1]!);
  let stats: Stats;
  try {
    stats = await lstat(abs);
  } catch (error) {
    const result = classifyPathError(error);
    if (result === "missing") return { kind: "missing", parentExists: true, abs, parentAbs, rootReal };
    return { kind: "refused", refusal: result };
  }
  if (stats.isSymbolicLink()) return { kind: "refused", refusal: "symlink" };
  if (!stats.isFile()) return { kind: "refused", refusal: "not-a-file" };
  let real: string;
  try {
    real = await realpath(abs);
  } catch (error) {
    const result = classifyPathError(error);
    // Vanished between lstat and realpath: report what is there now.
    if (result === "missing") return { kind: "missing", parentExists: true, abs, parentAbs, rootReal };
    return { kind: "refused", refusal: result };
  }
  if (!isInside(rootReal, real)) return { kind: "refused", refusal: "outside" };
  if (stats.size > SECRET_FILE_MAX_BYTES) return { kind: "refused", refusal: "too-large" };
  return { kind: "file", abs, parentAbs, rootReal, stats };
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/**
 * Read `relPath` inside `cloneRoot` safely: refuse when the file or ANY parent
 * directory inside the clone is a symlink, when it resolves outside the clone
 * (realpath), when it isn't a regular file, or when it's larger than
 * SECRET_FILE_MAX_BYTES. The path must already pass `secretFilePathProblem`
 * (re-checked; a bad path throws).
 *
 * The file is opened with O_NOFOLLOW and the open handle must be the same
 * inode the path walk saw, so a swap between the checks and the read is
 * caught (retried a few times, then `unreadable`).
 */
export async function readCloneFile(cloneRoot: string, relPath: string): Promise<CloneFileRead> {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    const found = await inspect(cloneRoot, relPath);
    if (found.kind === "missing") return { kind: "missing", parentExists: found.parentExists };
    if (found.kind === "refused") return { kind: "refused", refusal: found.refusal };
    const result = await readOpened(found.abs, found.stats);
    if (result !== "changed") return result;
  }
  return { kind: "refused", refusal: "unreadable" };
}

async function readOpened(abs: string, expected: Stats): Promise<CloneFileRead | "changed"> {
  let handle;
  try {
    // O_NONBLOCK: a FIFO swapped in after the lstat must not hang the open.
    handle = await open(abs, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    const result = classifyPathError(error);
    if (result === "missing") return "changed";
    return { kind: "refused", refusal: result };
  }
  try {
    const stats = await handle.stat();
    if (stats.ino !== expected.ino || stats.dev !== expected.dev) return "changed";
    if (!stats.isFile()) return { kind: "refused", refusal: "not-a-file" };
    if (stats.size > SECRET_FILE_MAX_BYTES) return { kind: "refused", refusal: "too-large" };
    // Read at most MAX + 1 bytes whatever the size said: a file growing under us is still capped.
    const chunks: Buffer[] = [];
    let total = 0;
    let chunkSize = Math.min(stats.size, SECRET_FILE_MAX_BYTES) + 1;
    while (total <= SECRET_FILE_MAX_BYTES) {
      const chunk = Buffer.alloc(Math.min(chunkSize, SECRET_FILE_MAX_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      chunkSize = 64 * 1024;
    }
    if (total > SECRET_FILE_MAX_BYTES) return { kind: "refused", refusal: "too-large" };
    return { kind: "file", content: new Uint8Array(Buffer.concat(chunks, total)), mode: stats.mode & 0o777, mtimeMs: stats.mtimeMs };
  } catch (error) {
    const result = classifyPathError(error);
    if (result === "missing") return "changed";
    return { kind: "refused", refusal: result };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export const REFUSAL_MESSAGES: Record<CloneFileRefusal, string> = {
  symlink: "The file or one of its folders is a symbolic link.",
  outside: "The file resolves outside the project folder.",
  "not-a-file": "The path is not a regular file.",
  "too-large": "The file is larger than the secret file limit.",
  unreadable: "The file can't be read."
};

/**
 * Write `content` to `relPath` inside `cloneRoot` atomically (temp file in the
 * same directory, then rename), keeping `mode` when given (else 0600). Refuses
 * (throws a {@link CloneFileError}) for the same reasons `readCloneFile` would,
 * and when the parent directory doesn't exist — it never creates directories.
 * An existing symlink at the target is refused, never followed. See
 * {@link WriteCloneFileOptions} for `createOnly` and `containedIn`.
 */
export async function writeCloneFile(
  cloneRoot: string,
  relPath: string,
  content: Uint8Array,
  mode?: number,
  options: WriteCloneFileOptions = {}
): Promise<void> {
  if (content.byteLength > SECRET_FILE_MAX_BYTES) {
    throw new CloneFileError(REFUSAL_MESSAGES["too-large"], { refusal: "too-large" });
  }
  const found = await inspect(cloneRoot, relPath);
  if (found.kind === "refused") throw new CloneFileError(REFUSAL_MESSAGES[found.refusal], { refusal: found.refusal });
  if (found.kind === "missing" && !found.parentExists) {
    throw new CloneFileError("The file's folder doesn't exist in this project.", { parentMissing: true });
  }
  if (options.containedIn !== undefined) {
    // The clone root itself (its realpath) must sit inside the workspaces root.
    try {
      await assertInsideFsRoot(options.containedIn, found.rootReal);
    } catch {
      throw new CloneFileError(REFUSAL_MESSAGES.outside, { refusal: "outside" });
    }
  }
  if (options.createOnly && found.kind === "file") throw new CloneFileError(EXISTS_MESSAGE, { exists: true });
  const { abs, parentAbs } = found;
  const fileMode = (mode ?? 0o600) & 0o777;
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  const tmp = join(parentAbs, `.${name}.${randomBytes(8).toString("hex")}.orq-tmp`);
  let created = false;
  try {
    const handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, fileMode);
    created = true;
    try {
      // The umask may have narrowed the create mode.
      await handle.chmod(fileMode);
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // A parent swapped for a symlink after the walk would have put the temp file elsewhere.
    const tmpReal = await realpath(tmp);
    if (tmpReal !== tmp || !isInside(found.rootReal, tmpReal)) {
      throw new CloneFileError(REFUSAL_MESSAGES.symlink, { refusal: "symlink" });
    }
    if (options.createOnly) {
      // link() never replaces: whatever appeared at the path since the walk (a file the user just
      // created, a symlink) makes it fail with EEXIST, and the temp file is dropped.
      await createFrom(tmp, abs, content, fileMode);
      await unlink(tmp).catch(() => undefined);
      created = false;
      await syncDir(parentAbs);
      return;
    }
    // Re-check the target right before the rename (rename replaces a link, never follows it).
    const again = await lstat(abs).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    });
    if (again?.isSymbolicLink()) throw new CloneFileError(REFUSAL_MESSAGES.symlink, { refusal: "symlink" });
    if (again && !again.isFile()) throw new CloneFileError(REFUSAL_MESSAGES["not-a-file"], { refusal: "not-a-file" });
    await rename(tmp, abs);
    created = false;
  } catch (error) {
    if (created) await unlink(tmp).catch(() => undefined);
    if (error instanceof CloneFileError) throw error;
    const code = errorCode(error);
    if (code === "ELOOP") throw new CloneFileError(REFUSAL_MESSAGES.symlink, { refusal: "symlink" });
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new CloneFileError("The file's folder doesn't exist in this project.", { parentMissing: true });
    }
    throw error;
  }
  await syncDir(parentAbs);
}

export const EXISTS_MESSAGE = "A file appeared at that path; it was left as it is.";
/** link() failures that mean the filesystem has no hard links (then an O_EXCL create is the fallback). */
const NO_LINK_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"]);

/** The filesystem calls `createFrom` makes that tests replace (to fail a write). */
export interface CreateFromIo {
  link(existingPath: string, newPath: string): Promise<void>;
  /** Fill a file just created: its mode, its content, synced. */
  fill(handle: FileHandle, content: Uint8Array, fileMode: number): Promise<void>;
}

const CREATE_FROM_IO: CreateFromIo = {
  link,
  fill: async (handle, content, fileMode) => {
    await handle.chmod(fileMode);
    await handle.writeFile(content);
    await handle.sync();
  }
};

/**
 * Create `abs` from the synced temp file without replacing anything (see `createOnly`). Without
 * hard links, an exclusive create: if filling it fails, the partial file it created is removed
 * (that file only — never one that replaced it meanwhile).
 */
export async function createFrom(tmp: string, abs: string, content: Uint8Array, fileMode: number, io: CreateFromIo = CREATE_FROM_IO): Promise<void> {
  try {
    await io.link(tmp, abs);
    return;
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new CloneFileError(EXISTS_MESSAGE, { exists: true });
    if (!NO_LINK_CODES.has(errorCode(error) ?? "")) throw error;
  }
  // No hard links here: an exclusive create still never replaces (the content lands non-atomically).
  let handle: FileHandle;
  try {
    handle = await open(abs, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, fileMode);
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new CloneFileError(EXISTS_MESSAGE, { exists: true });
    throw error;
  }
  let created: Stats | null = null;
  try {
    try {
      created = await handle.stat();
      await io.fill(handle, content, fileMode);
    } finally {
      await handle.close();
    }
  } catch (error) {
    const there = await lstat(abs).catch(() => null);
    if (created && there && there.dev === created.dev && there.ino === created.ino) await unlink(abs).catch(() => undefined);
    throw error;
  }
}

/** Durability of a rename / link itself; best effort (not every platform can fsync a directory). */
async function syncDir(dirAbs: string): Promise<void> {
  try {
    const dir = await open(dirAbs, fsConstants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/** `git` with an argument array (no shell), bounded output and time. */
export const defaultGitRunner: GitRunner = async (cwd, args, signal) => {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    ...(signal ? { signal } : {}),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
  });
  return stdout;
};

// The scan's pathspecs. In glob magic a leading `**/` also matches zero
// directories, so these cover the root `.env` too (checked on git 2.43).
const CANDIDATE_PATHSPECS = [":(glob)**/.env", ":(glob)**/.env.*"];

/**
 * Conventional candidates in one clone: gitignored files named `.env` / `.env.*`
 * (not templates — `isConventionalSecretFileName`), at any depth, via
 * `git ls-files --others --ignored --exclude-standard -z` with glob pathspecs.
 * Git doesn't descend into nested repos/worktrees; anything inside an agent-tool
 * folder or `node_modules` (`isInSecretFileToolFolder`) is skipped too — a
 * removed worktree's leftover files have no `.git` to stop git. Sorted, `/`-separated relative paths. A clone where git fails → [].
 */
export async function scanCandidates(cloneRoot: string, git: GitRunner = defaultGitRunner, signal?: AbortSignal): Promise<string[]> {
  let stdout: string;
  try {
    stdout = await git(cloneRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...CANDIDATE_PATHSPECS], signal);
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const entry of stdout.split("\0")) {
    // Nested repositories come back as `dir/`; they are not files.
    if (!entry || entry.endsWith("/")) continue;
    if (secretFilePathProblem(entry) !== null) continue;
    // Agent-tool folders (`.claude/worktrees/…`, even a leftover with no `.git`
    // that git walks like any ignored folder) and node_modules.
    if (isInSecretFileToolFolder(entry)) continue;
    const segments = entry.split("/");
    if (!isConventionalSecretFileName(segments[segments.length - 1]!)) continue;
    found.add(entry);
  }
  return [...found].sort(compareStrings);
}

/**
 * The subset of `relPaths` git TRACKS in this clone (`git ls-files -z -- <paths>`,
 * each a `:(literal)` pathspec so glob characters in names stay literal).
 * Output is relative to `cloneRoot` (no `--full-name`), so it matches
 * `relPaths` even when the clone root is below the repo's top level.
 * A failing (or aborted) git REJECTS: "nothing tracked" can't be told from
 * "git didn't answer", and a caller must not write on a guess.
 */
export async function trackedPaths(
  cloneRoot: string,
  relPaths: readonly string[],
  git: GitRunner = defaultGitRunner,
  signal?: AbortSignal
): Promise<Set<string>> {
  const tracked = new Set<string>();
  if (relPaths.length === 0) return tracked;
  const wanted = new Set(relPaths);
  const stdout = await git(cloneRoot, ["ls-files", "-z", "--", ...[...wanted].map((path) => `:(literal)${path}`)], signal);
  for (const entry of stdout.split("\0")) {
    // A directory path lists the files under it; only exact matches count.
    if (entry && wanted.has(entry)) tracked.add(entry);
  }
  return tracked;
}

// ---------------------------------------------------------------------------
// Env parsing (hand scanner: linear on any input, no regex over the text)
// ---------------------------------------------------------------------------

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const utf8Lenient = new TextDecoder("utf-8");

function isKeyStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; // A-Z a-z _
}

function isKeyChar(c: number): boolean {
  return isKeyStart(c) || (c >= 48 && c <= 57) || c === 46 || c === 45; // 0-9 . -
}

const SPACE = 32;
const TAB = 9;
const LF = 10;
const CR = 13;
const HASH = 35;
const EQUALS = 61;
const DQUOTE = 34;
const SQUOTE = 39;
const BACKTICK = 96;
const BACKSLASH = 92;

function isBlank(c: number): boolean {
  return c === SPACE || c === TAB || c === CR;
}

/**
 * Parse dotenv-style KEY=VALUE text (an `export ` prefix, single/double quotes,
 * `#` comments, blank lines; multi-line quoted values are one value). Null
 * when the text isn't KEY=VALUE (any non-blank, non-comment line without a
 * valid `KEY=`), or isn't valid UTF-8. Keys keep their last assignment.
 *
 * Values: unquoted ones are trimmed and end at a `#` that starts the value or
 * follows whitespace; `'…'` and `` `…` `` are literal; `"…"` understands
 * `\n \r \t \" \\` (any other backslash stays as written). After a closing
 * quote only whitespace or a `#` comment may follow.
 */
export function parseEnv(content: Uint8Array): Map<string, string> | null {
  let text: string;
  try {
    text = utf8Strict.decode(content);
  } catch {
    return null;
  }
  const out = new Map<string, string>();
  const n = text.length;
  let i = 0;
  while (i < n) {
    // Line start: skip indentation.
    while (i < n && isBlank(text.charCodeAt(i))) i++;
    if (i >= n) break;
    let c = text.charCodeAt(i);
    if (c === LF) {
      i++;
      continue;
    }
    if (c === HASH) {
      while (i < n && text.charCodeAt(i) !== LF) i++;
      continue;
    }
    // Optional `export ` prefix (`export=1` is a key named export).
    if (text.startsWith("export", i)) {
      const after = text.charCodeAt(i + 6);
      if (after === SPACE || after === TAB) {
        let j = i + 6;
        while (j < n && (text.charCodeAt(j) === SPACE || text.charCodeAt(j) === TAB)) j++;
        // `export = 1` assigns a key named export.
        if (j < n && text.charCodeAt(j) !== EQUALS) i = j;
      }
    }
    // Key.
    const keyStart = i;
    if (i >= n || !isKeyStart(text.charCodeAt(i))) return null;
    i++;
    while (i < n && isKeyChar(text.charCodeAt(i))) i++;
    const key = text.slice(keyStart, i);
    while (i < n && (text.charCodeAt(i) === SPACE || text.charCodeAt(i) === TAB)) i++;
    if (i >= n || text.charCodeAt(i) !== EQUALS) return null;
    i++;
    while (i < n && (text.charCodeAt(i) === SPACE || text.charCodeAt(i) === TAB)) i++;
    // Value.
    c = i < n ? text.charCodeAt(i) : LF;
    let value: string;
    if (c === SQUOTE || c === BACKTICK) {
      const close = text.indexOf(c === SQUOTE ? "'" : "`", i + 1);
      if (close < 0) return null;
      value = text.slice(i + 1, close);
      i = close + 1;
      const end = afterQuoted(text, i);
      if (end < 0) return null;
      i = end;
    } else if (c === DQUOTE) {
      const parts: string[] = [];
      let runStart = i + 1;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === DQUOTE) {
          closed = true;
          break;
        }
        if (d === BACKSLASH && j + 1 < n) {
          parts.push(text.slice(runStart, j));
          const e = text.charCodeAt(j + 1);
          if (e === 110) parts.push("\n"); // n
          else if (e === 114) parts.push("\r"); // r
          else if (e === 116) parts.push("\t"); // t
          else if (e === DQUOTE) parts.push('"');
          else if (e === BACKSLASH) parts.push("\\");
          else parts.push(text.slice(j, j + 2));
          j += 2;
          runStart = j;
          continue;
        }
        j++;
      }
      if (!closed) return null;
      parts.push(text.slice(runStart, j));
      value = parts.join("");
      const end = afterQuoted(text, j + 1);
      if (end < 0) return null;
      i = end;
    } else {
      // Unquoted: to the end of the line, cut at a `#` that starts the value or follows whitespace.
      let j = i;
      let cut = -1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === LF) break;
        if (cut < 0 && d === HASH && (j === i || isBlank(text.charCodeAt(j - 1)))) cut = j;
        j++;
      }
      value = text.slice(i, cut < 0 ? j : cut).trim();
      i = j;
    }
    // A reassigned key keeps its first position and takes the last value.
    out.set(key, value);
  }
  return out;
}

/** After a closing quote: blanks, then end of line / text or a `#` comment. Returns the index of the line end, or -1. */
function afterQuoted(text: string, from: number): number {
  const n = text.length;
  let i = from;
  while (i < n && isBlank(text.charCodeAt(i))) i++;
  if (i >= n || text.charCodeAt(i) === LF) return i;
  if (text.charCodeAt(i) !== HASH) return -1;
  while (i < n && text.charCodeAt(i) !== LF) i++;
  return i;
}

// ---------------------------------------------------------------------------
// Compare (names only)
// ---------------------------------------------------------------------------

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Above this many lines on either side (after trimming the common ends), lines are compared as multisets. */
const DIFF_MAX_LINES = 5000;
/** Work budget for the Myers pass (snake steps + diagonals); past it, fall back to multisets. */
const DIFF_MAX_WORK = 5_000_000;

function splitLines(content: Uint8Array): string[] {
  if (content.byteLength === 0) return [];
  const text = utf8Lenient.decode(content);
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/**
 * Line counts of a diff from `a` (left) to `b` (right): `added` = lines only
 * in `a`, `removed` = lines only in `b`. Exact (LCS via Myers) when the
 * differing middle is small enough; otherwise an order-blind multiset count,
 * which never takes more than linear time.
 */
function lineDiffCounts(a: readonly string[], b: readonly string[]): { added: number; removed: number } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) return { added: n, removed: m };
  // Lines → small integers, so the inner loop compares numbers.
  const ids = new Map<string, number>();
  const x = new Int32Array(n);
  const y = new Int32Array(m);
  for (let i = 0; i < n; i++) x[i] = internLine(ids, a[start + i]!);
  for (let i = 0; i < m; i++) y[i] = internLine(ids, b[start + i]!);
  if (n <= DIFF_MAX_LINES && m <= DIFF_MAX_LINES) {
    const d = myersDistance(x, y, DIFF_MAX_WORK);
    if (d >= 0) {
      const lcs = (n + m - d) / 2;
      return { added: n - lcs, removed: m - lcs };
    }
  }
  return multisetCounts(x, y, ids.size);
}

function internLine(ids: Map<string, number>, line: string): number {
  let id = ids.get(line);
  if (id === undefined) {
    id = ids.size;
    ids.set(line, id);
  }
  return id;
}

/** Shortest edit distance (inserts + deletes), or -1 when it would cost more than `budget` steps. */
function myersDistance(a: Int32Array, b: Int32Array, budget: number): number {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  let work = 0;
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let xPos: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) xPos = v[offset + k + 1]!;
      else xPos = v[offset + k - 1]! + 1;
      let yPos = xPos - k;
      while (xPos < n && yPos < m && a[xPos] === b[yPos]) {
        xPos++;
        yPos++;
        work++;
      }
      v[offset + k] = xPos;
      if (xPos >= n && yPos >= m) return d;
      work++;
    }
    if (work > budget) return -1;
  }
  return max;
}

function multisetCounts(a: Int32Array, b: Int32Array, distinct: number): { added: number; removed: number } {
  const balance = new Int32Array(distinct);
  for (let i = 0; i < a.length; i++) balance[a[i]!]!++;
  for (let i = 0; i < b.length; i++) balance[b[i]!]!--;
  let added = 0;
  let removed = 0;
  for (let i = 0; i < distinct; i++) {
    const count = balance[i]!;
    if (count > 0) added += count;
    else removed -= count;
  }
  return { added, removed };
}

/**
 * Names-only compare of `left` (a clone's copy) against `right` (the vault's):
 * `env` when both parse, else `lines` (added/removed line counts of a line
 * diff), `missing` when a side is null (`left` first). Never includes values.
 */
export function compareContents(left: Uint8Array | null, right: Uint8Array | null): SecretFileCompare {
  if (left === null) return { format: "missing", side: "left" };
  if (right === null) return { format: "missing", side: "right" };
  const leftEnv = parseEnv(left);
  const rightEnv = leftEnv ? parseEnv(right) : null;
  if (leftEnv && rightEnv) {
    const keys = new Set([...leftEnv.keys(), ...rightEnv.keys()]);
    return {
      format: "env",
      keys: [...keys].sort(compareStrings).map((key) => {
        let change: SecretKeyChange;
        if (!rightEnv.has(key)) change = "added";
        else if (!leftEnv.has(key)) change = "removed";
        else change = leftEnv.get(key) === rightEnv.get(key) ? "same" : "changed";
        return { key, change };
      })
    };
  }
  const { added, removed } = lineDiffCounts(splitLines(left), splitLines(right));
  return { format: "lines", linesAdded: added, linesRemoved: removed };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** Values written as-is: nothing a parse would trim, cut at `#`, or read as a quote. */
function isPlainValueChar(c: number): boolean {
  return (
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 95 || // _
    c === 45 || // -
    c === 46 || // .
    c === 47 || // /
    c === 58 || // :
    c === 64 || // @
    c === 37 || // %
    c === 43 || // +
    c === 44 || // ,
    c === 61 // =
  );
}

/**
 * A value in a form `parseEnv` reads back exactly, as portable as the value allows:
 * - as-is when every character is plain;
 * - else `'…'` when it has no `'` and no line break: literal for every dotenv reader and the
 *   shell (no escapes, no `$` expansion);
 * - else `"…"`, escaping only what this value needs: line breaks as `\n` / `\r` (widely
 *   understood), and `\` / `"` as `\\` / `\"` — those two are NOT read alike by every tool
 *   (some keep the backslash), so they are only used when the value holds a `'` or a line break
 *   AND a backslash or double quote. Inside `"…"` some tools also expand `$VAR`.
 */
function formatEnvValue(value: string): string {
  let plain = true;
  for (let i = 0; i < value.length && plain; i++) plain = isPlainValueChar(value.charCodeAt(i));
  if (plain) return value;
  if (!value.includes("'") && !value.includes("\n") && !value.includes("\r")) return `'${value}'`;
  let out = '"';
  for (const ch of value) {
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else out += ch;
  }
  return out + '"';
}

/**
 * "Merge all" for env files: `primary`'s bytes unchanged, then every key it
 * lacks appended as `KEY=value` (in first-seen order across `others`) with the
 * first value seen, quoted so a re-parse yields the same value. Null when any
 * input isn't KEY=VALUE.
 */
export function mergeEnvContents(primary: Uint8Array, others: readonly Uint8Array[]): Uint8Array | null {
  const primaryEnv = parseEnv(primary);
  if (!primaryEnv) return null;
  const additions = new Map<string, string>();
  for (const other of others) {
    const env = parseEnv(other);
    if (!env) return null;
    for (const [key, value] of env) {
      if (!primaryEnv.has(key) && !additions.has(key)) additions.set(key, value);
    }
  }
  if (additions.size === 0) return new Uint8Array(primary);
  let tail = primary.byteLength > 0 && primary[primary.byteLength - 1] !== LF ? "\n" : "";
  for (const [key, value] of additions) tail += `${key}=${formatEnvValue(value)}\n`;
  const tailBytes = new TextEncoder().encode(tail);
  const out = new Uint8Array(primary.byteLength + tailBytes.byteLength);
  out.set(primary, 0);
  out.set(tailBytes, primary.byteLength);
  return out;
}
