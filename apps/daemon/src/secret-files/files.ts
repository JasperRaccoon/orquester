import type { SecretFileCompare, SecretFileRefusal } from "@orquester/api";

/**
 * Secret files on disk and their contents (spec §2, §3): path safety inside a
 * clone, the gitignored-candidate scan, reading/writing clone files, and the
 * names-only compare / merge of KEY=VALUE files.
 *
 * INTERFACE STUB — the implementation lands separately; the service builds on
 * exactly these exports.
 */

/** Runs git in a clone (injectable for tests). Resolves stdout; rejects on a non-zero exit. */
export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export type CloneFileRead =
  | { kind: "file"; content: Uint8Array; mode: number; mtimeMs: number }
  /** No file; `parentExists` says whether its directory exists in the clone. */
  | { kind: "missing"; parentExists: boolean }
  | { kind: "refused"; refusal: Exclude<SecretFileRefusal, "tracked"> };

/**
 * Read `relPath` inside `cloneRoot` safely: refuse when the file or ANY parent
 * directory inside the clone is a symlink, when it resolves outside the clone
 * (realpath), when it isn't a regular file, or when it's larger than
 * SECRET_FILE_MAX_BYTES. The path must already pass `secretFilePathProblem`.
 */
export async function readCloneFile(cloneRoot: string, relPath: string): Promise<CloneFileRead> {
  void cloneRoot;
  void relPath;
  throw new Error("Not implemented.");
}

/**
 * Write `content` to `relPath` inside `cloneRoot` atomically (temp file in the
 * same directory, then rename), keeping `mode` when given (else 0600). Refuses
 * (throws) for the same reasons `readCloneFile` would, and when the parent
 * directory doesn't exist — it never creates directories.
 */
export async function writeCloneFile(cloneRoot: string, relPath: string, content: Uint8Array, mode?: number): Promise<void> {
  void cloneRoot;
  void relPath;
  void content;
  void mode;
  throw new Error("Not implemented.");
}

/**
 * Conventional candidates in one clone: gitignored files named `.env` / `.env.*`
 * (not templates — `isConventionalSecretFileName`), at any depth, via
 * `git ls-files --others --ignored --exclude-standard -z` with glob pathspecs.
 * Git doesn't descend into nested repos/worktrees; `node_modules` is skipped
 * too. Sorted, `/`-separated relative paths. A clone where git fails → [].
 */
export async function scanCandidates(cloneRoot: string, git?: GitRunner): Promise<string[]> {
  void cloneRoot;
  void git;
  throw new Error("Not implemented.");
}

/** The subset of `relPaths` git TRACKS in this clone (`git ls-files -z -- <paths>`). A failing git → empty set. */
export async function trackedPaths(cloneRoot: string, relPaths: readonly string[], git?: GitRunner): Promise<Set<string>> {
  void cloneRoot;
  void relPaths;
  void git;
  throw new Error("Not implemented.");
}

/**
 * Parse dotenv-style KEY=VALUE text (an `export ` prefix, single/double quotes,
 * `#` comments, blank lines; multi-line quoted values may be one value). Null
 * when the text isn't KEY=VALUE (any non-blank, non-comment line without a
 * valid `KEY=`). Keys keep their last assignment.
 */
export function parseEnv(content: Uint8Array): Map<string, string> | null {
  void content;
  throw new Error("Not implemented.");
}

/**
 * Names-only compare of `left` (a clone's copy) against `right` (the vault's):
 * `env` when both parse, else `lines` (added/removed line counts of a line
 * diff), `missing` when a side is null. Never includes values.
 */
export function compareContents(left: Uint8Array | null, right: Uint8Array | null): SecretFileCompare {
  void left;
  void right;
  throw new Error("Not implemented.");
}

/**
 * "Merge all" for env files: `primary`'s text unchanged, then every key it
 * lacks appended (in first-seen order across `others`) with the first value
 * seen. Null when any input isn't KEY=VALUE.
 */
export function mergeEnvContents(primary: Uint8Array, others: readonly Uint8Array[]): Uint8Array | null {
  void primary;
  void others;
  throw new Error("Not implemented.");
}
