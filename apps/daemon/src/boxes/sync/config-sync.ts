/**
 * `BoxConfigSync` (spec §8.3): keeps every box's copy of the agent config it runs with equal to
 * the host's, and turns changes made inside a box into change sets the owner approves or denies.
 *
 * **State per (box, host path).** The baseline (`store.ts`) holds the view hash both sides last
 * agreed on and the box file's size and mtime then. With H = the host's view hash now, B = the
 * box's, K = the baseline (null = absent on that side):
 *
 * | situation | action |
 * |---|---|
 * | H = B | in sync; K := H |
 * | in a pending set, host unchanged since it was made | held: the box keeps its version |
 * | in a pending set, host changed | the set goes `stale`, the host copy is pushed (host wins) |
 * | account root, H = K (or no K and no host file) | box-made change: collected for approval |
 * | anything else | host wins: push the host copy, or delete the box file |
 *
 * Prepared Agent Profile dirs are host → box only (their versions are immutable on the host), so
 * every difference there is "anything else".
 *
 * **When it runs.** `ensureSynced` = a full pass (host walk, box walk, hashes) for the scope;
 * `watch` = host `fs.watch` → a host-only pass within ~`hostDebounceMs` (pushes, deletes), box
 * `fs.watch` → a pass over the reported paths, and a full pass on every reconnect; `turnEnded` =
 * a full pass over the box's account roots, then everything collected becomes ONE change set for
 * that thread. Box changes made while no turn runs (no `turnStarted` pending) are grouped after
 * `idleFlushMs` of quiet with `threadId: null`. Every operation on one box runs in that box's
 * queue, so passes, decisions and flushes never interleave.
 *
 * **Decisions** (`decide`): approve writes the box's version to the host (through symlinks to their
 * targets; MCP secrets restored by the codec) and then pushes it to every other box; deny puts the
 * host's version back in the box (or deletes a file the box added). A set whose host copy moved
 * since it was made is marked `stale` instead and the host copy wins; a file whose box copy moved
 * since (a newer change, in a newer set) is left out of the decision.
 */

import { randomUUID } from "node:crypto";
import { createReadStream, watch as watchFs, type FSWatcher } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { posix } from "node:path";
import type { Readable } from "node:stream";

import {
  BOX_CONFIG_DIFF_MAX_CHARS,
  boxToHostPath,
  type BoxConfigChangeFile,
  type BoxConfigChangeSet,
  type BoxConfigChangeState,
  type BoxConfigChangesResponse,
  type BoxFsChangeEvent
} from "@orquester/api";
import {
  boxesDir,
  boxSecretsPath,
  keysDir,
  secretFilesDir,
  sessionProfilePreparedRootDir,
  sessionProfileSourcesDir,
  workflowSecretsPath,
  type BoxSyncBaselineEntry,
  type StoredBoxConfigChangeFile,
  type StoredBoxConfigChangeSet
} from "@orquester/config";

import { unifiedDiff } from "../../mcp/tools/agent-profile-preview.ts";
import type { BoxConfigSync, BoxConnection, BoxHub, BoxSyncScope } from "../contracts.ts";
import { boxPathOf, boxStat, execBoxHasher, readBoxFile, removeBoxPath, walkBox, writeBoxFile, type BoxFile, type BoxHasher } from "./box-fs.ts";
import { syncCodec, type CodecContext } from "./codecs.ts";
import { hostFileAt, hostWriteTarget, HostViewHashes, relOf, sha256, walkHost, writeHostFileAtomic, type HostFile, type HostWatchTarget } from "./host-fs.ts";
import {
  isDeniedRealPath,
  isExecutableChange,
  isInsidePath,
  isSyncedRel,
  syncRootKind,
  syncRuleFor,
  type SyncAgent,
  type SyncRule
} from "./rules.ts";
import { BoxConfigChangeStore, BoxSyncBaselines } from "./store.ts";

export interface BoxSyncLogger {
  info?(message: string): void;
  warn?(message: string): void;
}

export interface BoxConfigSyncOptions {
  appdir: string;
  hub: Pick<BoxHub, "get" | "onConnectionChange">;
  /** Broadcast hook for `BOX_CONFIG_CHANGES_EVENT` (wired to the daemon broadcaster). */
  publish?: (payload: BoxConfigChangesResponse) => void;
  logger?: BoxSyncLogger;
  /** Agent Profiles prepared root; roots inside it are host → box only. Default from `appdir`. */
  preparedRoot?: string | null;
  /** Realpath roots never read nor written. Default: the daemon's keys, secret stores, box dir, profile sources. */
  denyRoots?: readonly string[];
  /** Host change → box push delay (coalesces bursts). */
  hostDebounceMs?: number;
  /** Quiet time before box changes made outside a turn become a change set. */
  idleFlushMs?: number;
  /** Box event coalescing delay. */
  boxEventDebounceMs?: number;
  hasher?: BoxHasher;
  /** Watch host trees with `fs.watch` (off: call {@link BoxConfigSyncService.hostChanged} instead). */
  watchHost?: boolean;
  now?: () => Date;
}

export class BoxSyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "BoxSyncError";
  }
}

/** One config root of a scope, with its rules. */
interface SyncRoot {
  key: string;
  root: string;
  agent: SyncAgent;
  rule: SyncRule;
}

interface HostWatcherEntry {
  watcher: FSWatcher;
  matchers: ((filename: string | null) => boolean)[];
}

interface Runtime {
  boxId: string;
  /** Watched scopes by key, ref-counted. */
  scopes: Map<string, { roots: SyncRoot[]; refs: number }>;
  /** Every root synced for this box (by `ensureSynced` or `watch`). */
  roots: Map<string, SyncRoot>;
  /** Box-made changes waiting to become a change set: host path → root. */
  collected: Map<string, SyncRoot>;
  /** Threads with a turn running in this box. */
  running: Set<string>;
  chain: Promise<void>;
  flushTimer: NodeJS.Timeout | null;
  hostTimer: NodeJS.Timeout | null;
  boxEventTimer: NodeJS.Timeout | null;
  boxEventPaths: Map<string, Set<string>>;
  hostTargets: Map<string, HostWatchTarget[]>;
  hostWatchers: Map<string, HostWatcherEntry>;
  /** Box `fs.watch` ids → the root and dir they cover. */
  boxWatches: Map<string, { root: SyncRoot; dir: string }>;
  connection: BoxConnection | null;
  unbind: (() => void)[];
  hubUnsub: (() => void) | null;
}

/** Both sides of one path, as a change set file sees them. */
interface Observed {
  rel: string;
  hostFile: HostFile | null;
  hostBytes: Buffer | null;
  hostView: Buffer | null;
  hh: string | null;
  boxMode: number | null;
  boxSize: number;
  boxMtimeMs: number;
  boxBytes: Buffer | null;
  boxView: Buffer | null;
  bh: string | null;
  /** A raw box file too large to read for a diff (its hash came from the box). */
  tooLarge: boolean;
  /** The host file is a config that does not parse: never synced, never overwritten. */
  unsyncable: boolean;
}

/** Text diffs are computed for files up to this size; larger ones say so instead. */
const DIFF_READ_MAX_BYTES = 1024 * 1024;

const WATCH_IGNORE = [".git", "node_modules", "__pycache__"];

function looksBinary(data: Buffer): boolean {
  if (data.subarray(0, 8000).includes(0)) return true;
  return !Buffer.from(data.toString("utf8"), "utf8").equals(data);
}

function toWireState(state: string): BoxConfigChangeState | null {
  return state === "pending" || state === "approved" || state === "denied" || state === "stale" ? state : null;
}

/** The wire shape of a stored set (internal pins stripped); null for a state this build does not know. */
export function wireChangeSet(set: StoredBoxConfigChangeSet): BoxConfigChangeSet | null {
  const state = toWireState(set.state);
  if (state === null) return null;
  return {
    id: set.id,
    boxId: set.boxId,
    threadId: set.threadId ?? null,
    createdAt: set.createdAt,
    decidedAt: set.decidedAt ?? null,
    state,
    files: set.files.map(
      (file): BoxConfigChangeFile => ({
        path: file.path,
        change: file.change === "added" || file.change === "deleted" ? file.change : "modified",
        executable: file.executable ?? false,
        diff: file.diff ?? "",
        truncated: file.truncated ?? false,
        binary: file.binary ?? false
      })
    )
  };
}

export class BoxConfigSyncService implements BoxConfigSync {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly store: BoxConfigChangeStore;
  private readonly baselines: BoxSyncBaselines;
  private readonly hashes = new HostViewHashes();
  private readonly hasher: BoxHasher;
  private readonly preparedRoot: string | null;
  private readonly denyRoots: readonly string[];
  private readonly hostDebounceMs: number;
  private readonly idleFlushMs: number;
  private readonly boxEventDebounceMs: number;
  private readonly now: () => Date;
  private watchCounter = 0;
  private closed = false;

  constructor(private readonly options: BoxConfigSyncOptions) {
    this.now = options.now ?? (() => new Date());
    this.store = new BoxConfigChangeStore(options.appdir, this.now);
    this.baselines = new BoxSyncBaselines(options.appdir);
    this.hasher = options.hasher ?? execBoxHasher;
    this.preparedRoot = options.preparedRoot === undefined ? sessionProfilePreparedRootDir(options.appdir) : options.preparedRoot;
    this.denyRoots = options.denyRoots ?? [
      keysDir(options.appdir),
      boxesDir(options.appdir),
      boxSecretsPath(options.appdir),
      workflowSecretsPath(options.appdir),
      secretFilesDir(options.appdir),
      sessionProfileSourcesDir(options.appdir)
    ];
    this.hostDebounceMs = options.hostDebounceMs ?? 250;
    this.idleFlushMs = options.idleFlushMs ?? 3000;
    this.boxEventDebounceMs = options.boxEventDebounceMs ?? 100;
  }

  // -------------------------------------------------------------------------
  // BoxConfigSync
  // -------------------------------------------------------------------------

  async ensureSynced(boxId: string, scope: BoxSyncScope, signal: AbortSignal): Promise<void> {
    const roots = this.resolveRoots(scope);
    const connection = this.requireConnection(boxId);
    const runtime = this.runtime(boxId);
    for (const root of roots) runtime.roots.set(root.key, root);
    await this.enqueue(runtime, async () => {
      await this.store.load();
      await connection.request("agent.ensurePaths", { paths: roots.map((root) => boxPathOf(connection, root.root)) }, { signal });
      for (const root of roots) {
        signal.throwIfAborted();
        await this.pass(runtime, connection, root, { mode: "full", signal });
      }
    });
  }

  watch(boxId: string, scope: BoxSyncScope): () => void {
    const roots = this.resolveRoots(scope);
    const runtime = this.runtime(boxId);
    const key = roots
      .map((root) => root.key)
      .sort()
      .join("\n");
    const entry = runtime.scopes.get(key) ?? { roots, refs: 0 };
    entry.refs += 1;
    runtime.scopes.set(key, entry);
    for (const root of roots) runtime.roots.set(root.key, root);
    const wasBound = runtime.connection !== null;
    this.attach(runtime);
    const bound = runtime.connection;
    if (wasBound && bound?.connected) {
      this.background(runtime, "watch start", async () => {
        await this.store.load();
        for (const root of roots) await this.pass(runtime, bound, root, { mode: "host" });
        await this.refreshWatches(runtime);
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.refs -= 1;
      if (entry.refs > 0) return;
      runtime.scopes.delete(key);
      if (runtime.scopes.size === 0) this.detach(runtime);
      else void this.enqueue(runtime, async () => this.refreshWatches(runtime)).catch(() => undefined);
    };
  }

  turnStarted(boxId: string, threadId: string): void {
    const runtime = this.runtime(boxId);
    runtime.running.add(threadId);
    if (runtime.flushTimer !== null) {
      clearTimeout(runtime.flushTimer);
      runtime.flushTimer = null;
    }
  }

  async turnEnded(boxId: string, threadId: string): Promise<void> {
    const runtime = this.runtime(boxId);
    runtime.running.delete(threadId);
    const connection = this.options.hub.get(boxId);
    if (!connection?.connected) {
      // Collected changes stay; the reconnect pass and the idle flush pick them up.
      return;
    }
    await this.enqueue(runtime, async () => {
      await this.store.load();
      for (const root of runtime.roots.values()) {
        if (root.rule.twoWay) await this.pass(runtime, connection, root, { mode: "full" });
      }
      await this.flush(runtime, connection, threadId);
    });
  }

  // -------------------------------------------------------------------------
  // Change sets (routes)
  // -------------------------------------------------------------------------

  /** Every change set, pending first, newest first within a state. */
  async listChanges(): Promise<BoxConfigChangeSet[]> {
    await this.store.load();
    return this.store
      .list()
      .map(wireChangeSet)
      .filter((set): set is BoxConfigChangeSet => set !== null)
      .sort((a, b) => {
        if ((a.state === "pending") !== (b.state === "pending")) return a.state === "pending" ? -1 : 1;
        return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      });
  }

  /** Approve or deny a pending set. Throws {@link BoxSyncError} (404 / 409) when it cannot be decided. */
  async decide(id: string, decision: "approve" | "deny"): Promise<BoxConfigChangeSet> {
    await this.store.load();
    const found = this.store.get(id);
    if (!found) throw new BoxSyncError("BOX_CONFIG_CHANGE_NOT_FOUND", "No such box config change.", 404);
    if (found.state !== "pending") throw new BoxSyncError("BOX_CONFIG_CHANGE_DECIDED", `This change was already ${found.state}.`, 409);
    const connection = this.options.hub.get(found.boxId);
    if (!connection?.connected) {
      throw new BoxSyncError("BOX_NOT_READY", "The box is not connected; its change can be decided once it is back.", 409);
    }
    const runtime = this.runtime(found.boxId);
    const decided = await this.enqueue(runtime, () => this.decideNow(runtime, connection, id, decision));
    const wire = wireChangeSet(decided);
    if (wire === null) throw new BoxSyncError("BOX_CONFIG_CHANGE_DECIDED", "This change has an unknown state.", 409);
    return wire;
  }

  /** Forget a destroyed box: stop its watches, drop its baseline, mark its pending sets stale. */
  async forgetBox(boxId: string): Promise<void> {
    const runtime = this.runtimes.get(boxId);
    if (runtime) {
      this.detach(runtime);
      this.runtimes.delete(boxId);
    }
    await this.store.load();
    let changed = false;
    for (const set of this.store.pending(boxId)) {
      set.state = "stale";
      set.decidedAt = this.now().toISOString();
      changed = true;
    }
    if (changed) {
      await this.store.save();
      await this.publish();
    }
    await this.baselines.forget(boxId);
  }

  /** A host file under a box's watched roots changed: push now (what the host watchers trigger, debounced). */
  async hostChanged(boxId: string): Promise<void> {
    const runtime = this.runtimes.get(boxId);
    if (runtime) await this.hostPassNow(runtime);
  }

  /** Wait for every queued operation of a box (tests, shutdown). */
  async idle(boxId?: string): Promise<void> {
    const runtimes = boxId === undefined ? [...this.runtimes.values()] : [this.runtimes.get(boxId)].filter((rt): rt is Runtime => rt !== undefined);
    for (const runtime of runtimes) {
      let chain: Promise<void>;
      do {
        chain = runtime.chain;
        await chain;
      } while (chain !== runtime.chain);
    }
    await this.baselines.flush();
  }

  /** Stop every watcher and timer; persist baselines. */
  async close(): Promise<void> {
    this.closed = true;
    for (const runtime of this.runtimes.values()) this.detach(runtime);
    await this.idle();
  }

  // -------------------------------------------------------------------------
  // Runtime plumbing
  // -------------------------------------------------------------------------

  private runtime(boxId: string): Runtime {
    let runtime = this.runtimes.get(boxId);
    if (!runtime) {
      runtime = {
        boxId,
        scopes: new Map(),
        roots: new Map(),
        collected: new Map(),
        running: new Set(),
        chain: Promise.resolve(),
        flushTimer: null,
        hostTimer: null,
        boxEventTimer: null,
        boxEventPaths: new Map(),
        hostTargets: new Map(),
        hostWatchers: new Map(),
        boxWatches: new Map(),
        connection: null,
        unbind: [],
        hubUnsub: null
      };
      this.runtimes.set(boxId, runtime);
    }
    return runtime;
  }

  private enqueue<T>(runtime: Runtime, operation: () => Promise<T>): Promise<T> {
    const result = runtime.chain.then(operation);
    runtime.chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** Background work: failures are logged (by kind, never content). */
  private background(runtime: Runtime, what: string, operation: () => Promise<void>): void {
    void this.enqueue(runtime, operation).catch((error: unknown) => {
      this.options.logger?.warn?.(`box sync (${runtime.boxId}): ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private requireConnection(boxId: string): BoxConnection {
    const connection = this.options.hub.get(boxId);
    if (!connection?.connected) throw new BoxSyncError("BOX_NOT_READY", "The box is not connected.", 409);
    return connection;
  }

  private resolveRoots(scope: BoxSyncScope): SyncRoot[] {
    const seen = new Set<string>();
    const roots: SyncRoot[] = [];
    for (const raw of scope.configRoots) {
      if (!raw.startsWith("/")) throw new BoxSyncError("BOX_INVALID_REQUEST", "Config roots must be absolute host paths.", 400);
      const root = posix.normalize(raw).replace(/\/+$/, "") || "/";
      const key = `${scope.agent}:${root}`;
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push({ key, root, agent: scope.agent, rule: syncRuleFor(scope.agent, syncRootKind(root, this.preparedRoot)) });
    }
    return roots;
  }

  private watchedRoots(runtime: Runtime): SyncRoot[] {
    const out = new Map<string, SyncRoot>();
    for (const scope of runtime.scopes.values()) for (const root of scope.roots) out.set(root.key, root);
    return [...out.values()];
  }

  private rootOf(runtime: Runtime, file: StoredBoxConfigChangeFile): SyncRoot | null {
    if (file.root !== undefined && file.agent !== undefined) {
      const agent = file.agent as SyncAgent;
      if (agent === "claude" || agent === "codex" || agent === "grok" || agent === "opencode") {
        return { key: `${agent}:${file.root}`, root: file.root, agent, rule: syncRuleFor(agent, syncRootKind(file.root, this.preparedRoot)) };
      }
    }
    for (const root of runtime.roots.values()) if (relOf(root.root, file.path) !== null) return root;
    return null;
  }

  private attach(runtime: Runtime): void {
    if (runtime.connection !== null || runtime.hubUnsub !== null) return;
    const connection = this.options.hub.get(runtime.boxId);
    if (connection) {
      this.bind(runtime, connection);
      return;
    }
    runtime.hubUnsub = this.options.hub.onConnectionChange((boxId, connected) => {
      if (boxId !== runtime.boxId || !connected || runtime.connection !== null) return;
      const next = this.options.hub.get(boxId);
      if (!next) return;
      runtime.hubUnsub?.();
      runtime.hubUnsub = null;
      this.bind(runtime, next);
    });
  }

  private bind(runtime: Runtime, connection: BoxConnection): void {
    runtime.connection = connection;
    runtime.unbind.push(
      connection.onEvent("fs.change", (data) => this.onBoxEvent(runtime, connection, data as BoxFsChangeEvent)),
      connection.onStatus((connected) => {
        runtime.boxWatches.clear();
        if (!connected || this.closed || runtime.scopes.size === 0) return;
        // Back: watches are gone on the box side; re-create them and compare everything.
        this.background(runtime, "reconnect pass", async () => {
          await this.store.load();
          for (const root of runtime.roots.values()) await this.pass(runtime, connection, root, { mode: "full" });
          await this.refreshWatches(runtime);
          if (runtime.collected.size > 0) this.scheduleFlush(runtime);
        });
      })
    );
    if (connection.connected) {
      this.background(runtime, "watch start", async () => {
        await this.store.load();
        for (const root of this.watchedRoots(runtime)) await this.pass(runtime, connection, root, { mode: "host" });
        await this.refreshWatches(runtime);
      });
    }
  }

  private detach(runtime: Runtime): void {
    for (const unbind of runtime.unbind.splice(0)) unbind();
    runtime.hubUnsub?.();
    runtime.hubUnsub = null;
    const connection = runtime.connection;
    runtime.connection = null;
    for (const timer of [runtime.flushTimer, runtime.hostTimer, runtime.boxEventTimer]) if (timer !== null) clearTimeout(timer);
    runtime.flushTimer = runtime.hostTimer = runtime.boxEventTimer = null;
    for (const entry of runtime.hostWatchers.values()) entry.watcher.close();
    runtime.hostWatchers.clear();
    runtime.hostTargets.clear();
    if (connection?.connected) {
      for (const watchId of runtime.boxWatches.keys()) {
        void connection.request("fs.unwatch", { watchId }).catch(() => undefined);
      }
    }
    runtime.boxWatches.clear();
  }

  // -------------------------------------------------------------------------
  // Watching
  // -------------------------------------------------------------------------

  /** Bring host and box watchers in line with the watched roots. */
  private async refreshWatches(runtime: Runtime): Promise<void> {
    if (this.closed) return;
    const roots = this.watchedRoots(runtime);
    this.refreshHostWatchers(runtime, roots);
    const connection = runtime.connection;
    if (!connection?.connected) return;
    const wanted = new Map<string, SyncRoot>();
    for (const root of roots) {
      if (!root.rule.twoWay) continue;
      wanted.set(root.root, root);
      for (const top of root.rule.include) {
        const dir = `${root.root}/${top}`;
        const info = await boxStat(connection, dir).catch(() => null);
        if (info?.kind === "dir") wanted.set(dir, root);
      }
    }
    const have = new Map([...runtime.boxWatches].map(([watchId, entry]) => [entry.dir, watchId]));
    for (const [dir, watchId] of have) {
      if (wanted.has(dir)) continue;
      runtime.boxWatches.delete(watchId);
      await connection.request("fs.unwatch", { watchId }).catch(() => undefined);
    }
    for (const [dir, root] of wanted) {
      if (have.has(dir)) continue;
      const watchId = `orq-sync-${runtime.boxId}-${++this.watchCounter}`;
      runtime.boxWatches.set(watchId, { root, dir });
      try {
        // The root itself non-recursively (top-level files, new top-level dirs); each included dir recursively.
        await connection.request("fs.watch", { watchId, path: boxPathOf(connection, dir), recursive: dir !== root.root, ignore: WATCH_IGNORE });
      } catch (error) {
        runtime.boxWatches.delete(watchId);
        this.options.logger?.warn?.(`box sync (${runtime.boxId}): box watch failed (${error instanceof Error ? error.message : String(error)}); relying on turn-end checks`);
      }
    }
  }

  private refreshHostWatchers(runtime: Runtime, roots: readonly SyncRoot[]): void {
    if (this.options.watchHost === false) return;
    const wanted = new Map<string, { dir: string; recursive: boolean; matchers: ((filename: string | null) => boolean)[] }>();
    for (const root of roots) {
      for (const target of runtime.hostTargets.get(root.key) ?? []) {
        const key = `${target.recursive ? "r" : "f"}:${target.dir}`;
        const entry = wanted.get(key) ?? { dir: target.dir, recursive: target.recursive, matchers: [] };
        const base = target.logical === root.root ? "" : relOf(root.root, target.logical);
        if (base === null) continue;
        if (target.name !== null) {
          const name = target.name;
          entry.matchers.push((filename) => filename === null || filename === name);
        } else {
          entry.matchers.push((filename) => {
            if (filename === null) return true;
            const rel = filename.replace(/\\/g, "/");
            return isSyncedRel(root.rule, base === "" ? rel : `${base}/${rel}`);
          });
        }
        wanted.set(key, entry);
      }
    }
    for (const [key, entry] of runtime.hostWatchers) {
      if (wanted.has(key)) continue;
      entry.watcher.close();
      runtime.hostWatchers.delete(key);
    }
    for (const [key, want] of wanted) {
      const existing = runtime.hostWatchers.get(key);
      if (existing) {
        existing.matchers = want.matchers;
        continue;
      }
      try {
        const watcher = watchFs(want.dir, { recursive: want.recursive, persistent: false });
        const entry: HostWatcherEntry = { watcher, matchers: want.matchers };
        watcher.on("change", (_event, filename) => {
          const name = filename === null ? null : filename.toString();
          if (entry.matchers.some((match) => match(name))) this.scheduleHostPass(runtime);
        });
        watcher.on("error", () => {
          watcher.close();
          runtime.hostWatchers.delete(key);
          // A watcher that died (dir replaced, inotify limit): the next pass recreates it.
          this.scheduleHostPass(runtime);
        });
        runtime.hostWatchers.set(key, entry);
      } catch (error) {
        this.options.logger?.warn?.(`box sync: cannot watch a host config dir (${(error as NodeJS.ErrnoException).code ?? "error"})`);
      }
    }
  }

  private scheduleHostPass(runtime: Runtime): void {
    if (this.closed || runtime.hostTimer !== null) return;
    runtime.hostTimer = setTimeout(() => {
      runtime.hostTimer = null;
      this.hostPassNow(runtime).catch((error: unknown) => {
        this.options.logger?.warn?.(`box sync (${runtime.boxId}): host pass failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.hostDebounceMs);
    runtime.hostTimer.unref?.();
  }

  /** Queue a host-only pass over the watched roots (pushes host changes, recreates watchers). */
  private hostPassNow(runtime: Runtime): Promise<void> {
    return this.enqueue(runtime, async () => {
      const connection = runtime.connection;
      if (!connection?.connected || this.closed) return;
      await this.store.load();
      for (const root of this.watchedRoots(runtime)) await this.pass(runtime, connection, root, { mode: "host" });
      await this.refreshWatches(runtime);
    });
  }

  private onBoxEvent(runtime: Runtime, connection: BoxConnection, event: BoxFsChangeEvent): void {
    const watch = runtime.boxWatches.get(event?.watchId);
    if (!watch || !Array.isArray(event.changes)) return;
    for (const change of event.changes) {
      const hostPath = typeof change?.path === "string" ? boxToHostPath(connection.paths, change.path) : null;
      if (hostPath === null || relOf(watch.root.root, hostPath) === null) continue;
      const paths = runtime.boxEventPaths.get(watch.root.key) ?? new Set<string>();
      paths.add(hostPath);
      runtime.boxEventPaths.set(watch.root.key, paths);
    }
    if (runtime.boxEventTimer !== null || runtime.boxEventPaths.size === 0) return;
    runtime.boxEventTimer = setTimeout(() => {
      runtime.boxEventTimer = null;
      const pending = new Map(runtime.boxEventPaths);
      runtime.boxEventPaths.clear();
      this.background(runtime, "box change check", async () => {
        if (!connection.connected) return;
        await this.store.load();
        let newTopDir = false;
        for (const [key, paths] of pending) {
          const root = runtime.roots.get(key);
          if (!root) continue;
          await this.pass(runtime, connection, root, { mode: "paths", paths });
          newTopDir ||= [...paths].some((path) => {
            const rel = relOf(root.root, path);
            return rel !== null && !rel.includes("/") && root.rule.include.has(rel);
          });
        }
        if (newTopDir) await this.refreshWatches(runtime);
      });
    }, this.boxEventDebounceMs);
    runtime.boxEventTimer.unref?.();
  }

  private scheduleFlush(runtime: Runtime): void {
    if (runtime.running.size > 0 || this.closed) return;
    if (runtime.flushTimer !== null) clearTimeout(runtime.flushTimer);
    runtime.flushTimer = setTimeout(() => {
      runtime.flushTimer = null;
      const connection = runtime.connection ?? this.options.hub.get(runtime.boxId);
      if (!connection?.connected || runtime.running.size > 0) return;
      this.background(runtime, "idle flush", () => this.flush(runtime, connection, null));
    }, this.idleFlushMs);
    runtime.flushTimer.unref?.();
  }

  // -------------------------------------------------------------------------
  // The pass
  // -------------------------------------------------------------------------

  /**
   * Compare one root and act (table in the module doc). Modes: `full` walks both sides; `host`
   * walks the host and trusts the baseline for the box (a host-change push); `paths` checks the
   * given host paths (and box dirs among them) on both sides.
   */
  private async pass(
    runtime: Runtime,
    connection: BoxConnection,
    root: SyncRoot,
    options: { mode: "full" | "host" | "paths"; paths?: ReadonlySet<string>; signal?: AbortSignal }
  ): Promise<void> {
    if (!connection.connected) return;
    const { mode, signal } = options;
    const ctx: CodecContext = { paths: connection.paths };
    const baseline = await this.baselines.get(runtime.boxId);
    const accept = (path: string): boolean => {
      const rel = relOf(root.root, path);
      return rel !== null && isSyncedRel(root.rule, rel);
    };

    // Host side (`paths` mode: looked up per candidate below).
    const host = new Map<string, HostFile>();
    let hostDirs = new Set<string>();
    if (mode !== "paths") {
      const tree = await walkHost(root.root, root.rule, this.denyRoots);
      for (const [path, file] of tree.files) host.set(path, file);
      hostDirs = tree.dirs;
      runtime.hostTargets.set(root.key, tree.watch);
    }
    // Box side (`host` mode: the baseline stands for it).
    let box: Map<string, BoxFile> | null = null;
    let boxDirs = new Set<string>();
    if (mode === "full") {
      const tree = await walkBox(connection, [...root.rule.include].map((top) => `${root.root}/${top}`), accept, signal);
      box = tree.files;
      boxDirs = tree.dirs;
    } else if (mode === "paths") {
      box = new Map();
      for (const path of options.paths ?? []) {
        if (!accept(path)) continue;
        const tree = await walkBox(connection, [path], accept, signal);
        for (const [child, file] of tree.files) box.set(child, file);
      }
    }

    // Candidates.
    const candidates = new Set<string>(host.keys());
    if (box) for (const path of box.keys()) candidates.add(path);
    for (const path of baseline.keys()) {
      if (relOf(root.root, path) === null) continue;
      if (mode === "paths" && ![...(options.paths ?? [])].some((p) => isInsidePath(path, p))) continue;
      candidates.add(path);
    }
    if (mode === "paths") {
      for (const path of options.paths ?? []) if (accept(path)) candidates.add(path);
      for (const path of candidates) {
        const file = await hostFileAt(root.root, root.rule, path, this.denyRoots);
        if (file) host.set(path, file);
      }
    }
    const hostHash = new Map<string, string | null>();
    for (const [path, file] of host) hostHash.set(path, await this.hashes.hash(file, root.rule, ctx));

    // Box view hashes.
    const boxHash = new Map<string, string | null>();
    const toHash: { path: string; file: BoxFile }[] = [];
    for (const path of candidates) {
      if (box === null) {
        boxHash.set(path, baseline.get(path)?.h ?? null);
        continue;
      }
      const file = box.get(path);
      const known = baseline.get(path);
      if (!file) boxHash.set(path, null);
      else if (known && known.s === file.size && known.m === file.mtimeMs) boxHash.set(path, known.h);
      else if (root.rule.codec(relOf(root.root, path)!) === "raw") toHash.push({ path, file });
      else {
        const bytes = await readBoxFile(connection, path, { signal });
        boxHash.set(path, bytes === null ? null : sha256(syncCodec(root.rule.codec(relOf(root.root, path)!)).boxView(bytes, ctx)));
      }
    }
    if (toHash.length > 0) {
      const hashed = await this.hasher(connection, toHash.map(({ path }) => ({ path })), signal);
      toHash.forEach(({ path }, index) => boxHash.set(path, hashed[index] ?? null));
    }

    // Pending sets of this box, by path (newest set wins).
    const pending = new Map<string, { set: StoredBoxConfigChangeSet; file: StoredBoxConfigChangeFile }>();
    for (const set of this.store.pending(runtime.boxId)) for (const file of set.files) pending.set(file.path, { set, file });

    const pushes: string[] = [];
    const removals: string[] = [];
    const staleSets = new Set<StoredBoxConfigChangeSet>();
    for (const path of [...candidates].sort()) {
      if (!accept(path)) continue;
      const hostFile = host.get(path);
      const hh = hostFile ? (hostHash.get(path) ?? null) : null;
      if (hostFile && hh === null) continue; // unparseable config: never touched
      const bh = boxHash.get(path) ?? null;
      const known = baseline.get(path);
      if (hh === bh) {
        if (box === null) continue; // `host` mode: unchanged on the host; says nothing about the box
        runtime.collected.delete(path);
        const file = box.get(path);
        if (hh === null || !file) baseline.delete(path);
        else baseline.set(path, { h: hh, s: file.size, m: file.mtimeMs });
        continue;
      }
      const held = pending.get(path);
      if (held) {
        if ((held.file.hostHash ?? null) !== hh) {
          staleSets.add(held.set);
          (hh === null ? removals : pushes).push(path);
        } else if (box !== null && (held.file.boxHash ?? null) !== bh) {
          runtime.collected.set(path, root);
        }
        continue;
      }
      if (mode === "host") {
        runtime.collected.delete(path);
        (hh === null ? removals : pushes).push(path);
        continue;
      }
      if (root.rule.twoWay && (known ? hh === known.h : hh === null)) {
        runtime.collected.set(path, root);
        continue;
      }
      runtime.collected.delete(path);
      (hh === null ? removals : pushes).push(path);
    }

    for (const path of pushes) {
      signal?.throwIfAborted();
      try {
        await this.pushToBox(connection, root, path, host.get(path)!, hostHash.get(path)!, baseline, ctx);
      } catch (error) {
        if (!connection.connected) throw error;
        this.options.logger?.warn?.(`box sync (${runtime.boxId}): pushing ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const path of removals) {
      await removeBoxPath(connection, path);
      baseline.delete(path);
    }
    if (mode === "full") {
      for (const dir of hostDirs) {
        if (!boxDirs.has(dir)) await connection.request("fs.mkdir", { path: boxPathOf(connection, dir), recursive: true });
      }
    }
    if (removals.length > 0) await this.pruneEmptyBoxDirs(connection, root, removals, hostDirs);
    for (const set of staleSets) await this.markStale(runtime, set, root);
    this.baselines.markDirty(runtime.boxId);
    if (runtime.collected.size > 0) this.scheduleFlush(runtime);
  }

  private async pushToBox(
    connection: BoxConnection,
    root: SyncRoot,
    path: string,
    hostFile: HostFile,
    hash: string,
    baseline: Map<string, BoxSyncBaselineEntry>,
    ctx: CodecContext
  ): Promise<void> {
    const codecId = root.rule.codec(hostFile.rel);
    let data: Buffer | Readable | null;
    if (codecId === "raw") {
      // Streamed; a host write racing it changes the host hash, so the next pass pushes again.
      data = createReadStream(hostFile.real);
    } else {
      const current = codecId === "claude-json" ? await readBoxFile(connection, path) : null;
      data = syncCodec(codecId).toBox(await readFile(hostFile.real), current, ctx);
    }
    if (data === null) return;
    // Derived (secret-blanked) copies are private; raw files keep their mode (exec bits matter).
    await writeBoxFile(connection, path, data, codecId === "raw" ? hostFile.mode : 0o600);
    const info = await boxStat(connection, path);
    if (info) baseline.set(path, { h: hash, s: info.size, m: info.mtimeMs });
  }

  /** Remove box dirs that a deletion emptied and that the host no longer has. */
  private async pruneEmptyBoxDirs(connection: BoxConnection, root: SyncRoot, removed: readonly string[], hostDirs: ReadonlySet<string>): Promise<void> {
    const dirs = new Set<string>();
    for (const path of removed) {
      for (let dir = posix.dirname(path); relOf(root.root, dir) !== null; dir = posix.dirname(dir)) dirs.add(dir);
    }
    for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
      if (hostDirs.has(dir)) continue;
      if ((await stat(dir).catch(() => null))?.isDirectory()) continue;
      const entries = await connection.request("fs.readdir", { path: boxPathOf(connection, dir) }).catch(() => null);
      if (entries !== null && entries.length === 0) await removeBoxPath(connection, dir, true).catch(() => undefined);
    }
  }

  private async markStale(runtime: Runtime, set: StoredBoxConfigChangeSet, root: SyncRoot | null): Promise<void> {
    if (set.state !== "pending") return;
    set.state = "stale";
    set.decidedAt = this.now().toISOString();
    // The set's other files are box changes no set covers now: look at them again.
    for (const file of set.files) {
      const fileRoot = root && relOf(root.root, file.path) !== null ? root : this.rootOf(runtime, file);
      if (fileRoot) runtime.collected.set(file.path, fileRoot);
    }
    await this.store.update(set);
    await this.publish();
  }

  // -------------------------------------------------------------------------
  // Change sets
  // -------------------------------------------------------------------------

  private async observe(connection: BoxConnection, root: SyncRoot, path: string): Promise<Observed | null> {
    const rel = relOf(root.root, path);
    if (rel === null || !isSyncedRel(root.rule, rel)) return null;
    const ctx: CodecContext = { paths: connection.paths };
    const codec = syncCodec(root.rule.codec(rel));
    const hostFile = await hostFileAt(root.root, root.rule, path, this.denyRoots);
    const hostBytes = hostFile ? await readFile(hostFile.real) : null;
    const hostView = hostBytes ? codec.hostView(hostBytes, ctx) : null;
    const info = await boxStat(connection, path);
    const boxFile = info?.kind === "file" ? info : null;
    const tooLarge = boxFile !== null && boxFile.size > DIFF_READ_MAX_BYTES && root.rule.codec(rel) === "raw";
    let boxBytes: Buffer | null = null;
    let bh: string | null = null;
    if (boxFile && !tooLarge) {
      boxBytes = await readBoxFile(connection, path);
      bh = boxBytes === null ? null : sha256(codec.boxView(boxBytes, ctx));
    } else if (boxFile) {
      bh = (await this.hasher(connection, [{ path }]))[0] ?? null;
    }
    return {
      rel,
      hostFile,
      hostBytes,
      hostView,
      hh: hostView === null ? null : sha256(hostView),
      boxMode: boxFile?.mode ?? null,
      boxSize: boxFile?.size ?? 0,
      boxMtimeMs: boxFile?.mtimeMs ?? 0,
      boxBytes,
      boxView: boxBytes === null ? null : codec.boxView(boxBytes, ctx),
      bh,
      tooLarge,
      unsyncable: hostBytes !== null && hostView === null
    };
  }

  /** Everything collected becomes one pending set (files that went back in sync are dropped). */
  private async flush(runtime: Runtime, connection: BoxConnection, threadId: string | null): Promise<void> {
    if (runtime.flushTimer !== null) {
      clearTimeout(runtime.flushTimer);
      runtime.flushTimer = null;
    }
    if (runtime.collected.size === 0 || !connection.connected) return;
    const collected = [...runtime.collected].sort(([a], [b]) => a.localeCompare(b));
    runtime.collected.clear();
    const baseline = await this.baselines.get(runtime.boxId);
    const pendingHashes = new Map<string, string | null>();
    for (const set of this.store.pending(runtime.boxId)) for (const file of set.files) pendingHashes.set(file.path, file.boxHash ?? null);
    const files: StoredBoxConfigChangeFile[] = [];
    for (const [path, root] of collected) {
      const seen = await this.observe(connection, root, path);
      if (seen === null || seen.unsyncable) continue;
      if (seen.hh === seen.bh) {
        if (seen.bh === null) baseline.delete(path);
        else baseline.set(path, { h: seen.bh, s: seen.boxSize, m: seen.boxMtimeMs });
        continue;
      }
      if (pendingHashes.has(path) && pendingHashes.get(path) === seen.bh) continue; // already waiting
      const change = seen.hh === null ? "added" : seen.bh === null ? "deleted" : "modified";
      const before = seen.hostView ?? Buffer.alloc(0);
      const after = seen.boxView ?? Buffer.alloc(0);
      const binary = !seen.tooLarge && (looksBinary(before) || looksBinary(after));
      let diff = "";
      let truncated = false;
      if (seen.tooLarge) {
        diff = `(${seen.boxSize} bytes: too large to show)`;
        truncated = true;
      } else if (!binary) {
        diff = unifiedDiff(before.toString("utf8"), after.toString("utf8"), `a${path}`, `b${path}`);
        if (diff.length > BOX_CONFIG_DIFF_MAX_CHARS) {
          diff = diff.slice(0, BOX_CONFIG_DIFF_MAX_CHARS);
          truncated = true;
        }
      }
      const codec = syncCodec(root.rule.codec(seen.rel));
      files.push({
        path,
        change,
        executable: isExecutableChange({
          rule: root.rule,
          rel: seen.rel,
          mode: seen.boxMode ?? seen.hostFile?.mode ?? null,
          content: seen.boxBytes,
          configKeysChanged: codec.executableKeysChanged(seen.hostView, seen.boxView)
        }),
        diff,
        truncated,
        binary,
        hostHash: seen.hh,
        boxHash: seen.bh,
        root: root.root,
        agent: root.agent
      });
    }
    this.baselines.markDirty(runtime.boxId);
    if (files.length === 0) return;
    await this.store.add({
      id: randomUUID(),
      boxId: runtime.boxId,
      threadId,
      createdAt: this.now().toISOString(),
      decidedAt: null,
      state: "pending",
      files
    });
    await this.publish();
  }

  private async decideNow(runtime: Runtime, connection: BoxConnection, id: string, decision: "approve" | "deny"): Promise<StoredBoxConfigChangeSet> {
    const set = this.store.get(id);
    if (!set) throw new BoxSyncError("BOX_CONFIG_CHANGE_NOT_FOUND", "No such box config change.", 404);
    if (set.state !== "pending") return set;
    const baseline = await this.baselines.get(runtime.boxId);
    const ctx: CodecContext = { paths: connection.paths };

    type Item = { file: StoredBoxConfigChangeFile; root: SyncRoot; seen: Observed };
    const items: Item[] = [];
    const stale: Item[] = [];
    for (const file of set.files) {
      const root = this.rootOf(runtime, file);
      if (!root) continue;
      const seen = await this.observe(connection, root, file.path);
      if (seen === null) continue; // no longer a synced path (rules or deny list): never applied
      const item = { file, root, seen };
      if (seen.hh !== (file.hostHash ?? null)) stale.push(item);
      else if (seen.bh === (file.boxHash ?? null)) items.push(item);
      // else: the box copy moved on since; a newer change covers it.
    }

    if (stale.length > 0) {
      // Host wins: the stale files get the host's version; the rest are looked at again.
      for (const { root, seen, file } of stale) await this.revertBox(connection, root, file.path, seen, baseline, ctx);
      await this.markStale(runtime, set, null);
      for (const { file } of stale) runtime.collected.delete(file.path);
      this.baselines.markDirty(runtime.boxId);
      if (runtime.collected.size > 0) this.scheduleFlush(runtime);
      return set;
    }

    if (decision === "approve") {
      for (const { file, root, seen } of items) await this.applyToHost(connection, root, file.path, seen, baseline, ctx);
    } else {
      for (const { file, root, seen } of items) await this.revertBox(connection, root, file.path, seen, baseline, ctx);
    }
    set.state = decision === "approve" ? "approved" : "denied";
    set.decidedAt = this.now().toISOString();
    await this.store.update(set);
    this.baselines.markDirty(runtime.boxId);
    await this.publish();
    if (decision === "approve") {
      // Every other box with these roots gets the host's new version.
      for (const other of this.runtimes.values()) {
        if (other === runtime || other.scopes.size === 0) continue;
        this.hostPassNow(other).catch((error: unknown) => {
          this.options.logger?.warn?.(`box sync (${other.boxId}): pushing an approved change failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
    return set;
  }

  /** Write the box's version of one file to the host (or delete it there). */
  private async applyToHost(
    connection: BoxConnection,
    root: SyncRoot,
    path: string,
    seen: Observed,
    baseline: Map<string, BoxSyncBaselineEntry>,
    ctx: CodecContext
  ): Promise<void> {
    if (seen.bh === null) {
      if (seen.hostFile) {
        if (isDeniedRealPath(seen.hostFile.real, this.denyRoots)) return;
        await rm(seen.hostFile.real, { force: true });
      }
      baseline.delete(path);
      return;
    }
    let boxBytes = seen.boxBytes;
    if (boxBytes === null) boxBytes = await readBoxFile(connection, path);
    if (boxBytes === null) return;
    const codec = syncCodec(root.rule.codec(seen.rel));
    const next = codec.toHost(boxBytes, seen.hostBytes, ctx);
    const target = seen.hostFile ? seen.hostFile.real : await hostWriteTarget(path);
    if (isDeniedRealPath(target, this.denyRoots)) {
      this.options.logger?.warn?.("box sync: an approved change targets a denied host path; skipped");
      return;
    }
    const mode = seen.hostFile ? seen.hostFile.mode : seen.boxMode !== null && (seen.boxMode & 0o111) !== 0 ? 0o700 : 0o600;
    await writeHostFileAtomic(target, next, mode);
    const view = codec.hostView(next, ctx);
    if (view !== null && sha256(view) === seen.bh) baseline.set(path, { h: seen.bh, s: seen.boxSize, m: seen.boxMtimeMs });
  }

  /** Put the host's version of one file back into the box (or delete the box's added file). */
  private async revertBox(
    connection: BoxConnection,
    root: SyncRoot,
    path: string,
    seen: Observed,
    baseline: Map<string, BoxSyncBaselineEntry>,
    ctx: CodecContext
  ): Promise<void> {
    if (seen.hostFile === null || seen.hh === null) {
      await removeBoxPath(connection, path);
      baseline.delete(path);
      return;
    }
    await this.pushToBox(connection, root, path, seen.hostFile, seen.hh, baseline, ctx);
  }

  private async publish(): Promise<void> {
    if (!this.options.publish) return;
    this.options.publish({ changes: await this.listChanges() });
  }
}
