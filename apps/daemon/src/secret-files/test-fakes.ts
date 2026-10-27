/**
 * In-memory fakes for the secret-files service tests (service.test.ts, routes.test.ts): a vault
 * store, a clone filesystem with watchers, hand-fired timers, the plugin switch and the project
 * listing. Nothing touches the disk, git or the clock. The service uses its real pure helpers.
 */

import { createHash } from "node:crypto";
import { posix } from "node:path";
import { SECRET_FILE_HISTORY_MAX, isConventionalSecretFileName, type SecretFileUpdatedBy, type SecretFilesChangedPayload } from "@orquester/api";
import { type CloneFileRefusal, CloneFileError, type WriteCloneFileOptions } from "./files.ts";
import {
  SecretFilesService,
  type SecretFilesFileOps,
  type SecretFilesProject,
  type SecretFilesServiceOptions,
  type SecretFilesTimers,
  type SecretFilesWatchFn,
  type SecretVaultStoreLike
} from "./service.ts";
import { SecretVaultStoreError, type VaultFileVersion, type VaultRecord, type VaultTransaction } from "./vault-store.ts";

export const sha = (content: Uint8Array | string): string => createHash("sha256").update(content).digest("hex");
export const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "utf8"));
export const text = (content: Uint8Array): string => Buffer.from(content).toString("utf8");

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class FakeVaultStore implements SecretVaultStoreLike {
  writable = true;
  readonly records = new Map<string, VaultRecord>();
  readonly blobs = new Map<string, Uint8Array>();
  updates = 0;
  private counter = 0;
  private clock = 0;

  private key(workspace: string, repoKey: string): string {
    return `${workspace}\u0000${repoKey}`;
  }

  private stamp(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 9, 19, 12, 0, this.clock)).toISOString();
  }

  list(): VaultRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  get(workspace: string, repoKey: string): VaultRecord | undefined {
    const record = this.records.get(this.key(workspace, repoKey));
    return record ? structuredClone(record) : undefined;
  }

  async update(
    workspace: string,
    repoKey: string,
    mutate: (current: VaultRecord | undefined, tx: VaultTransaction) => Promise<VaultRecord | null> | VaultRecord | null
  ): Promise<VaultRecord | null> {
    if (!this.writable) throw new SecretVaultStoreError("SECRET_FILES_UNAVAILABLE", "read-only");
    const key = this.key(workspace, repoKey);
    const current = this.records.get(key);
    const tx: VaultTransaction = {
      putContent: async (content: Uint8Array, updatedBy: SecretFileUpdatedBy): Promise<VaultFileVersion> => {
        const hash = sha(content);
        this.blobs.set(hash, new Uint8Array(content));
        this.counter += 1;
        return { id: `v_${String(this.counter).padStart(8, "0")}`, sha256: hash, updatedAt: this.stamp(), updatedBy: { ...updatedBy } };
      }
    };
    const next = await mutate(current ? structuredClone(current) : undefined, tx);
    if (next === null) {
      if (current) {
        this.records.delete(key);
        this.updates += 1;
      }
      return null;
    }
    const record = structuredClone(next);
    for (const file of [...record.files, ...(record.retired ?? [])]) file.versions = file.versions.slice(0, SECRET_FILE_HISTORY_MAX);
    if (current && JSON.stringify({ ...current, updatedAt: "" }) === JSON.stringify({ ...record, updatedAt: "" })) return structuredClone(current);
    record.createdAt = current?.createdAt ?? this.stamp();
    record.updatedAt = this.stamp();
    this.records.set(key, record);
    this.updates += 1;
    return structuredClone(record);
  }

  async readContent(sha256: string): Promise<Uint8Array> {
    const blob = this.blobs.get(sha256);
    if (!blob) throw new SecretVaultStoreError("SECRET_FILES_ERROR", "gone");
    return new Uint8Array(blob);
  }
}

// ---------------------------------------------------------------------------
// Clone filesystem + watchers
// ---------------------------------------------------------------------------

interface FakeFile {
  content: Uint8Array;
  mode: number;
  mtimeMs: number;
}

interface FakeWatch {
  dir: string;
  onChange: (filename: string | null) => void;
  onError: (error: Error) => void;
  closed: boolean;
}

export class FakeFs {
  /** Absolute path → file. */
  readonly files = new Map<string, FakeFile>();
  readonly dirs = new Set<string>();
  /** Absolute path → refusal readCloneFile reports. */
  readonly refusals = new Map<string, CloneFileRefusal>();
  /** Clone root → paths git tracks there. */
  readonly tracked = new Map<string, Set<string>>();
  /** Clone roots where every git call fails. */
  readonly gitFails = new Set<string>();
  /** When set, git calls hang until their signal aborts (then reject). */
  gitHangs = false;
  readonly gitSignals: AbortSignal[] = [];
  readonly writes: Array<{ path: string; mode: number | undefined; options?: WriteCloneFileOptions }> = [];
  readonly watches: FakeWatch[] = [];
  /** Called with the absolute path at each readCloneFile / right before each write lands. */
  onRead: ((abs: string) => void) | null = null;
  onBeforeWrite: ((abs: string) => void) | null = null;
  gitCalls = 0;
  private mtime = 1_000_000;
  /** Directory -> identity; a directory removed and made again gets a new one (another inode). */
  private readonly dirIds = new Map<string, number>();
  private nextDirId = 1;

  mkdir(path: string): void {
    let dir = path;
    while (dir !== "/" && dir !== ".") {
      this.dirs.add(dir);
      if (!this.dirIds.has(dir)) this.dirIds.set(dir, this.nextDirId++);
      dir = posix.dirname(dir);
    }
  }

  /** Remove a directory and everything under it (with `notify`, its parent's watches see it). */
  rmdir(path: string, options: { notify?: boolean } = {}): void {
    for (const dir of [...this.dirs]) {
      if (dir === path || dir.startsWith(`${path}/`)) {
        this.dirs.delete(dir);
        this.dirIds.delete(dir);
      }
    }
    for (const file of [...this.files.keys()]) if (file.startsWith(`${path}/`)) this.files.delete(file);
    if (options.notify) this.emit(path);
  }

  readonly dirIdentity = async (dir: string): Promise<string | null> => {
    const id = this.dirIds.get(dir);
    return this.dirs.has(dir) && id !== undefined ? `dir-${id}` : null;
  };

  private async git(cloneRoot: string, signal?: AbortSignal): Promise<void> {
    this.gitCalls += 1;
    if (signal) this.gitSignals.push(signal);
    if (this.gitHangs) {
      await new Promise<never>((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      });
    }
    if (this.gitFails.has(cloneRoot)) throw Object.assign(new Error("fatal: failed"), { code: "EGIT" });
  }

  /** Put a file (as a user would): no watcher event unless `notify`. */
  put(path: string, content: string, options: { mode?: number; mtimeMs?: number; notify?: boolean } = {}): void {
    this.mkdir(posix.dirname(path));
    this.mtime += 1000;
    this.files.set(path, { content: bytes(content), mode: options.mode ?? 0o644, mtimeMs: options.mtimeMs ?? this.mtime });
    if (options.notify) this.emit(path);
  }

  remove(path: string, options: { notify?: boolean } = {}): void {
    this.files.delete(path);
    if (options.notify) this.emit(path);
  }

  read(path: string): string | undefined {
    const file = this.files.get(path);
    return file ? text(file.content) : undefined;
  }

  mode(path: string): number | undefined {
    return this.files.get(path)?.mode;
  }

  /** Fire every open watch on `path`'s directory with its name. */
  emit(path: string): void {
    for (const watch of this.watches) {
      if (!watch.closed && watch.dir === posix.dirname(path)) watch.onChange(posix.basename(path));
    }
  }

  openWatches(): FakeWatch[] {
    return this.watches.filter((watch) => !watch.closed);
  }

  readonly watch: SecretFilesWatchFn = (dir, onChange, onError) => {
    if (!this.dirs.has(dir)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const entry: FakeWatch = { dir, onChange, onError, closed: false };
    this.watches.push(entry);
    return { close: () => void (entry.closed = true) };
  };

  readonly ops: SecretFilesFileOps = {
    readCloneFile: async (cloneRoot, relPath) => {
      const abs = posix.join(cloneRoot, relPath);
      this.onRead?.(abs);
      const refusal = this.refusals.get(abs);
      if (refusal) return { kind: "refused", refusal };
      const file = this.files.get(abs);
      if (!file) return { kind: "missing", parentExists: this.dirs.has(posix.dirname(abs)) };
      return { kind: "file", content: new Uint8Array(file.content), mode: file.mode, mtimeMs: file.mtimeMs };
    },
    writeCloneFile: async (cloneRoot, relPath, content, mode, options) => {
      const abs = posix.join(cloneRoot, relPath);
      if (this.refusals.has(abs)) throw new CloneFileError("refused", { refusal: this.refusals.get(abs)! });
      if (!this.dirs.has(posix.dirname(abs))) throw new CloneFileError("no parent", { parentMissing: true });
      this.onBeforeWrite?.(abs);
      if (options?.createOnly && this.files.has(abs)) throw new CloneFileError("exists", { exists: true });
      this.mtime += 1000;
      this.files.set(abs, { content: new Uint8Array(content), mode: mode ?? 0o600, mtimeMs: this.mtime });
      this.writes.push({ path: abs, mode, ...(options ? { options } : {}) });
      // The atomic rename shows up on the directory watch, like the real one.
      this.emit(abs);
    },
    scanCandidates: async (cloneRoot, signal) => {
      await this.git(cloneRoot, signal);
      const tracked = this.tracked.get(cloneRoot) ?? new Set<string>();
      return [...this.files.keys()]
        .filter((path) => path.startsWith(`${cloneRoot}/`))
        .map((path) => path.slice(cloneRoot.length + 1))
        .filter((rel) => isConventionalSecretFileName(posix.basename(rel)) && !tracked.has(rel))
        .sort();
    },
    trackedPaths: async (cloneRoot, relPaths, signal) => {
      if (relPaths.length === 0) return new Set<string>();
      await this.git(cloneRoot, signal);
      const tracked = this.tracked.get(cloneRoot) ?? new Set<string>();
      return new Set(relPaths.filter((path) => tracked.has(path)));
    }
  };
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

interface FakeTimer {
  fn: () => void;
  ms: number;
  kind: "timeout" | "interval";
  active: boolean;
}

export class FakeTimers implements SecretFilesTimers {
  readonly timers: FakeTimer[] = [];

  setTimeout(fn: () => void, ms: number): unknown {
    const timer: FakeTimer = { fn, ms, kind: "timeout", active: true };
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(handle: unknown): void {
    (handle as FakeTimer).active = false;
  }

  setInterval(fn: () => void, ms: number): unknown {
    const timer: FakeTimer = { fn, ms, kind: "interval", active: true };
    this.timers.push(timer);
    return timer;
  }

  clearInterval(handle: unknown): void {
    (handle as FakeTimer).active = false;
  }

  pending(kind: "timeout" | "interval", ms?: number): FakeTimer[] {
    return this.timers.filter((timer) => timer.active && timer.kind === kind && (ms === undefined || timer.ms === ms));
  }

  /** Fire every pending timeout (optionally only those of `ms`); each fires once. */
  fireTimeouts(ms?: number): number {
    const due = this.pending("timeout", ms);
    for (const timer of due) {
      timer.active = false;
      timer.fn();
    }
    return due.length;
  }

  fireIntervals(): number {
    const due = this.pending("interval");
    for (const timer of due) timer.fn();
    return due.length;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export const WS = "acme";
export const REPO = "github.com/acme/engine";
export const root = (name: string, workspace = WS): string => `/ws/${workspace}/${name}`;

export interface Harness {
  service: SecretFilesService;
  store: FakeVaultStore;
  fs: FakeFs;
  timers: FakeTimers;
  projects: SecretFilesProject[];
  events: SecretFilesChangedPayload[];
  logs: string[];
  plugin: { enabled: boolean; set(enabled: boolean): void };
  /** Add a clone of REPO (its root dir exists). */
  clone(name: string, options?: { workspace?: string; repoKey?: string; isArchived?: boolean }): string;
  settle(): Promise<void>;
}

export async function makeHarness(options: { enabled?: boolean; overrides?: Partial<SecretFilesServiceOptions> } = {}): Promise<Harness> {
  const store = new FakeVaultStore();
  const fs = new FakeFs();
  const timers = new FakeTimers();
  const projects: SecretFilesProject[] = [];
  const events: SecretFilesChangedPayload[] = [];
  const logs: string[] = [];
  const listeners = new Set<(enabled: boolean) => void>();
  const plugin = {
    enabled: options.enabled ?? true,
    set(enabled: boolean) {
      plugin.enabled = enabled;
      for (const listener of listeners) listener(enabled);
    }
  };
  const service = new SecretFilesService({
    store,
    files: fs.ops,
    watch: fs.watch,
    dirIdentity: fs.dirIdentity,
    timers,
    listProjects: async () => projects.map((project) => ({ ...project })),
    pluginEnabled: () => plugin.enabled,
    onPluginChange: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    publish: (payload) => events.push(structuredClone(payload)),
    realpath: async (path) => path.replace(/\/+$/, "").replace("/alias/", "/ws/"),
    now: () => new Date(Date.UTC(2026, 9, 19, 12, 0, 0)),
    logger: { warn: (message) => logs.push(message), error: (message) => logs.push(message) },
    ...options.overrides
  });
  const harness: Harness = {
    service,
    store,
    fs,
    timers,
    projects,
    events,
    logs,
    plugin,
    clone(name, cloneOptions = {}) {
      const workspace = cloneOptions.workspace ?? WS;
      const path = root(name, workspace);
      fs.mkdir(path);
      projects.push({
        workspace,
        name,
        path,
        ...(cloneOptions.repoKey === "" ? {} : { repoKey: cloneOptions.repoKey ?? REPO }),
        ...(cloneOptions.isArchived ? { isArchived: true } : {})
      });
      return path;
    },
    settle: () => service.idle()
  };
  await service.start();
  await service.idle();
  return harness;
}
