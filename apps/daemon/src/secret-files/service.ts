/**
 * The secret-files sync engine (spec docs/superpowers/specs/2026-10-19-secret-files-plugin-design.md
 * §3–§6): one vault per (workspace, repoKey), the per-clone file states of §4, the automatic copy /
 * update actions, Push / Reset, the setup scan, the watchers and the reconcile pass.
 *
 * Invariants:
 *
 * - **Nothing secret leaves this module.** Contents, content hashes and values stay in memory for the
 *   one operation that needs them; the wire carries paths, opaque version ids, timestamps, states,
 *   names-only compares and content TOKENS (an HMAC with a per-process random key over the clone, the
 *   path and the content hash: equal content in one clone gives one token, nothing can be learned
 *   from it, and it dies with the process). Errors and log lines name files and projects, never content.
 * - **Revisions.** Every detail the service returns or publishes carries `{ boot, seq }`: `boot` is
 *   random per process, `seq` grows (across all vaults) each time a vault's detail changes — clone
 *   states and tokens included — so a client keeps the newest.
 * - **Expect.** Push / Reset with `expect` compare each named file's token, inside the vault's queue,
 *   with the copy actually about to be pushed or overwritten: a mismatch is 409 CONTENT_CHANGED and
 *   nothing is written. The evaluation an action makes becomes the vault's current one (published
 *   when it changed) before the action may refuse, so a refetch after a 409 shows the new tokens.
 *   Reset also re-reads each copy right before overwriting it (a missing one is created, never
 *   replaced): a copy that changed since the evaluation is left as it is (CONTENT_CHANGED).
 * - **One queue per vault.** Every operation on a vault — a route, a watcher check, a reconcile —
 *   runs in that vault's promise chain, so writes to its clones and to its record never interleave.
 *   A failing operation does not break the chain.
 * - **Clones** are the non-archived projects of the vault's workspace whose `repoKey` matches
 *   (projects of an archived workspace count as archived). An archived clone keeps its baselines;
 *   a clone that is no longer listed with that repo at all is marked unlisted and its baselines are
 *   pruned only after a grace period (UNLISTED_CLONE_GRACE_MS), so one that comes back in time keeps
 *   its `deleted` files flagged rather than copied back in.
 * - **Automatic actions only while the plugin is on and the store is writable:** a `missing` file is
 *   copied in (create-only: never over a file that appeared meanwhile), an `outdated` one updated
 *   (re-read right before the write, so an edit made meanwhile is never overwritten), and a `synced`
 *   clone's baseline is stamped. `modified`, `deleted`, `missing-dir` and `refused` files are never
 *   touched. Every clone write also checks the clone root's realpath stays inside the workspaces root.
 * - **Tracked check fails closed:** when git can't answer, the clone keeps its last answer; a path
 *   git never answered for is `refused: unreadable` there (never written) until it does. Such a
 *   clone is asked again by its next check once TRACKED_RETRY_MS has passed (not only by the next
 *   full pass).
 * - **Plugin off:** no watcher, no timer, no write — also checked before each write of a pass already
 *   running. Mutations answer 409 `SECRET_FILES_DISABLED`; reads (list, vault, candidates, compare)
 *   still answer, evaluated fresh without any automatic action and without rewriting vaults.json,
 *   so Settings can show the vaults that exist.
 * - **Shutdown:** `stop()` returns at once — watchers, timers and git children stop/are killed;
 *   `idle()` (awaited last, bounded) lets an operation already in flight finish.
 * - **Self-writes settle on their own:** a write the service makes fires the clone's watcher; the
 *   debounced check re-hashes the clone, finds it `synced`, and changes nothing — no event, no write.
 * - **Events** (`SECRET_FILES_CHANGED`) go out only when a vault's serialized detail changed.
 * - **No git on the hot path:** `trackedPaths` and `scanCandidates` run on full reconcile passes,
 *   operations and reads that need them, and for a clone git hasn't answered for yet (first seen,
 *   or failed: then at most once per TRACKED_RETRY_MS) — never otherwise on a watcher check.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import { setMaxListeners } from "node:events";
import { watch as fsWatch } from "node:fs";
import { realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import {
  SECRET_FILE_HISTORY_MAX,
  SECRET_FILES_MAX_PER_VAULT,
  isConventionalSecretFileName,
  repoKeyProblem,
  secretFileNeedsAttention,
  isInSecretFileToolFolder,
  secretFilePathProblem,
  type SecretFileCandidate,
  type SecretFileCandidatesResponse,
  type SecretFileCloneState,
  type SecretFileCompare,
  type SecretFileCompareResponse,
  type SecretFileRefusal,
  type SecretFileSource,
  type SecretFileState,
  type SecretFileUpdatedBy,
  type SecretFileVariant,
  type SecretFilesChangedPayload,
  type SecretFilesClone,
  type SecretFilesErrorCode,
  type SecretVaultDetail,
  type SecretVaultRevision,
  type SecretVaultSummary,
  type SecretVaultsResponse
} from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";
import { isValidName } from "@orquester/config";
import {
  CloneFileError,
  type CloneFileRead,
  compareContents,
  defaultGitRunner,
  mergeEnvContents,
  parseEnv,
  readCloneFile,
  scanCandidates,
  trackedPaths,
  type WriteCloneFileOptions,
  writeCloneFile
} from "./files.ts";
import { SecretVaultStoreError, type SecretVaultStore, type VaultFileRecord, type VaultRecord } from "./vault-store.ts";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** One project as the workspace listing has it (`ProjectSummary` fields the service reads). */
export interface SecretFilesProject {
  workspace: string;
  name: string;
  /** `ProjectSummary.path` — the clone key in the vault record. */
  path: string;
  repoKey?: string;
  isArchived?: boolean;
}

/** The vault store's surface the service uses (the real {@link SecretVaultStore}, or a test fake). */
export type SecretVaultStoreLike = Pick<SecretVaultStore, "writable" | "list" | "get" | "update" | "readContent">;

/** Clone I/O, supplied by host helpers or the box-aware transport. */
export interface SecretFilesFileOps {
  readCloneFile(cloneRoot: string, relPath: string): Promise<CloneFileRead>;
  writeCloneFile(cloneRoot: string, relPath: string, content: Uint8Array, mode?: number, options?: WriteCloneFileOptions): Promise<void>;
  /** `signal` aborts the git run (shutdown). */
  scanCandidates(cloneRoot: string, signal?: AbortSignal): Promise<string[]>;
  /** Rejects when git fails or `signal` aborts: never "nothing tracked" on a guess. */
  trackedPaths(cloneRoot: string, relPaths: readonly string[], signal?: AbortSignal): Promise<Set<string>>;
}

const DEFAULT_FILE_OPS: SecretFilesFileOps = {
  readCloneFile,
  writeCloneFile,
  scanCandidates: (cloneRoot, signal) => scanCandidates(cloneRoot, defaultGitRunner, signal),
  trackedPaths: (cloneRoot, relPaths, signal) => trackedPaths(cloneRoot, relPaths, defaultGitRunner, signal)
};

/** An open directory watch; `close()` is idempotent. */
export interface SecretFilesWatchHandle {
  close(): void;
}

/**
 * Watch one existing directory, non-recursively. `onChange` gets the entry name the event is about
 * (null when the platform doesn't say). May throw synchronously (ENOENT, ENOSPC).
 */
export type SecretFilesWatchFn = (
  dir: string,
  onChange: (filename: string | null) => void,
  onError: (error: Error) => void
) => SecretFilesWatchHandle;

export const defaultWatch: SecretFilesWatchFn = (dir, onChange, onError) => {
  const watcher = fsWatch(dir, { persistent: false }, (_event, filename) => onChange(filename === null ? null : String(filename)));
  watcher.on("error", onError);
  return {
    close: () => {
      try {
        watcher.close();
      } catch {
        // already closed
      }
    }
  };
};

/** A watched directory's identity (device + inode), or null when it isn't a directory now. */
export type SecretFilesDirIdentityFn = (dir: string) => Promise<string | null>;

export const defaultDirIdentity: SecretFilesDirIdentityFn = async (dir) => {
  try {
    const stats = await fsStat(dir);
    return stats.isDirectory() ? `${stats.dev}:${stats.ino}` : null;
  } catch {
    return null;
  }
};

/** Timers (injectable: tests fire them by hand). The defaults never keep the daemon alive. */
export interface SecretFilesTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: SecretFilesTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
};

export interface SecretFilesLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface SecretFilesServiceOptions {
  store: SecretVaultStoreLike;
  /** Every workspace's projects, archived ones flagged (a project of an archived workspace counts as archived). */
  listProjects: () => Promise<SecretFilesProject[]>;
  /** Whether the "Secret files" plugin is on now. */
  pluginEnabled: () => Promise<boolean> | boolean;
  /** Subscribe to plugin state changes (called with the plugin's `enabled`); returns the unsubscribe. */
  onPluginChange: (listener: (enabled: boolean) => void) => () => void;
  /** Where `SECRET_FILES_CHANGED` payloads go (the broadcaster). */
  publish: (payload: SecretFilesChangedPayload) => void;
  files?: Partial<SecretFilesFileOps>;
  watch?: SecretFilesWatchFn;
  dirIdentity?: SecretFilesDirIdentityFn;
  /**
   * The workspaces root, read per write (it can move): a clone root whose realpath is not inside
   * it is never written to. Absent: no such check (tests).
   */
  workspacesRoot?: () => string;
  /** How long an unlisted clone keeps its baselines before they are pruned (default 7 days). */
  unlistedGraceMs?: number;
  timers?: SecretFilesTimers;
  now?: () => Date;
  realpath?: (path: string) => Promise<string>;
  logger?: SecretFilesLogger;
  /** Per-clone watcher debounce (spec §5: 500 ms). */
  debounceMs?: number;
  /** Debounce of the reconcile a projects listing asks for. */
  listDebounceMs?: number;
  /** The safety-net reconcile interval (spec §5: 5 minutes). */
  intervalMs?: number;
}

// ---------------------------------------------------------------------------
// Errors and callers
// ---------------------------------------------------------------------------

const STATUS: Record<SecretFilesErrorCode, number> = {
  SECRET_FILES_DISABLED: 409,
  INVALID_REQUEST: 400,
  INVALID_PATH: 400,
  INVALID_CLONE: 400,
  VAULT_NOT_FOUND: 404,
  FILE_NOT_MANAGED: 400,
  FILE_REFUSED: 409,
  SOURCE_MISSING: 409,
  NOT_ENV_FORMAT: 400,
  TOO_MANY_FILES: 400,
  NOTHING_TO_PUSH: 409,
  CONTENT_CHANGED: 409,
  SECRET_FILES_UNAVAILABLE: 503,
  SECRET_FILES_ERROR: 500
};

/** A refusal with its contract status. The message names files and projects, never content. */
export class SecretFilesError extends Error {
  readonly status: number;
  constructor(
    readonly code: SecretFilesErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SecretFilesError";
    this.status = STATUS[code];
  }
}

/**
 * Any thrown value as a {@link SecretFilesError}. A store error keeps its code with a fixed message;
 * anything else is a 500 with a fixed message (its own message may say anything, so it is not sent).
 */
export function toSecretFilesError(error: unknown): SecretFilesError {
  if (error instanceof SecretFilesError) return error;
  if (error instanceof SecretVaultStoreError) {
    return error.code === "SECRET_FILES_UNAVAILABLE"
      ? new SecretFilesError("SECRET_FILES_UNAVAILABLE", "The secret files vault could not be read; changes are refused.")
      : new SecretFilesError("SECRET_FILES_ERROR", "The secret files vault failed.");
  }
  return new SecretFilesError("SECRET_FILES_ERROR", "The secret files operation failed.");
}

/** Who a version is stamped with. */
export type SecretFilesActor = { kind: "user" } | { kind: "agent"; threadId: string };

/** The request's principal as an actor: an in-chat agent is itself; everyone else acts as the user. */
export function actorOf(principal: CallerPrincipal | null | undefined): SecretFilesActor {
  return principal?.kind === "agent" ? { kind: "agent", threadId: principal.threadId } : { kind: "user" };
}

function updatedByOf(actor: SecretFilesActor, projectName: string): SecretFileUpdatedBy {
  return actor.kind === "agent" ? { kind: "agent", threadId: actor.threadId, projectName } : { kind: "user", projectName };
}

// ---------------------------------------------------------------------------
// States (spec §4)
// ---------------------------------------------------------------------------

/** One managed file in one clone, as last evaluated. `sha256`/`mode` are host-only. */
interface FileEval {
  path: string;
  state: SecretFileState;
  refusal?: SecretFileRefusal;
  sha256?: string;
  mode?: number;
}

export function sha256Of(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * The §4 state of one clone file: `read` is the clone's copy (already known not to be tracked),
 * `baselineId` the vault version that clone last had. A missing file whose directory is gone is
 * `missing-dir` whether or not it had a baseline (nothing can be restored there).
 */
export function cloneFileState(
  file: VaultFileRecord,
  read: CloneFileRead,
  baselineId: string | undefined,
  hash?: string
): { state: SecretFileState; refusal?: SecretFileRefusal } {
  if (read.kind === "refused") return { state: "refused", refusal: read.refusal };
  if (read.kind === "missing") {
    if (!read.parentExists) return { state: "missing-dir" };
    return { state: baselineId === undefined ? "missing" : "deleted" };
  }
  const current = file.versions[0];
  const sha = hash ?? sha256Of(read.content);
  if (current && sha === current.sha256) return { state: "synced" };
  // A baseline evicted from the history is unknown: the copy can't be proven untouched.
  const baseline = baselineId === undefined ? undefined : file.versions.find((version) => version.id === baselineId);
  if (baseline && current && baseline.id !== current.id && baseline.sha256 === sha) return { state: "outdated" };
  return { state: "modified" };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const LIST_MAX = 200;

function invalid(message: string): SecretFilesError {
  return new SecretFilesError("INVALID_REQUEST", message);
}

function vaultIdOf(workspace: unknown, repoKey: unknown): { workspace: string; repoKey: string } {
  if (typeof workspace !== "string" || !isValidName(workspace)) throw invalid("Invalid workspace name.");
  const problem = repoKeyProblem(repoKey);
  if (problem) throw invalid(problem);
  return { workspace, repoKey: repoKey as string };
}

function pathOf(path: unknown): string {
  const problem = secretFilePathProblem(path);
  if (problem) throw new SecretFilesError("INVALID_PATH", problem);
  return path as string;
}

/** A path being ADDED (setup, add, a hand-typed scan): also never inside an agent-tool folder. Removing such a path still works (`pathOf`). */
function newPathOf(path: unknown): string {
  const valid = pathOf(path);
  if (isInSecretFileToolFolder(valid)) {
    throw new SecretFilesError("INVALID_PATH", "Files inside agent tool folders (like .claude/worktrees) or node_modules can't be synced.");
  }
  return valid;
}

function pathListOf(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > LIST_MAX) throw invalid(`${field} must be a list of at most ${LIST_MAX} paths.`);
  return [...new Set(value.map(pathOf))];
}

function sourceOf(value: unknown): SecretFileSource {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("Each file needs a source.");
  const record = value as Record<string, unknown>;
  if (record.merge === true) {
    if (typeof record.primary !== "string" || record.primary.length === 0) throw invalid("A merged source needs a primary project.");
    return { merge: true, primary: record.primary };
  }
  if (typeof record.projectPath !== "string" || record.projectPath.length === 0) throw invalid("A source needs a project.");
  return { projectPath: record.projectPath };
}

function fileSourcesOf(value: unknown, field: string, required: boolean): Array<{ path: string; source: SecretFileSource }> | undefined {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || value.length > LIST_MAX) throw invalid(`${field} must be a list of at most ${LIST_MAX} files.`);
  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw invalid(`Each entry of ${field} needs a path and a source.`);
    const record = entry as Record<string, unknown>;
    const path = newPathOf(record.path);
    if (seen.has(path)) throw invalid(`${path} is listed twice.`);
    seen.add(path);
    return { path, source: sourceOf(record.source) };
  });
}

function bodyOf(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function disjoint(lists: Array<readonly string[] | undefined>): void {
  const seen = new Set<string>();
  for (const list of lists) {
    for (const path of list ?? []) {
      if (seen.has(path)) throw invalid(`${path} is listed under more than one change.`);
      seen.add(path);
    }
  }
}

/** `SecretFilesCloneRequest.expect`: path → the content token the caller saw (null: no copy). */
function expectOf(value: unknown): Map<string, string | null> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("expect must map file paths to content tokens.");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > LIST_MAX) throw invalid(`expect may name at most ${LIST_MAX} files.`);
  const out = new Map<string, string | null>();
  for (const [path, token] of entries) {
    if (token !== null && (typeof token !== "string" || token.length === 0 || token.length > 200)) {
      throw invalid("Each expected content token must be a token or null.");
    }
    out.set(pathOf(path), token);
  }
  return out;
}

const REFUSAL_TEXT: Record<SecretFileRefusal, string> = {
  tracked: "is tracked by git",
  symlink: "is a symlink or sits under one",
  outside: "resolves outside the project",
  "not-a-file": "is not a regular file",
  "too-large": "is too large",
  unreadable: "can't be read"
};

// ---------------------------------------------------------------------------
// Runtime state per vault
// ---------------------------------------------------------------------------

interface DirWatch {
  handle: SecretFilesWatchHandle | null;
  /** The watched directory's identity when it was armed: a different one now means it was replaced. */
  identity: string | null;
  /** Entry names in this dir that matter (managed names; at the root also every path's first segment). */
  names: Set<string>;
}

/**
 * What git last said about a clone's managed paths: `tracked` among `checked`. A path not in
 * `checked` (git failed before it was ever asked about it) is unknown, and an unknown path is
 * refused `unreadable` — never written — until git answers. A failing git keeps the last answer.
 */
interface TrackedState {
  tracked: Set<string>;
  checked: Set<string>;
}

/** What a clone git never answered for (no known paths) is treated as: every path unknown. */
const NOTHING_KNOWN: TrackedState = { tracked: new Set(), checked: new Set() };

interface CloneWatch {
  dirs: Map<string, DirWatch>;
  timer: unknown;
}

interface VaultRuntime {
  workspace: string;
  repoKey: string;
  queue: Promise<void>;
  /** The vault's clones as last listed. */
  clones: SecretFilesProject[];
  /** clone path → managed path → state; null: not evaluated (or stale: plugin off). */
  evals: Map<string, Map<string, FileEval>> | null;
  /** Per clone: the managed paths git tracks there (refreshed on full passes). */
  tracked: Map<string, TrackedState>;
  /** Per clone: when git last failed to tell what is tracked there (ms; cleared when it answers). */
  trackedFailedAt: Map<string, number>;
  /** Per clone: its conventional candidates (refreshed on full passes and scans). */
  candidates: Map<string, string[]>;
  /** The last detail published (serialized, without its revision), null before any. */
  lastPublished: string | null;
  /** The revision of that detail. */
  revision: SecretVaultRevision | null;
  watches: Map<string, CloneWatch>;
  /** Operations queued or running; at 0 a runtime whose vault doesn't exist is forgotten. */
  pending: number;
}

interface RefreshOptions {
  /** A fresh listing (sets the clones, allows pruning); absent: the last one. */
  projects?: SecretFilesProject[];
  /** Only this clone (a watcher check). */
  only?: string;
  /** Re-run the candidate scan / tracked check for every clone (else only for clones without one). */
  scan: boolean;
  git: boolean;
  /** Apply §4's automatic actions (only while enabled and writable). */
  auto: boolean;
}

const RESETTABLE: readonly SecretFileState[] = ["modified", "deleted", "outdated", "missing"];

/**
 * An unlisted clone (no longer a project of the vault's repo in its workspace — moved, renamed,
 * removed, or a listing that briefly missed it) keeps its baselines this long before they are
 * pruned. Within it, a clone that comes back still has them: a file it had deleted stays
 * `deleted` (flagged) instead of reading as `missing` and being copied back in. After it, a clone
 * at that path counts as new. Clone files are never touched by pruning either way.
 */
const UNLISTED_CLONE_GRACE_MS = 7 * 24 * 60 * 60_000;

/**
 * A clone where git hasn't answered for every managed path (it failed): a light check (a watcher's,
 * a listing's) asks git again once this long has passed since its last failure, instead of
 * leaving those paths refused until the next full pass.
 */
export const TRACKED_RETRY_MS = 30_000;

const noop = (): void => undefined;

function vaultKeyOf(workspace: string, repoKey: string): string {
  return `${workspace}\u0000${repoKey}`;
}

function errorText(error: unknown): string {
  if (error instanceof SecretFilesError || error instanceof SecretVaultStoreError) return `${error.code}`;
  if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string") return (error as NodeJS.ErrnoException).code as string;
  return error instanceof Error ? error.name : "error";
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class SecretFilesService {
  private readonly store: SecretVaultStoreLike;
  private readonly files: SecretFilesFileOps;
  private readonly watchFn: SecretFilesWatchFn;
  private readonly dirIdentity: SecretFilesDirIdentityFn;
  private readonly timers: SecretFilesTimers;
  private readonly now: () => Date;
  private readonly realpath: (path: string) => Promise<string>;
  private readonly logger: SecretFilesLogger;
  private readonly debounceMs: number;
  private readonly listDebounceMs: number;
  private readonly intervalMs: number;
  private readonly unlistedGraceMs: number;

  /** This process's revision `boot`; `seq` counts every detail published, across vaults. */
  private readonly boot = randomBytes(12).toString("base64url");
  private seq = 0;
  /** The per-process key of the clone files' content tokens (never leaves memory). */
  private readonly tokenKey = randomBytes(32);
  /** Aborted by `stop()`: kills git runs in flight. */
  private readonly abort = new AbortController();

  private readonly runtimes = new Map<string, VaultRuntime>();
  private readonly inflight = new Set<Promise<unknown>>();
  private enabled = false;
  private started = false;
  private stopped = false;
  private unsubscribe: (() => void) | null = null;
  private interval: unknown = null;
  private listTimer: unknown = null;
  private reconciling: Promise<void> | null = null;
  private reconcileAgain = false;
  private reconcileFull = false;

  constructor(private readonly options: SecretFilesServiceOptions) {
    this.store = options.store;
    this.files = { ...DEFAULT_FILE_OPS, ...options.files };
    this.watchFn = options.watch ?? defaultWatch;
    this.dirIdentity = options.dirIdentity ?? defaultDirIdentity;
    this.timers = options.timers ?? realTimers;
    this.now = options.now ?? (() => new Date());
    this.realpath = options.realpath ?? fsRealpath;
    this.logger = options.logger ?? console;
    this.debounceMs = options.debounceMs ?? 500;
    this.listDebounceMs = options.listDebounceMs ?? 1000;
    this.intervalMs = options.intervalMs ?? 5 * 60_000;
    this.unlistedGraceMs = options.unlistedGraceMs ?? UNLISTED_CLONE_GRACE_MS;
    // Every git child of every vault listens on this one signal: no listener cap (and no warning).
    setMaxListeners(0, this.abort.signal);
  }

  // -- lifecycle -------------------------------------------------------------

  /** Subscribe to the plugin and, when it is on, arm the interval and run the first reconcile (in the background). */
  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    this.unsubscribe = this.options.onPluginChange((enabled) => this.pluginChanged(enabled));
    let enabled = false;
    try {
      enabled = await this.options.pluginEnabled();
    } catch (error) {
      this.logger.warn(`secret-files: could not read the plugin state (${errorText(error)}); treating it as off`);
    }
    if (!this.stopped) this.pluginChanged(enabled);
  }

  /**
   * Stop at once, without waiting: the plugin subscription, every watcher and timer, and git runs in
   * flight (killed). Nothing starts or writes to a clone afterwards; an operation already past its
   * last check may still be finishing its vault write — `idle()` resolves once it has (shutdown
   * awaits it last, bounded).
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.deactivate();
    this.abort.abort();
  }

  /** Resolves once no operation, reconcile or check is in flight (tests; shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private pluginChanged(enabled: boolean): void {
    if (this.stopped || enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.interval = this.timers.setInterval(() => void this.reconcile(true), this.intervalMs);
      void this.reconcile(true);
    } else {
      this.deactivate();
    }
  }

  private deactivate(): void {
    this.enabled = false;
    if (this.interval !== null) this.timers.clearInterval(this.interval);
    this.interval = null;
    if (this.listTimer !== null) this.timers.clearTimeout(this.listTimer);
    this.listTimer = null;
    for (const runtime of this.runtimes.values()) {
      this.closeWatches(runtime);
      // Nothing keeps the states fresh while off: reads evaluate again.
      runtime.evals = null;
    }
  }

  // -- reconcile triggers ----------------------------------------------------

  /** A workspace's projects were listed: a (debounced) light reconcile — new clones get their files. */
  notifyProjectsListed(): void {
    if (!this.enabled || this.stopped) return;
    if (this.listTimer !== null) this.timers.clearTimeout(this.listTimer);
    this.listTimer = this.timers.setTimeout(() => {
      this.listTimer = null;
      void this.reconcile(false);
    }, this.listDebounceMs);
  }

  /**
   * A project was just created or cloned at `path`: its vault (if its repo has one in its workspace)
   * is reconciled now, so the clone has its files when the create route answers. Never rejects.
   */
  async notifyProjectCreated(path: string): Promise<void> {
    if (!this.enabled || this.stopped) return;
    await this.track(
      (async () => {
        const projects = await this.options.listProjects();
        const project = projects.find((candidate) => candidate.path === path);
        if (!project?.repoKey || project.isArchived) return;
        if (!this.store.get(project.workspace, project.repoKey)) return;
        const runtime = this.runtime(project.workspace, project.repoKey);
        await this.enqueue(runtime, () => this.refreshVault(runtime, { projects, scan: false, git: false, auto: true }));
      })().catch((error) => this.logger.warn(`secret-files: reconcile after a project create failed (${errorText(error)})`))
    );
  }

  /**
   * One reconcile pass over every vault: re-list projects, recompute, apply the automatic actions,
   * prune unlisted clones, re-arm watchers, publish what changed. `full` re-runs the candidate scan
   * and the tracked check in every clone; a light pass runs git only for clones it hasn't seen.
   * Concurrent calls coalesce into one more pass.
   */
  reconcile(full = true): Promise<void> {
    if (this.reconciling) {
      this.reconcileAgain = true;
      this.reconcileFull ||= full;
      return this.reconciling;
    }
    this.reconcileFull = full;
    const run = (async () => {
      do {
        this.reconcileAgain = false;
        const passFull = this.reconcileFull;
        this.reconcileFull = false;
        await this.reconcileOnce(passFull);
      } while (this.reconcileAgain && this.enabled && !this.stopped);
    })().finally(() => {
      this.reconciling = null;
    });
    this.reconciling = run;
    return this.track(run);
  }

  private async reconcileOnce(full: boolean): Promise<void> {
    if (!this.enabled || this.stopped) return;
    let projects: SecretFilesProject[];
    try {
      projects = await this.options.listProjects();
    } catch (error) {
      this.logger.warn(`secret-files: could not list projects (${errorText(error)})`);
      return;
    }
    const keys = new Map<string, { workspace: string; repoKey: string }>();
    for (const record of this.store.list()) keys.set(vaultKeyOf(record.workspace, record.repoKey), record);
    for (const runtime of this.runtimes.values()) keys.set(vaultKeyOf(runtime.workspace, runtime.repoKey), runtime);
    await Promise.all(
      [...keys.values()].map(({ workspace, repoKey }) => {
        const runtime = this.runtime(workspace, repoKey);
        return this.enqueue(runtime, () => this.refreshVault(runtime, { projects, scan: full, git: full, auto: true })).catch((error) =>
          this.logger.warn(`secret-files: reconcile of ${workspace}/${repoKey} failed (${errorText(error)})`)
        );
      })
    );
  }

  // -- reads -----------------------------------------------------------------

  /** Every vault's summary. */
  async list(): Promise<SecretVaultsResponse> {
    const vaults: SecretVaultSummary[] = [];
    for (const record of this.store.list()) {
      const detail = await this.read(record.workspace, record.repoKey).catch((error: unknown) => {
        if (error instanceof SecretFilesError && error.code === "VAULT_NOT_FOUND") return null;
        throw error;
      });
      if (detail) {
        const { workspace, repoKey, fileCount, clonesNeedingAttention, newCandidates, updatedAt } = detail;
        vaults.push({ workspace, repoKey, fileCount, clonesNeedingAttention, newCandidates, updatedAt });
      }
    }
    vaults.sort((a, b) => a.workspace.localeCompare(b.workspace) || a.repoKey.localeCompare(b.repoKey));
    return { vaults };
  }

  /** One vault's detail (404 VAULT_NOT_FOUND). */
  async getVault(workspace: unknown, repoKey: unknown): Promise<SecretVaultDetail> {
    const id = vaultIdOf(workspace, repoKey);
    return this.read(id.workspace, id.repoKey);
  }

  private read(workspace: string, repoKey: string): Promise<SecretVaultDetail> {
    // No runtime for a vault that doesn't exist (an arbitrary query must not grow the map).
    this.requireVault(workspace, repoKey);
    const runtime = this.runtime(workspace, repoKey);
    return this.enqueue(runtime, async () => {
      const record = this.store.get(workspace, repoKey);
      if (!record) throw new SecretFilesError("VAULT_NOT_FOUND", "This repo has no secret files vault in this workspace.");
      // While on, watchers and reconciles keep the evaluation fresh.
      if (this.enabled && runtime.evals) return this.publishIfChanged(runtime, this.detailOf(runtime, record));
      const projects = await this.options.listProjects();
      const detail = await this.refreshVault(runtime, { projects, scan: true, git: true, auto: false });
      if (!detail) throw new SecretFilesError("VAULT_NOT_FOUND", "This repo has no secret files vault in this workspace.");
      return detail;
    });
  }

  /** The names-only compare of a clone's copy (left) against the vault's (right). */
  async compare(query: { workspace?: unknown; repoKey?: unknown; projectPath?: unknown; path?: unknown }): Promise<SecretFileCompareResponse> {
    const { workspace, repoKey } = vaultIdOf(query.workspace, query.repoKey);
    const path = pathOf(query.path);
    this.requireVault(workspace, repoKey);
    const runtime = this.runtime(workspace, repoKey);
    return this.enqueue(runtime, async () => {
      const record = this.requireVault(workspace, repoKey);
      const file = record.files.find((candidate) => candidate.path === path);
      const current = file?.versions[0];
      if (!file || !current) throw new SecretFilesError("FILE_NOT_MANAGED", `${path} is not one of this vault's files.`);
      const projects = await this.options.listProjects();
      const clone = await this.resolveClone(workspace, repoKey, query.projectPath, projects);
      const read = await this.files.readCloneFile(clone.path, path);
      if (read.kind === "refused") {
        throw new SecretFilesError("FILE_REFUSED", `${path} ${REFUSAL_TEXT[read.refusal]} in ${clone.name}.`);
      }
      const right = await this.store.readContent(current.sha256);
      return {
        path,
        compare: sanitizeCompare(compareContents(read.kind === "file" ? read.content : null, right)),
        ...(read.kind === "file" ? { contentToken: this.tokenOf(clone.path, path, sha256Of(read.content)) } : {})
      };
    });
  }

  /**
   * The setup scan: every conventional candidate in every clone (plus the vault's managed files), or
   * just `path` (one hand-typed path), with the clones' distinct copies as variants.
   */
  async candidates(query: { workspace?: unknown; repoKey?: unknown; path?: unknown }): Promise<SecretFileCandidatesResponse> {
    const { workspace, repoKey } = vaultIdOf(query.workspace, query.repoKey);
    const single = query.path === undefined || query.path === "" ? null : newPathOf(query.path);
    const runtime = this.runtime(workspace, repoKey);
    return this.enqueue(runtime, async () => {
      const projects = await this.options.listProjects();
      const clones = clonesOf(projects, workspace, repoKey);
      const record = this.store.get(workspace, repoKey);
      const managed = new Set(record?.files.map((file) => file.path) ?? []);
      const excluded = new Set(record?.excluded ?? []);

      const conventional = new Set<string>();
      if (!single) {
        await Promise.all(
          clones.map(async (clone) => {
            const found = await this.files.scanCandidates(clone.path, this.abort.signal).catch(() => [] as string[]);
            runtime.candidates.set(clone.path, found);
            for (const path of found) conventional.add(path);
          })
        );
      }
      const paths = single ? [single] : [...new Set([...conventional, ...managed])].sort();

      // Per clone: which of `paths` git tracks, and each path's copy.
      const perClone = await Promise.all(
        clones.map(async (clone) => {
          // A git that can't tell what is tracked there: every path refused `unreadable` in that clone.
          const tracked = paths.length > 0 ? await this.files.trackedPaths(clone.path, paths, this.abort.signal).catch(() => null) : new Set<string>();
          const reads = new Map<string, CloneFileRead | { kind: "tracked" }>();
          for (const path of paths) {
            if (tracked === null) {
              reads.set(path, { kind: "refused", refusal: "unreadable" });
              continue;
            }
            if (tracked.has(path)) {
              reads.set(path, { kind: "tracked" });
              continue;
            }
            reads.set(path, await this.files.readCloneFile(clone.path, path).catch((): CloneFileRead => ({ kind: "refused", refusal: "unreadable" })));
          }
          return { clone, reads };
        })
      );

      const candidates: SecretFileCandidate[] = paths.map((path) => {
        const refused: SecretFileCandidate["refused"] = [];
        const groups = new Map<string, { projectPaths: string[]; mtimeMs: number; content: Uint8Array }>();
        for (const { clone, reads } of perClone) {
          const read = reads.get(path);
          if (!read || read.kind === "missing") continue;
          if (read.kind === "tracked") {
            refused.push({ projectPath: clone.path, refusal: "tracked" });
            continue;
          }
          if (read.kind === "refused") {
            refused.push({ projectPath: clone.path, refusal: read.refusal });
            continue;
          }
          const sha = sha256Of(read.content);
          const group = groups.get(sha);
          if (group) {
            group.projectPaths.push(clone.path);
            group.mtimeMs = Math.max(group.mtimeMs, read.mtimeMs);
          } else {
            groups.set(sha, { projectPaths: [clone.path], mtimeMs: read.mtimeMs, content: read.content });
          }
        }
        const ordered = [...groups.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
        const parsed = ordered.map((group) => parseEnv(group.content));
        const format: "env" | "lines" = ordered.length > 0 && parsed.every((env) => env !== null) ? "env" : "lines";
        const variants: SecretFileVariant[] = ordered.map((group, index) => ({
          variantId: `v${index + 1}`,
          projectPaths: group.projectPaths,
          modifiedAt: new Date(group.mtimeMs).toISOString(),
          ...(format === "env" ? { keyCount: parsed[index]!.size } : { lineCount: lineCountOf(group.content) })
        }));
        const candidate: SecretFileCandidate = {
          path,
          conventional: conventional.has(path) || (single !== null && isConventionalSecretFileName(posix.basename(path))),
          managed: managed.has(path),
          excluded: excluded.has(path),
          format,
          variants,
          defaultVariantId: variants[0]?.variantId ?? null,
          refused
        };
        if (format === "env") candidate.keys = valueClasses(variants, parsed as Array<Map<string, string>>);
        return candidate;
      });

      return {
        workspace,
        repoKey,
        clones: clones.map((clone) => ({ projectPath: clone.path, projectName: clone.name })),
        candidates
      };
    });
  }

  // -- mutations -------------------------------------------------------------

  /** Create the vault (or add files to it): each file's first version from its source. */
  async setup(request: unknown, actor: SecretFilesActor = { kind: "user" }): Promise<SecretVaultDetail> {
    const body = bodyOf(request);
    const { workspace, repoKey } = vaultIdOf(body.workspace, body.repoKey);
    const files = fileSourcesOf(body.files, "files", true)!;
    const excluded = pathListOf(body.excluded, "excluded") ?? [];
    disjoint([files.map((file) => file.path), excluded]);
    this.requireWritable();
    const runtime = this.runtime(workspace, repoKey);
    return this.enqueue(runtime, async () => {
      this.requireWritable();
      const projects = await this.options.listProjects();
      if (clonesOf(projects, workspace, repoKey).length === 0) {
        throw new SecretFilesError("INVALID_CLONE", "No project in this workspace is a clone of that repo.");
      }
      const existing = this.store.get(workspace, repoKey);
      const managed = new Set(existing?.files.map((file) => file.path) ?? []);
      // Re-running setup adds files; a file the vault already manages keeps its versions.
      const added = files.filter((file) => !managed.has(file.path));
      if (managed.size + added.length > SECRET_FILES_MAX_PER_VAULT) {
        throw new SecretFilesError("TOO_MANY_FILES", `A vault manages at most ${SECRET_FILES_MAX_PER_VAULT} files.`);
      }
      const sources = await this.sourceContents(workspace, repoKey, added, projects);
      const stamp = this.now().toISOString();
      await this.store.update(workspace, repoKey, async (current, tx) => {
        const next: VaultRecord = current ?? { workspace, repoKey, files: [], excluded: [], clones: {}, createdAt: stamp, updatedAt: stamp };
        for (const source of sources) {
          if (next.files.some((file) => file.path === source.path)) continue;
          const version = await tx.putContent(source.content, updatedByOf(actor, source.clone.name));
          next.files.push({ path: source.path, versions: [version] });
        }
        const nowManaged = new Set(next.files.map((file) => file.path));
        next.excluded = [...new Set([...next.excluded, ...excluded])].filter((path) => !nowManaged.has(path));
        next.updatedAt = stamp;
        return next;
      });
      return this.requireDetail(await this.refreshVault(runtime, { projects, scan: true, git: true, auto: true }));
    });
  }

  /**
   * Add, exclude, include or stop managing files. A file that stops being managed (unmanage, or an
   * exclude of a managed file) is RETIRED: it stops syncing, clones keep their copies, and the vault
   * keeps its version history (`VaultRecord.retired`, for manual recovery). Adding the path again
   * starts a new history from its source; the retired one is kept (a later retirement of the same
   * path merges both, newest first, capped at the history limit).
   */
  async updateFiles(request: unknown, actor: SecretFilesActor = { kind: "user" }): Promise<SecretVaultDetail> {
    const body = bodyOf(request);
    const { workspace, repoKey } = vaultIdOf(body.workspace, body.repoKey);
    const add = fileSourcesOf(body.add, "add", false);
    const exclude = pathListOf(body.exclude, "exclude");
    const include = pathListOf(body.include, "include");
    const unmanage = pathListOf(body.unmanage, "unmanage");
    if (!add && !exclude && !include && !unmanage) throw invalid("Nothing to change.");
    disjoint([add?.map((file) => file.path), exclude, include, unmanage]);
    this.requireWritable();
    this.requireVault(workspace, repoKey);
    const runtime = this.runtime(workspace, repoKey);
    return this.enqueue(runtime, async () => {
      this.requireWritable();
      const record = this.requireVault(workspace, repoKey);
      const managed = new Set(record.files.map((file) => file.path));
      for (const path of unmanage ?? []) {
        if (!managed.has(path)) throw new SecretFilesError("FILE_NOT_MANAGED", `${path} is not one of this vault's files.`);
      }
      const removed = new Set([...(unmanage ?? []), ...(exclude ?? []).filter((path) => managed.has(path))]);
      const added = (add ?? []).filter((file) => !managed.has(file.path));
      if (managed.size - removed.size + added.length > SECRET_FILES_MAX_PER_VAULT) {
        throw new SecretFilesError("TOO_MANY_FILES", `A vault manages at most ${SECRET_FILES_MAX_PER_VAULT} files.`);
      }
      const projects = await this.options.listProjects();
      const sources = await this.sourceContents(workspace, repoKey, added, projects);
      const stamp = this.now().toISOString();
      await this.store.update(workspace, repoKey, async (current, tx) => {
        if (!current) throw new SecretFilesError("VAULT_NOT_FOUND", "This repo has no secret files vault in this workspace.");
        const retiring = current.files.filter((file) => removed.has(file.path));
        if (retiring.length > 0) current.retired = retire(current.retired ?? [], retiring);
        current.files = current.files.filter((file) => !removed.has(file.path));
        for (const clone of Object.values(current.clones)) {
          for (const path of removed) delete clone.baselines[path];
        }
        for (const source of sources) {
          if (current.files.some((file) => file.path === source.path)) continue;
          const version = await tx.putContent(source.content, updatedByOf(actor, source.clone.name));
          current.files.push({ path: source.path, versions: [version] });
        }
        const nowManaged = new Set(current.files.map((file) => file.path));
        const included = new Set(include ?? []);
        current.excluded = [...new Set([...current.excluded, ...(exclude ?? [])])].filter((path) => !included.has(path) && !nowManaged.has(path));
        current.updatedAt = stamp;
        return current;
      });
      return this.requireDetail(await this.refreshVault(runtime, { projects, scan: true, git: true, auto: true }));
    });
  }

  /**
   * Push (clone → vault): each selected `modified` file becomes the vault's new version and that
   * clone's baseline; every `synced`/`outdated` clone is then updated, other `modified` ones stay
   * flagged against the new version. `deleted` files are never pushed.
   */
  async push(request: unknown, actor: SecretFilesActor = { kind: "user" }): Promise<SecretVaultDetail> {
    const body = bodyOf(request);
    const { workspace, repoKey } = vaultIdOf(body.workspace, body.repoKey);
    const selection = pathListOf(body.files, "files");
    const expect = expectOf(body.expect);
    this.requireWritable();
    this.requireVault(workspace, repoKey);
    const runtime = this.runtime(workspace, repoKey);
    return this.enqueue(runtime, async () => {
      this.requireWritable();
      const record = this.requireVault(workspace, repoKey);
      const projects = await this.options.listProjects();
      const source = await this.resolveClone(workspace, repoKey, body.projectPath, projects);
      this.requireManaged(record, selection);
      this.requireManaged(record, expect && [...expect.keys()]);
      const clones = clonesOf(projects, workspace, repoKey);
      runtime.clones = clones;
      // Fresh states for every clone, before the vault moves.
      const evals = new Map<string, Map<string, FileEval>>();
      await Promise.all(
        clones.map(async (clone) => {
          evals.set(clone.path, await this.evaluateClone(clone, record, await this.refreshTracked(runtime, clone.path, record)));
        })
      );
      const sourceEvals = evals.get(source.path)!;
      const wanted = selection ?? record.files.map((file) => file.path);
      const contents: Array<{ path: string; content: Uint8Array }> = [];
      for (const path of wanted) {
        const evaluated = sourceEvals.get(path);
        if (evaluated?.state !== "modified") continue;
        const read = await this.files.readCloneFile(source.path, path).catch((): CloneFileRead => ({ kind: "refused", refusal: "unreadable" }));
        const sha = read.kind === "file" ? sha256Of(read.content) : undefined;
        if (sha === undefined || sha !== evaluated.sha256) {
          // Changed since the evaluation: these bytes are what the source has now.
          const file = record.files.find((candidate) => candidate.path === path)!;
          const { state, refusal } = cloneFileState(file, read, record.clones[source.path]?.baselines[path], sha);
          sourceEvals.set(path, {
            path,
            state,
            ...(refusal ? { refusal } : {}),
            ...(sha ? { sha256: sha } : {}),
            ...(read.kind === "file" ? { mode: read.mode } : {})
          });
          if (state !== "modified") continue;
        }
        if (read.kind === "file") contents.push({ path, content: read.content });
      }
      // This evaluation is the vault's current one from here on — also when the push is refused below.
      this.keepEvaluation(runtime, record, evals, true);
      // Against the very bytes pushed (else this evaluation's read): what the caller saw, or nothing moves.
      if (expect) this.requireExpected(source, expect, this.tokensOf(source.path, sourceEvals));
      if (contents.length === 0) throw new SecretFilesError("NOTHING_TO_PUSH", `No selected file differs from the vault in ${source.name}.`);

      const stamp = this.now().toISOString();
      await this.store.update(workspace, repoKey, async (current, tx) => {
        if (!current) throw new SecretFilesError("VAULT_NOT_FOUND", "This repo has no secret files vault in this workspace.");
        for (const { path, content } of contents) {
          const file = current.files.find((candidate) => candidate.path === path);
          const previous = file?.versions[0];
          if (!file || !previous) continue;
          // A synced clone the reconcile hasn't stamped yet must read as `outdated` (not
          // `modified`) once the vault moves on: stamp its baseline with the version it holds.
          for (const clone of clones) {
            if (clone.path === source.path || evals.get(clone.path)?.get(path)?.state !== "synced") continue;
            (current.clones[clone.path] ??= { baselines: {} }).baselines[path] = previous.id;
          }
          const version = await tx.putContent(content, updatedByOf(actor, source.name));
          file.versions = [version, ...file.versions.filter((candidate) => candidate.id !== version.id)];
          (current.clones[source.path] ??= { baselines: {} }).baselines[path] = version.id;
        }
        current.updatedAt = stamp;
        return current;
      });
      // The automatic `outdated` update carries the new version to every clone that had the old one.
      return this.requireDetail(await this.refreshVault(runtime, { projects, scan: false, git: false, auto: true }));
    });
  }

  /** Reset (vault → clone): overwrite the clone's `modified`/`deleted`/`outdated`/`missing` files. */
  async reset(request: unknown, _actor: SecretFilesActor = { kind: "user" }): Promise<SecretVaultDetail> {
    const body = bodyOf(request);
    const { workspace, repoKey } = vaultIdOf(body.workspace, body.repoKey);
    const selection = pathListOf(body.files, "files");
    const expect = expectOf(body.expect);
    this.requireWritable();
    this.requireVault(workspace, repoKey);
    const runtime = this.runtime(workspace, repoKey);
    return this.enqueue(runtime, async () => {
      this.requireWritable();
      const record = this.requireVault(workspace, repoKey);
      const projects = await this.options.listProjects();
      const clone = await this.resolveClone(workspace, repoKey, body.projectPath, projects);
      this.requireManaged(record, selection);
      this.requireManaged(record, expect && [...expect.keys()]);
      const evals = await this.evaluateClone(clone, record, await this.refreshTracked(runtime, clone.path, record));
      // This evaluation is the clone's current one from here on — also when the reset is refused below.
      this.keepEvaluation(runtime, record, new Map([[clone.path, evals]]), false);
      // Against the copies this evaluation just read (the bytes about to be overwritten), before any write.
      if (expect) this.requireExpected(clone, expect, this.tokensOf(clone.path, evals));
      const wanted = new Set(selection ?? record.files.map((file) => file.path));
      const written: Array<{ path: string; versionId: string }> = [];
      for (const file of record.files) {
        const current = file.versions[0];
        const evaluated = evals.get(file.path);
        if (!wanted.has(file.path) || !current || !evaluated || !RESETTABLE.includes(evaluated.state)) continue;
        const content = await this.store.readContent(current.sha256);
        // Re-read right before the write: the copy must still be the one evaluated (and so the one
        // `expect` named). A copy that wasn't there is created, never replaces one made meanwhile.
        const missing = evaluated.sha256 === undefined;
        const again = await this.files.readCloneFile(clone.path, file.path).catch(() => null);
        let unchanged = missing
          ? again?.kind === "missing" && again.parentExists
          : again?.kind === "file" && sha256Of(again.content) === evaluated.sha256;
        if (unchanged) {
          try {
            await this.files.writeCloneFile(clone.path, file.path, content, missing ? undefined : evaluated.mode, this.writeOptions(missing ? { createOnly: true } : {}));
          } catch (error) {
            if (!(error instanceof CloneFileError && error.exists)) {
              this.logger.warn(`secret-files: could not reset ${file.path} in ${clone.name} (${errorText(error)})`);
              throw new SecretFilesError("SECRET_FILES_ERROR", `Could not write ${file.path} in ${clone.name}.`);
            }
            unchanged = false;
          }
        }
        if (!unchanged) {
          // Edited meanwhile: left as it is. What was already reset keeps its baseline; the clone is
          // evaluated again (and published) so the caller sees the copy it now has.
          if (written.length > 0) await this.setBaselines(workspace, repoKey, [{ clonePath: clone.path, entries: written }]);
          await this.refreshVault(runtime, { projects, only: clone.path, scan: false, git: false, auto: true });
          const done = written.length > 0 ? ` (${written.map((entry) => entry.path).join(", ")} ${written.length === 1 ? "was" : "were"} reset)` : "";
          throw new SecretFilesError("CONTENT_CHANGED", `${file.path} changed in ${clone.name} while it was being reset; it was left as it is${done}.`);
        }
        written.push({ path: file.path, versionId: current.id });
      }
      if (written.length > 0) await this.setBaselines(workspace, repoKey, [{ clonePath: clone.path, entries: written }]);
      return this.requireDetail(await this.refreshVault(runtime, { projects, scan: false, git: false, auto: true }));
    });
  }

  /** Delete the vault. Clone files are left as they are. */
  async deleteVault(workspace: unknown, repoKey: unknown): Promise<void> {
    const id = vaultIdOf(workspace, repoKey);
    this.requireWritable();
    this.requireVault(id.workspace, id.repoKey);
    const runtime = this.runtime(id.workspace, id.repoKey);
    await this.enqueue(runtime, async () => {
      this.requireWritable();
      this.requireVault(id.workspace, id.repoKey);
      await this.store.update(id.workspace, id.repoKey, () => null);
      this.dropRuntime(runtime, true);
    });
  }

  // -- internals: operations ---------------------------------------------------

  private requireWritable(): void {
    if (!this.enabled || this.stopped) throw new SecretFilesError("SECRET_FILES_DISABLED", "The Secret files plugin is off.");
    if (!this.store.writable) throw toSecretFilesError(new SecretVaultStoreError("SECRET_FILES_UNAVAILABLE", ""));
  }

  private requireVault(workspace: string, repoKey: string): VaultRecord {
    const record = this.store.get(workspace, repoKey);
    if (!record) throw new SecretFilesError("VAULT_NOT_FOUND", "This repo has no secret files vault in this workspace.");
    return record;
  }

  private requireManaged(record: VaultRecord, paths: readonly string[] | undefined): void {
    for (const path of paths ?? []) {
      if (!record.files.some((file) => file.path === path)) throw new SecretFilesError("FILE_NOT_MANAGED", `${path} is not one of this vault's files.`);
    }
  }

  private requireDetail(detail: SecretVaultDetail | null): SecretVaultDetail {
    if (!detail) throw new SecretFilesError("VAULT_NOT_FOUND", "This repo has no secret files vault in this workspace.");
    return detail;
  }

  /** `projectPath` as one of the vault's clones: a listed, non-archived project of that workspace and repo, after realpath. */
  private async resolveClone(workspace: string, repoKey: string, projectPath: unknown, projects: SecretFilesProject[]): Promise<SecretFilesProject> {
    const refuse = () => new SecretFilesError("INVALID_CLONE", "That project is not a clone of this repo in this workspace.");
    if (typeof projectPath !== "string" || projectPath.length === 0) throw refuse();
    const clones = clonesOf(projects, workspace, repoKey);
    const exact = clones.find((clone) => clone.path === projectPath);
    if (exact) return exact;
    const real = await this.realpath(projectPath).catch(() => null);
    if (real === null) throw refuse();
    for (const clone of clones) {
      if ((await this.realpath(clone.path).catch(() => null)) === real) return clone;
    }
    throw refuse();
  }

  /** Each added file's first content, read from its source (refused / missing sources refused). */
  private async sourceContents(
    workspace: string,
    repoKey: string,
    files: Array<{ path: string; source: SecretFileSource }>,
    projects: SecretFilesProject[]
  ): Promise<Array<{ path: string; content: Uint8Array; clone: SecretFilesProject }>> {
    const out: Array<{ path: string; content: Uint8Array; clone: SecretFilesProject }> = [];
    for (const { path, source } of files) {
      if ("merge" in source) {
        const primary = await this.resolveClone(workspace, repoKey, source.primary, projects);
        const primaryContent = await this.readSource(primary, path);
        const others: Uint8Array[] = [];
        for (const clone of clonesOf(projects, workspace, repoKey)) {
          if (clone.path === primary.path) continue;
          // A clone where git can't tell whether the file is tracked contributes nothing.
          const tracked = await this.files.trackedPaths(clone.path, [path], this.abort.signal).catch(() => null);
          if (tracked === null || tracked.has(path)) continue;
          const read = await this.files.readCloneFile(clone.path, path).catch(() => null);
          if (read?.kind === "file") others.push(read.content);
        }
        const merged = mergeEnvContents(primaryContent, others);
        if (!merged) throw new SecretFilesError("NOT_ENV_FORMAT", `${path} is not a KEY=VALUE file in every project, so it can't be merged.`);
        out.push({ path, content: merged, clone: primary });
      } else {
        const clone = await this.resolveClone(workspace, repoKey, source.projectPath, projects);
        out.push({ path, content: await this.readSource(clone, path), clone });
      }
    }
    return out;
  }

  private async readSource(clone: SecretFilesProject, path: string): Promise<Uint8Array> {
    const tracked = await this.files.trackedPaths(clone.path, [path], this.abort.signal).catch(() => null);
    if (tracked === null) {
      throw new SecretFilesError("FILE_REFUSED", `${path} ${REFUSAL_TEXT.unreadable} in ${clone.name}: git could not tell whether it is tracked.`);
    }
    if (tracked.has(path)) throw new SecretFilesError("FILE_REFUSED", `${path} ${REFUSAL_TEXT.tracked} in ${clone.name}.`);
    const read = await this.files.readCloneFile(clone.path, path).catch((): CloneFileRead => ({ kind: "refused", refusal: "unreadable" }));
    if (read.kind === "refused") throw new SecretFilesError("FILE_REFUSED", `${path} ${REFUSAL_TEXT[read.refusal]} in ${clone.name}.`);
    if (read.kind === "missing") throw new SecretFilesError("SOURCE_MISSING", `${clone.name} has no ${path}.`);
    return read.content;
  }

  /**
   * Ask git which of the record's paths it tracks in a clone. On a failure keep what was known
   * (nothing is stored when nothing was: a later check asks again, see TRACKED_RETRY_MS).
   */
  private async refreshTracked(runtime: VaultRuntime, clonePath: string, record: VaultRecord): Promise<TrackedState> {
    const paths = record.files.map((file) => file.path);
    try {
      const tracked = await this.files.trackedPaths(clonePath, paths, this.abort.signal);
      const state: TrackedState = { tracked, checked: new Set(paths) };
      runtime.tracked.set(clonePath, state);
      runtime.trackedFailedAt.delete(clonePath);
      return state;
    } catch (error) {
      if (!this.stopped) {
        this.logger.warn(
          `secret-files: git could not tell which files are tracked in ${clonePath} (${errorText(error)}); files it was never asked about are not written there`
        );
      }
      runtime.trackedFailedAt.set(clonePath, this.now().getTime());
      return runtime.tracked.get(clonePath) ?? NOTHING_KNOWN;
    }
  }

  /** Whether a light check should ask git about a clone: it never answered for every managed path, and its last failure (if any) is TRACKED_RETRY_MS old. */
  private trackedRetryDue(runtime: VaultRuntime, clonePath: string, record: VaultRecord): boolean {
    const known = runtime.tracked.get(clonePath);
    if (known && record.files.every((file) => known.checked.has(file.path))) return false;
    const failedAt = runtime.trackedFailedAt.get(clonePath);
    return failedAt === undefined || this.now().getTime() - failedAt >= TRACKED_RETRY_MS;
  }

  /**
   * An action's fresh evaluation (`all`: of every clone; else of some) as the vault's current one,
   * published when the detail changed. Without a current evaluation, a partial one is not kept
   * (the next read evaluates everything).
   */
  private keepEvaluation(runtime: VaultRuntime, record: VaultRecord, evals: Map<string, Map<string, FileEval>>, all: boolean): void {
    if (all) runtime.evals = new Map(evals);
    else if (runtime.evals) for (const [clonePath, cloneEvals] of evals) runtime.evals.set(clonePath, cloneEvals);
    else return;
    this.publishIfChanged(runtime, this.detailOf(runtime, record));
  }

  private async evaluateClone(clone: SecretFilesProject, record: VaultRecord, tracked: TrackedState): Promise<Map<string, FileEval>> {
    const out = new Map<string, FileEval>();
    const baselines = record.clones[clone.path]?.baselines ?? {};
    for (const file of record.files) {
      // Fail closed: a path git never answered for may be tracked — refused, never written.
      if (!tracked.checked.has(file.path)) {
        out.set(file.path, { path: file.path, state: "refused", refusal: "unreadable" });
        continue;
      }
      if (tracked.tracked.has(file.path)) {
        out.set(file.path, { path: file.path, state: "refused", refusal: "tracked" });
        continue;
      }
      const read = await this.files.readCloneFile(clone.path, file.path).catch((): CloneFileRead => ({ kind: "refused", refusal: "unreadable" }));
      const sha = read.kind === "file" ? sha256Of(read.content) : undefined;
      const { state, refusal } = cloneFileState(file, read, baselines[file.path], sha);
      out.set(file.path, {
        path: file.path,
        state,
        ...(refusal ? { refusal } : {}),
        ...(sha ? { sha256: sha } : {}),
        ...(read.kind === "file" ? { mode: read.mode } : {})
      });
    }
    return out;
  }

  /**
   * Record baselines (each only while that file's current version is still the one written), and with
   * `listed` (a full listing's clone paths of this repo) mark unlisted clones / prune them after the
   * grace period (see UNLISTED_CLONE_GRACE_MS) / unmark listed ones.
   */
  private async setBaselines(
    workspace: string,
    repoKey: string,
    changes: Array<{ clonePath: string; entries: Array<{ path: string; versionId: string }> }>,
    listed?: ReadonlySet<string>
  ): Promise<void> {
    await this.store.update(workspace, repoKey, (current) => {
      if (!current) return null;
      for (const { clonePath, entries } of changes) {
        for (const { path, versionId } of entries) {
          const file = current.files.find((candidate) => candidate.path === path);
          if (file?.versions[0]?.id !== versionId) continue;
          (current.clones[clonePath] ??= { baselines: {} }).baselines[path] = versionId;
        }
      }
      if (listed) this.applyListing(current, listed);
      return current;
    });
  }

  /** Whether `applyListing` would change the record. */
  private listingChanges(record: VaultRecord, listed: ReadonlySet<string>): boolean {
    const probe = { clones: structuredClone(record.clones) } as VaultRecord;
    this.applyListing(probe, listed);
    return JSON.stringify(probe.clones) !== JSON.stringify(record.clones);
  }

  private applyListing(record: VaultRecord, listed: ReadonlySet<string>): void {
    const now = this.now();
    for (const [clonePath, clone] of Object.entries(record.clones)) {
      if (listed.has(clonePath)) {
        delete clone.unlistedAt;
        continue;
      }
      if (clone.unlistedAt === undefined) {
        clone.unlistedAt = now.toISOString();
        continue;
      }
      const since = Date.parse(clone.unlistedAt);
      if (!Number.isFinite(since) || now.getTime() - since >= this.unlistedGraceMs) delete record.clones[clonePath];
    }
  }

  /** Options for every clone write: the clone root must stay inside the workspaces root. */
  private writeOptions(extra: WriteCloneFileOptions = {}): WriteCloneFileOptions {
    const root = this.options.workspacesRoot?.();
    return { ...extra, ...(root ? { containedIn: root } : {}) };
  }

  /**
   * A clone copy's content token: a keyed digest (per-process secret) of the clone, the path and
   * the content hash — it changes with the content and reveals nothing about it.
   */
  private tokenOf(clonePath: string, path: string, sha256: string): string {
    return createHmac("sha256", this.tokenKey).update(clonePath).update("\u0000").update(path).update("\u0000").update(sha256).digest("base64url").slice(0, 22);
  }

  /** Per managed path, the token of the clone's copy as evaluated: null when it has none, undefined when it can't be told (refused). */
  private tokensOf(clonePath: string, evals: Map<string, FileEval>): Map<string, string | null | undefined> {
    const out = new Map<string, string | null | undefined>();
    for (const [path, evaluated] of evals) {
      if (evaluated.sha256) out.set(path, this.tokenOf(clonePath, path, evaluated.sha256));
      else out.set(path, evaluated.state === "refused" ? undefined : null);
    }
    return out;
  }

  /** CONTENT_CHANGED (nothing written) unless every expected file still has the token the caller saw. */
  private requireExpected(clone: SecretFilesProject, expect: Map<string, string | null>, tokens: Map<string, string | null | undefined>): void {
    for (const [path, token] of expect) {
      if (tokens.get(path) !== token) {
        throw new SecretFilesError("CONTENT_CHANGED", `${path} changed in ${clone.name} since it was shown; nothing was written.`);
      }
    }
  }

  /**
   * Recompute a vault (all clones, or `only` one), apply the automatic actions, prune, publish when
   * the detail changed, and re-arm the watchers. Runs inside the vault's queue. Null: no vault.
   */
  private async refreshVault(runtime: VaultRuntime, options: RefreshOptions): Promise<SecretVaultDetail | null> {
    const { workspace, repoKey } = runtime;
    let record = this.store.get(workspace, repoKey);
    if (!record) {
      this.dropRuntime(runtime, runtime.lastPublished !== null);
      return null;
    }
    let listedPaths: Set<string> | null = null;
    if (options.projects) {
      runtime.clones = clonesOf(options.projects, workspace, repoKey);
      listedPaths = new Set(
        options.projects.filter((project) => project.workspace === workspace && project.repoKey === repoKey).map((project) => project.path)
      );
      const live = new Set(runtime.clones.map((clone) => clone.path));
      for (const path of [...runtime.tracked.keys()]) if (!live.has(path)) runtime.tracked.delete(path);
      for (const path of [...runtime.trackedFailedAt.keys()]) if (!live.has(path)) runtime.trackedFailedAt.delete(path);
      for (const path of [...runtime.candidates.keys()]) if (!live.has(path)) runtime.candidates.delete(path);
    }
    // A one-clone check needs the others' states already: without them it is a full refresh.
    const only = options.only !== undefined && runtime.evals !== null ? options.only : undefined;
    const targets = only ? runtime.clones.filter((clone) => clone.path === only) : runtime.clones;
    const snapshot = record;
    const evaluated = await Promise.all(
      targets.map(async (clone) => {
        // A light check asks git only for a clone it never fully answered for (backed off after a failure).
        const tracked =
          options.git || this.trackedRetryDue(runtime, clone.path, snapshot)
            ? await this.refreshTracked(runtime, clone.path, snapshot)
            : (runtime.tracked.get(clone.path) ?? NOTHING_KNOWN);
        if (options.scan || !runtime.candidates.has(clone.path)) {
          runtime.candidates.set(clone.path, await this.files.scanCandidates(clone.path, this.abort.signal).catch(() => [] as string[]));
        }
        return { clone, evals: await this.evaluateClone(clone, snapshot, tracked) };
      })
    );

    // §4's automatic actions — only while on; re-checked before every write, so turning the plugin
    // off (or stopping) during a pass stops it there.
    const live = () => this.enabled && !this.stopped;
    const changes: Array<{ clonePath: string; entries: Array<{ path: string; versionId: string }> }> = [];
    if (options.auto && live() && this.store.writable) {
      const contents = new Map<string, Uint8Array | null>();
      const contentOf = async (sha: string): Promise<Uint8Array | null> => {
        if (!contents.has(sha)) {
          contents.set(
            sha,
            await this.store.readContent(sha).catch((error: unknown) => {
              this.logger.warn(`secret-files: a vault version of ${workspace}/${repoKey} can't be read (${errorText(error)})`);
              return null;
            })
          );
        }
        return contents.get(sha) ?? null;
      };
      for (const { clone, evals } of evaluated) {
        const entries: Array<{ path: string; versionId: string }> = [];
        const baselines = snapshot.clones[clone.path]?.baselines ?? {};
        for (const file of snapshot.files) {
          const current = file.versions[0];
          const evaluatedFile = evals.get(file.path);
          if (!current || !evaluatedFile) continue;
          if (evaluatedFile.state === "synced") {
            if (baselines[file.path] !== current.id) entries.push({ path: file.path, versionId: current.id });
            continue;
          }
          if (evaluatedFile.state !== "missing" && evaluatedFile.state !== "outdated") continue;
          const content = await contentOf(current.sha256);
          if (!content) continue;
          // Re-read right before the write: an edit (or a new file) since the evaluation wins.
          const again = await this.files.readCloneFile(clone.path, file.path).catch(() => null);
          const unchanged =
            evaluatedFile.state === "missing"
              ? again?.kind === "missing" && again.parentExists
              : again?.kind === "file" && sha256Of(again.content) === evaluatedFile.sha256;
          if (!unchanged || !live()) continue;
          const missing = evaluatedFile.state === "missing";
          try {
            // A missing copy is created, never replaces: a file the user made since the re-read wins.
            await this.files.writeCloneFile(clone.path, file.path, content, missing ? undefined : evaluatedFile.mode, this.writeOptions(missing ? { createOnly: true } : {}));
          } catch (error) {
            // `exists`: the clone's own new file — the watcher's check evaluates it.
            if (!(error instanceof CloneFileError && error.exists)) {
              this.logger.warn(`secret-files: could not write ${file.path} in ${clone.name} (${errorText(error)})`);
            }
            continue;
          }
          evals.set(file.path, { path: file.path, state: "synced", sha256: current.sha256, ...(evaluatedFile.mode === undefined ? {} : { mode: evaluatedFile.mode }) });
          entries.push({ path: file.path, versionId: current.id });
        }
        if (entries.length > 0) changes.push({ clonePath: clone.path, entries });
      }
    }
    // Vault writes too only while on and automatic: a read while the plugin is off never rewrites
    // vaults.json (no baseline stamp, no unlisted-clone housekeeping).
    const listing = listedPaths && !only && options.auto && this.store.writable ? listedPaths : undefined;
    const housekeeping = listing !== undefined && this.listingChanges(snapshot, listing);
    if (live() && (changes.length > 0 || housekeeping)) {
      try {
        await this.setBaselines(workspace, repoKey, changes, listing);
      } catch (error) {
        this.logger.warn(`secret-files: could not record ${workspace}/${repoKey}'s clone baselines (${errorText(error)})`);
      }
      record = this.store.get(workspace, repoKey) ?? record;
    }

    if (only && runtime.evals) {
      for (const { clone, evals } of evaluated) runtime.evals.set(clone.path, evals);
    } else {
      runtime.evals = new Map(evaluated.map(({ clone, evals }) => [clone.path, evals]));
    }
    const detail = this.publishIfChanged(runtime, this.detailOf(runtime, record));
    if (live()) await this.syncWatches(runtime, record, only);
    return detail;
  }

  // -- internals: wire mapping -------------------------------------------------

  private detailOf(runtime: VaultRuntime, record: VaultRecord): SecretVaultDetail {
    const managed = new Set(record.files.map((file) => file.path));
    const excluded = new Set(record.excluded);
    const candidates = new Set<string>();
    for (const clone of runtime.clones) {
      for (const path of runtime.candidates.get(clone.path) ?? []) {
        if (!managed.has(path) && !excluded.has(path)) candidates.add(path);
      }
    }
    const clones: SecretFilesClone[] = runtime.clones.map((clone) => {
      const evals = runtime.evals?.get(clone.path);
      const files: SecretFileCloneState[] = [];
      for (const file of record.files) {
        const evaluated = evals?.get(file.path);
        if (!evaluated) continue;
        files.push({
          path: file.path,
          state: evaluated.state,
          ...(evaluated.refusal ? { refusal: evaluated.refusal } : {}),
          ...(evaluated.sha256 ? { contentToken: this.tokenOf(clone.path, file.path, evaluated.sha256) } : {})
        });
      }
      return {
        projectPath: clone.path,
        projectName: clone.name,
        files,
        needsAttention: files.some((file) => secretFileNeedsAttention(file.state))
      };
    });
    return {
      workspace: record.workspace,
      repoKey: record.repoKey,
      fileCount: record.files.length,
      clonesNeedingAttention: clones.filter((clone) => clone.needsAttention).length,
      newCandidates: candidates.size,
      updatedAt: record.updatedAt,
      files: record.files.flatMap((file) => {
        const current = file.versions[0];
        if (!current) return [];
        // Picked field by field: the stored record may carry more than the wire may see.
        const by = current.updatedBy;
        return [
          {
            path: file.path,
            version: current.id,
            updatedAt: current.updatedAt,
            updatedBy: {
              kind: by?.kind === "agent" ? "agent" : "user",
              ...(typeof by?.threadId === "string" ? { threadId: by.threadId } : {}),
              ...(typeof by?.projectName === "string" ? { projectName: by.projectName } : {})
            }
          }
        ];
      }),
      excluded: [...record.excluded],
      candidates: [...candidates].sort(),
      clones
    };
  }

  /**
   * `detail` with its revision: when it differs from the last one published for this vault (or none
   * was), it gets the next `seq` and goes out as an event; else it carries the last revision.
   */
  private publishIfChanged(runtime: VaultRuntime, detail: SecretVaultDetail): SecretVaultDetail {
    const serialized = JSON.stringify(detail);
    if (serialized !== runtime.lastPublished || runtime.revision === null) {
      runtime.lastPublished = serialized;
      this.seq += 1;
      runtime.revision = { boot: this.boot, seq: this.seq };
      this.emit({ vault: { ...detail, revision: { ...runtime.revision } } });
    }
    return { ...detail, revision: { ...runtime.revision } };
  }

  private emit(payload: SecretFilesChangedPayload): void {
    try {
      this.options.publish(payload);
    } catch (error) {
      this.logger.warn(`secret-files: publishing a change failed (${errorText(error)})`);
    }
  }

  // -- internals: runtimes, queues ---------------------------------------------

  private runtime(workspace: string, repoKey: string): VaultRuntime {
    const key = vaultKeyOf(workspace, repoKey);
    let runtime = this.runtimes.get(key);
    if (!runtime) {
      runtime = {
        workspace,
        repoKey,
        queue: Promise.resolve(),
        clones: [],
        evals: null,
        tracked: new Map(),
        trackedFailedAt: new Map(),
        candidates: new Map(),
        lastPublished: null,
        revision: null,
        watches: new Map(),
        pending: 0
      };
      this.runtimes.set(key, runtime);
    }
    return runtime;
  }

  /**
   * Reset a vault that no longer exists. Its runtime stays while operations are queued on it (so they
   * still serialize) and is forgotten once idle (`release`).
   */
  private dropRuntime(runtime: VaultRuntime, announce: boolean): void {
    this.closeWatches(runtime);
    runtime.clones = [];
    runtime.evals = null;
    runtime.tracked.clear();
    runtime.trackedFailedAt.clear();
    runtime.candidates.clear();
    runtime.lastPublished = null;
    runtime.revision = null;
    if (announce) this.emit({ workspace: runtime.workspace, repoKey: runtime.repoKey, deleted: true });
  }

  /** Forget an idle runtime whose vault doesn't exist (a read of an unknown vault, a failed setup, a deleted vault). */
  private release(runtime: VaultRuntime): void {
    if (runtime.pending > 0) return;
    const key = vaultKeyOf(runtime.workspace, runtime.repoKey);
    if (this.runtimes.get(key) !== runtime || this.store.get(runtime.workspace, runtime.repoKey)) return;
    this.closeWatches(runtime);
    this.runtimes.delete(key);
  }

  private enqueue<T>(runtime: VaultRuntime, task: () => Promise<T>): Promise<T> {
    runtime.pending += 1;
    const result = runtime.queue.then(task);
    runtime.queue = result.then(noop, noop);
    void result
      .finally(() => {
        runtime.pending -= 1;
        this.release(runtime);
      })
      .catch(noop);
    return this.track(result);
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inflight.add(promise);
    promise
      .finally(() => this.inflight.delete(promise))
      .catch(() => undefined);
    return promise;
  }

  // -- internals: watchers (spec §5) -------------------------------------------

  /**
   * Bring a vault's watches in line with its clones and files (`only`: that clone's alone). A watch
   * whose directory is gone or was replaced (deleted and recreated: another inode, which the old
   * watch never sees) is closed and, when the directory exists again, armed on the new one.
   */
  private async syncWatches(runtime: VaultRuntime, record: VaultRecord, only?: string): Promise<void> {
    // relDir → names that matter in it. The root also watches every path's first segment, so a
    // parent directory that appears is noticed.
    const wanted = new Map<string, Set<string>>([["", new Set()]]);
    for (const file of record.files) {
      const dir = posix.dirname(file.path);
      const relDir = dir === "." ? "" : dir;
      if (!wanted.has(relDir)) wanted.set(relDir, new Set());
      wanted.get(relDir)!.add(posix.basename(file.path));
      wanted.get("")!.add(file.path.split("/")[0]!);
    }
    const targets = runtime.clones.filter((clone) => !only || clone.path === only);
    // The only awaits: every wanted directory's identity. The arming pass below is synchronous, after
    // a last check that the plugin is still on.
    const identities = new Map<string, string | null>();
    await Promise.all(
      targets.flatMap((clone) =>
        [...wanted.keys()].map(async (relDir) => {
          const dirAbs = relDir === "" ? clone.path : join(clone.path, relDir);
          identities.set(dirAbs, await this.dirIdentity(dirAbs));
        })
      )
    );
    if (!this.enabled || this.stopped) return;
    const live = new Set(runtime.clones.map((clone) => clone.path));
    if (!only) {
      for (const [clonePath, watch] of runtime.watches) {
        if (!live.has(clonePath)) {
          this.closeCloneWatch(watch);
          runtime.watches.delete(clonePath);
        }
      }
    }
    for (const clone of targets) {
      let watch = runtime.watches.get(clone.path);
      if (!watch) {
        watch = { dirs: new Map(), timer: null };
        runtime.watches.set(clone.path, watch);
      }
      for (const [relDir, dirWatch] of watch.dirs) {
        if (!wanted.has(relDir)) {
          dirWatch.handle?.close();
          watch.dirs.delete(relDir);
        }
      }
      for (const [relDir, names] of wanted) {
        let dirWatch = watch.dirs.get(relDir);
        if (!dirWatch) {
          dirWatch = { handle: null, identity: null, names };
          watch.dirs.set(relDir, dirWatch);
        }
        dirWatch.names = names;
        const dirAbs = relDir === "" ? clone.path : join(clone.path, relDir);
        const identity = identities.get(dirAbs) ?? null;
        if (dirWatch.handle) {
          if (identity !== null && identity === dirWatch.identity) continue;
          dirWatch.handle.close();
          dirWatch.handle = null;
        }
        // Not there (now): the root watch (or the parent's) and the reconcile cover it.
        if (identity === null) continue;
        const entry = dirWatch;
        const selfName = basename(dirAbs);
        try {
          entry.identity = identity;
          entry.handle = this.watchFn(
            dirAbs,
            (filename) => {
              const name = filename === null ? null : posix.basename(filename.split("\\").join("/"));
              if (name === selfName) {
                // An event naming the watched directory itself: it was deleted, moved or replaced, and
                // this watch is dead. The check re-arms it on whatever directory is there then.
                entry.handle?.close();
                entry.handle = null;
                this.scheduleCheck(runtime, clone.path);
                return;
              }
              if (name !== null && !entry.names.has(name)) return;
              this.scheduleCheck(runtime, clone.path);
            },
            () => {
              // Re-armed by the next check of this clone or the next reconcile.
              entry.handle?.close();
              entry.handle = null;
            }
          );
        } catch {
          // A missing directory (or no watches left): the root watch and the reconcile cover it.
          entry.handle = null;
        }
      }
    }
  }

  private scheduleCheck(runtime: VaultRuntime, clonePath: string): void {
    if (!this.enabled || this.stopped) return;
    const watch = runtime.watches.get(clonePath);
    if (!watch) return;
    if (watch.timer !== null) this.timers.clearTimeout(watch.timer);
    watch.timer = this.timers.setTimeout(() => {
      watch.timer = null;
      if (!this.enabled || this.stopped) return;
      void this.enqueue(runtime, () => this.refreshVault(runtime, { only: clonePath, scan: false, git: false, auto: true })).catch((error) =>
        this.logger.warn(`secret-files: checking a clone of ${runtime.workspace}/${runtime.repoKey} failed (${errorText(error)})`)
      );
    }, this.debounceMs);
  }

  private closeCloneWatch(watch: CloneWatch): void {
    if (watch.timer !== null) this.timers.clearTimeout(watch.timer);
    watch.timer = null;
    for (const dirWatch of watch.dirs.values()) dirWatch.handle?.close();
    watch.dirs.clear();
  }

  private closeWatches(runtime: VaultRuntime): void {
    for (const watch of runtime.watches.values()) this.closeCloneWatch(watch);
    runtime.watches.clear();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `retired` with `files` retired too: each goes to the front, merged with an earlier retirement of
 * its path (newest versions first, at most SECRET_FILE_HISTORY_MAX), at most
 * SECRET_FILES_MAX_PER_VAULT retired files (the oldest retirements drop off).
 */
function retire(retired: readonly VaultFileRecord[], files: readonly VaultFileRecord[]): VaultFileRecord[] {
  let out = [...retired];
  for (const file of files) {
    const earlier = out.find((candidate) => candidate.path === file.path);
    const ids = new Set(file.versions.map((version) => version.id));
    const versions = [...file.versions, ...(earlier?.versions.filter((version) => !ids.has(version.id)) ?? [])].slice(0, SECRET_FILE_HISTORY_MAX);
    out = [{ ...earlier, ...file, versions }, ...out.filter((candidate) => candidate.path !== file.path)];
  }
  return out.slice(0, SECRET_FILES_MAX_PER_VAULT);
}

/** The vault's clones: non-archived projects of that workspace with that repoKey, by name. */
function clonesOf(projects: readonly SecretFilesProject[], workspace: string, repoKey: string): SecretFilesProject[] {
  return projects
    .filter((project) => project.workspace === workspace && project.repoKey === repoKey && project.isArchived !== true)
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

function lineCountOf(content: Uint8Array): number {
  const text = Buffer.from(content).toString("utf8");
  if (text.length === 0) return 0;
  const lines = text.split(/\r?\n/);
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

/** Per key, per variant: a small class number shared by variants with an equal value (null: no such key). */
function valueClasses(variants: SecretFileVariant[], parsed: Array<Map<string, string>>): NonNullable<SecretFileCandidate["keys"]> {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const env of parsed) {
    for (const key of env.keys()) {
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
  }
  return order.map((key) => {
    const classes = new Map<string, number>();
    const byVariant: Record<string, number | null> = {};
    variants.forEach((variant, index) => {
      const value = parsed[index]!.get(key);
      if (value === undefined) {
        byVariant[variant.variantId] = null;
        return;
      }
      if (!classes.has(value)) classes.set(value, classes.size);
      byVariant[variant.variantId] = classes.get(value)!;
    });
    return { key, byVariant };
  });
}

/** Rebuild a compare from its known fields only, so nothing else can ride along. */
function sanitizeCompare(compare: SecretFileCompare): SecretFileCompare {
  if (compare.format === "env") {
    return { format: "env", keys: compare.keys.map(({ key, change }) => ({ key: String(key), change })) };
  }
  if (compare.format === "lines") {
    return { format: "lines", linesAdded: Number(compare.linesAdded) || 0, linesRemoved: Number(compare.linesRemoved) || 0 };
  }
  return { format: "missing", side: compare.side === "left" ? "left" : "right" };
}
