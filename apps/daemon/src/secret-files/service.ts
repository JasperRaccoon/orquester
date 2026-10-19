/**
 * The secret-files sync engine (spec docs/superpowers/specs/2026-10-19-secret-files-plugin-design.md
 * §3–§6): one vault per (workspace, repoKey), the per-clone file states of §4, the automatic copy /
 * update actions, Push / Reset, the setup scan, the watchers and the reconcile pass.
 *
 * Invariants:
 *
 * - **Nothing secret leaves this module.** Contents, content hashes and values stay in memory for the
 *   one operation that needs them; the wire carries paths, opaque version ids, timestamps, states and
 *   names-only compares. Errors and log lines name files and projects, never content.
 * - **One queue per vault.** Every operation on a vault — a route, a watcher check, a reconcile —
 *   runs in that vault's promise chain, so writes to its clones and to its record never interleave.
 *   A failing operation does not break the chain.
 * - **Clones** are the non-archived projects of the vault's workspace whose `repoKey` matches
 *   (projects of an archived workspace count as archived). An archived clone keeps its baselines;
 *   a clone that is no longer listed with that repo at all is pruned on the next full pass.
 * - **Automatic actions only while the plugin is on and the store is writable:** a `missing` file is
 *   copied in, an `outdated` one updated (each re-read right before the write, so an edit made
 *   meanwhile is never overwritten), and a `synced` clone's baseline is stamped. `modified`,
 *   `deleted`, `missing-dir` and `refused` files are never touched.
 * - **Plugin off:** no watcher, no timer, no write. Mutations answer 409 `SECRET_FILES_DISABLED`;
 *   reads (list, vault, candidates, compare) still answer, evaluated fresh without any automatic
 *   action, so Settings can show the vaults that exist.
 * - **Self-writes settle on their own:** a write the service makes fires the clone's watcher; the
 *   debounced check re-hashes the clone, finds it `synced`, and changes nothing — no event, no write.
 * - **Events** (`SECRET_FILES_CHANGED`) go out only when a vault's serialized detail changed.
 * - **No git on the hot path:** `trackedPaths` and `scanCandidates` run on full reconcile passes,
 *   operations and reads that need them, and for a clone seen for the first time — never on a
 *   watcher check.
 */

import { createHash } from "node:crypto";
import { watch as fsWatch } from "node:fs";
import { realpath as fsRealpath } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  SECRET_FILES_MAX_PER_VAULT,
  isConventionalSecretFileName,
  repoKeyProblem,
  secretFileNeedsAttention,
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
  type SecretVaultSummary,
  type SecretVaultsResponse
} from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";
import { isValidName } from "@orquester/config";
import {
  type CloneFileRead,
  compareContents,
  mergeEnvContents,
  parseEnv,
  readCloneFile,
  scanCandidates,
  trackedPaths,
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

/** The on-disk helpers of `files.ts` (injectable for tests). */
export interface SecretFilesFileOps {
  readCloneFile(cloneRoot: string, relPath: string): Promise<CloneFileRead>;
  writeCloneFile(cloneRoot: string, relPath: string, content: Uint8Array, mode?: number): Promise<void>;
  scanCandidates(cloneRoot: string): Promise<string[]>;
  trackedPaths(cloneRoot: string, relPaths: readonly string[]): Promise<Set<string>>;
  parseEnv(content: Uint8Array): Map<string, string> | null;
  compareContents(left: Uint8Array | null, right: Uint8Array | null): SecretFileCompare;
  mergeEnvContents(primary: Uint8Array, others: readonly Uint8Array[]): Uint8Array | null;
}

const DEFAULT_FILE_OPS: SecretFilesFileOps = {
  readCloneFile,
  writeCloneFile,
  scanCandidates: (cloneRoot) => scanCandidates(cloneRoot),
  trackedPaths: (cloneRoot, relPaths) => trackedPaths(cloneRoot, relPaths),
  parseEnv,
  compareContents,
  mergeEnvContents
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

const defaultWatch: SecretFilesWatchFn = (dir, onChange, onError) => {
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
    const path = pathOf(record.path);
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
  /** Entry names in this dir that matter (managed names; at the root also every path's first segment). */
  names: Set<string>;
}

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
  tracked: Map<string, Set<string>>;
  /** Per clone: its conventional candidates (refreshed on full passes and scans). */
  candidates: Map<string, string[]>;
  /** The last detail published (serialized), null before any. */
  lastPublished: string | null;
  watches: Map<string, CloneWatch>;
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
  private readonly timers: SecretFilesTimers;
  private readonly now: () => Date;
  private readonly realpath: (path: string) => Promise<string>;
  private readonly logger: SecretFilesLogger;
  private readonly debounceMs: number;
  private readonly listDebounceMs: number;
  private readonly intervalMs: number;

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
    this.timers = options.timers ?? realTimers;
    this.now = options.now ?? (() => new Date());
    this.realpath = options.realpath ?? fsRealpath;
    this.logger = options.logger ?? console;
    this.debounceMs = options.debounceMs ?? 500;
    this.listDebounceMs = options.listDebounceMs ?? 1000;
    this.intervalMs = options.intervalMs ?? 5 * 60_000;
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

  /** Stop watching and timing; waits for operations in flight. Nothing runs afterwards. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.deactivate();
    await this.idle();
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
    const runtime = this.runtime(workspace, repoKey);
    return this.enqueue(runtime, async () => {
      const record = this.store.get(workspace, repoKey);
      if (!record) throw new SecretFilesError("VAULT_NOT_FOUND", "This repo has no secret files vault in this workspace.");
      // While on, watchers and reconciles keep the evaluation fresh.
      if (this.enabled && runtime.evals) return this.detailOf(runtime, record);
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
      return { path, compare: sanitizeCompare(this.files.compareContents(read.kind === "file" ? read.content : null, right)) };
    });
  }

  /**
   * The setup scan: every conventional candidate in every clone (plus the vault's managed files), or
   * just `path` (one hand-typed path), with the clones' distinct copies as variants.
   */
  async candidates(query: { workspace?: unknown; repoKey?: unknown; path?: unknown }): Promise<SecretFileCandidatesResponse> {
    const { workspace, repoKey } = vaultIdOf(query.workspace, query.repoKey);
    const single = query.path === undefined || query.path === "" ? null : pathOf(query.path);
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
            const found = await this.files.scanCandidates(clone.path).catch(() => [] as string[]);
            runtime.candidates.set(clone.path, found);
            for (const path of found) conventional.add(path);
          })
        );
      }
      const paths = single ? [single] : [...new Set([...conventional, ...managed])].sort();

      // Per clone: which of `paths` git tracks, and each path's copy.
      const perClone = await Promise.all(
        clones.map(async (clone) => {
          const tracked = paths.length > 0 ? await this.files.trackedPaths(clone.path, paths).catch(() => new Set<string>()) : new Set<string>();
          const reads = new Map<string, CloneFileRead | { kind: "tracked" }>();
          for (const path of paths) {
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
        const parsed = ordered.map((group) => this.files.parseEnv(group.content));
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

  /** Add, exclude, include or stop managing files. */
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
    this.requireWritable();
    const runtime = this.runtime(workspace, repoKey);
    return this.enqueue(runtime, async () => {
      this.requireWritable();
      const record = this.requireVault(workspace, repoKey);
      const projects = await this.options.listProjects();
      const source = await this.resolveClone(workspace, repoKey, body.projectPath, projects);
      this.requireManaged(record, selection);
      const clones = clonesOf(projects, workspace, repoKey);
      runtime.clones = clones;
      // Fresh states for every clone, before the vault moves.
      const evals = new Map<string, Map<string, FileEval>>();
      await Promise.all(
        clones.map(async (clone) => {
          runtime.tracked.set(clone.path, await this.trackedIn(clone.path, record));
          evals.set(clone.path, await this.evaluateClone(clone, record, runtime.tracked.get(clone.path)!));
        })
      );
      const sourceEvals = evals.get(source.path)!;
      const wanted = selection ?? record.files.map((file) => file.path);
      const contents: Array<{ path: string; content: Uint8Array }> = [];
      for (const path of wanted) {
        if (sourceEvals.get(path)?.state !== "modified") continue;
        const read = await this.files.readCloneFile(source.path, path);
        if (read.kind !== "file") continue;
        contents.push({ path, content: read.content });
      }
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
    this.requireWritable();
    const runtime = this.runtime(workspace, repoKey);
    return this.enqueue(runtime, async () => {
      this.requireWritable();
      const record = this.requireVault(workspace, repoKey);
      const projects = await this.options.listProjects();
      const clone = await this.resolveClone(workspace, repoKey, body.projectPath, projects);
      this.requireManaged(record, selection);
      runtime.tracked.set(clone.path, await this.trackedIn(clone.path, record));
      const evals = await this.evaluateClone(clone, record, runtime.tracked.get(clone.path)!);
      const wanted = new Set(selection ?? record.files.map((file) => file.path));
      const written: Array<{ path: string; versionId: string }> = [];
      for (const file of record.files) {
        const current = file.versions[0];
        const evaluated = evals.get(file.path);
        if (!wanted.has(file.path) || !current || !evaluated || !RESETTABLE.includes(evaluated.state)) continue;
        const content = await this.store.readContent(current.sha256);
        try {
          await this.files.writeCloneFile(clone.path, file.path, content, evaluated.mode);
        } catch (error) {
          this.logger.warn(`secret-files: could not reset ${file.path} in ${clone.name} (${errorText(error)})`);
          throw new SecretFilesError("SECRET_FILES_ERROR", `Could not write ${file.path} in ${clone.name}.`);
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
          const tracked = await this.files.trackedPaths(clone.path, [path]).catch(() => new Set<string>());
          if (tracked.has(path)) continue;
          const read = await this.files.readCloneFile(clone.path, path).catch(() => null);
          if (read?.kind === "file") others.push(read.content);
        }
        const merged = this.files.mergeEnvContents(primaryContent, others);
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
    const tracked = await this.files.trackedPaths(clone.path, [path]).catch(() => new Set<string>());
    if (tracked.has(path)) throw new SecretFilesError("FILE_REFUSED", `${path} ${REFUSAL_TEXT.tracked} in ${clone.name}.`);
    const read = await this.files.readCloneFile(clone.path, path).catch((): CloneFileRead => ({ kind: "refused", refusal: "unreadable" }));
    if (read.kind === "refused") throw new SecretFilesError("FILE_REFUSED", `${path} ${REFUSAL_TEXT[read.refusal]} in ${clone.name}.`);
    if (read.kind === "missing") throw new SecretFilesError("SOURCE_MISSING", `${clone.name} has no ${path}.`);
    return read.content;
  }

  private async trackedIn(clonePath: string, record: VaultRecord): Promise<Set<string>> {
    const paths = record.files.map((file) => file.path);
    if (paths.length === 0) return new Set();
    return this.files.trackedPaths(clonePath, paths).catch(() => new Set<string>());
  }

  private async evaluateClone(clone: SecretFilesProject, record: VaultRecord, tracked: Set<string>): Promise<Map<string, FileEval>> {
    const out = new Map<string, FileEval>();
    const baselines = record.clones[clone.path]?.baselines ?? {};
    for (const file of record.files) {
      if (tracked.has(file.path)) {
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

  /** Record baselines (each only while that file's current version is still the one written). */
  private async setBaselines(
    workspace: string,
    repoKey: string,
    changes: Array<{ clonePath: string; entries: Array<{ path: string; versionId: string }> }>,
    prune: readonly string[] = []
  ): Promise<void> {
    if (changes.every((change) => change.entries.length === 0) && prune.length === 0) return;
    await this.store.update(workspace, repoKey, (current) => {
      if (!current) return null;
      for (const { clonePath, entries } of changes) {
        for (const { path, versionId } of entries) {
          const file = current.files.find((candidate) => candidate.path === path);
          if (file?.versions[0]?.id !== versionId) continue;
          (current.clones[clonePath] ??= { baselines: {} }).baselines[path] = versionId;
        }
      }
      for (const clonePath of prune) delete current.clones[clonePath];
      return current;
    });
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
      for (const path of [...runtime.candidates.keys()]) if (!live.has(path)) runtime.candidates.delete(path);
    }
    // A one-clone check needs the others' states already: without them it is a full refresh.
    const only = options.only !== undefined && runtime.evals !== null ? options.only : undefined;
    const targets = only ? runtime.clones.filter((clone) => clone.path === only) : runtime.clones;
    const snapshot = record;
    const evaluated = await Promise.all(
      targets.map(async (clone) => {
        if (options.git || !runtime.tracked.has(clone.path)) runtime.tracked.set(clone.path, await this.trackedIn(clone.path, snapshot));
        if (options.scan || !runtime.candidates.has(clone.path)) {
          runtime.candidates.set(clone.path, await this.files.scanCandidates(clone.path).catch(() => [] as string[]));
        }
        return { clone, evals: await this.evaluateClone(clone, snapshot, runtime.tracked.get(clone.path)!) };
      })
    );

    // §4's automatic actions.
    const changes: Array<{ clonePath: string; entries: Array<{ path: string; versionId: string }> }> = [];
    if (options.auto && this.enabled && !this.stopped && this.store.writable) {
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
          if (!unchanged) continue;
          try {
            await this.files.writeCloneFile(clone.path, file.path, content, evaluatedFile.state === "outdated" ? evaluatedFile.mode : undefined);
          } catch (error) {
            this.logger.warn(`secret-files: could not write ${file.path} in ${clone.name} (${errorText(error)})`);
            continue;
          }
          evals.set(file.path, { path: file.path, state: "synced", sha256: current.sha256, ...(evaluatedFile.mode === undefined ? {} : { mode: evaluatedFile.mode }) });
          entries.push({ path: file.path, versionId: current.id });
        }
        if (entries.length > 0) changes.push({ clonePath: clone.path, entries });
      }
    }
    const prune =
      listedPaths && !only && this.store.writable ? Object.keys(snapshot.clones).filter((path) => !listedPaths!.has(path)) : [];
    if (changes.length > 0 || prune.length > 0) {
      try {
        await this.setBaselines(workspace, repoKey, changes, prune);
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
    const detail = this.detailOf(runtime, record);
    this.publishIfChanged(runtime, detail);
    if (this.enabled && !this.stopped) this.syncWatches(runtime, record, only);
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
        files.push({ path: file.path, state: evaluated.state, ...(evaluated.refusal ? { refusal: evaluated.refusal } : {}) });
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

  private publishIfChanged(runtime: VaultRuntime, detail: SecretVaultDetail): void {
    const serialized = JSON.stringify(detail);
    if (serialized === runtime.lastPublished) return;
    runtime.lastPublished = serialized;
    this.emit({ vault: detail });
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
        candidates: new Map(),
        lastPublished: null,
        watches: new Map()
      };
      this.runtimes.set(key, runtime);
    }
    return runtime;
  }

  /** Forget a vault that no longer exists (its queue stays: later operations still serialize). */
  private dropRuntime(runtime: VaultRuntime, announce: boolean): void {
    this.closeWatches(runtime);
    runtime.clones = [];
    runtime.evals = null;
    runtime.tracked.clear();
    runtime.candidates.clear();
    runtime.lastPublished = null;
    if (announce) this.emit({ workspace: runtime.workspace, repoKey: runtime.repoKey, deleted: true });
  }

  private enqueue<T>(runtime: VaultRuntime, task: () => Promise<T>): Promise<T> {
    const result = runtime.queue.then(task);
    runtime.queue = result.then(
      () => undefined,
      () => undefined
    );
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

  /** Bring a vault's watches in line with its clones and files (`only`: that clone's alone). */
  private syncWatches(runtime: VaultRuntime, record: VaultRecord, only?: string): void {
    const live = new Set(runtime.clones.map((clone) => clone.path));
    if (!only) {
      for (const [clonePath, watch] of runtime.watches) {
        if (!live.has(clonePath)) {
          this.closeCloneWatch(watch);
          runtime.watches.delete(clonePath);
        }
      }
    }
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
    for (const clone of runtime.clones) {
      if (only && clone.path !== only) continue;
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
          dirWatch = { handle: null, names };
          watch.dirs.set(relDir, dirWatch);
        }
        dirWatch.names = names;
        if (dirWatch.handle) continue;
        const entry = dirWatch;
        try {
          entry.handle = this.watchFn(
            relDir === "" ? clone.path : join(clone.path, relDir),
            (filename) => {
              if (filename !== null && !entry.names.has(posix.basename(filename.split("\\").join("/")))) return;
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
