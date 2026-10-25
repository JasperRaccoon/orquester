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
 *
 * **Sending.** A pass with at least `bulkMinFiles` raw files to send (a new box's first sync, a
 * plugin update) sends them as ONE gzipped tar stream extracted in the box (`tar-write`), then
 * reads the box's size and mtime of each with one concurrent listing of their dirs for the
 * baseline. `tar` keeps each file's mode bits (the box user's umask applies, as for any `tar -x`
 * by a non-root user: exec bits survive, group/other write may not) and its whole-second mtime.
 * If the box's `orq-agent` cannot inflate (older than `compression`) the stream goes plain; if
 * `tar-write` fails at all, the files go one by one. Codec'd configs, small batches and that
 * fallback use a file channel per file, `PUSH_CONCURRENCY` at a time.
 *
 * **Shared dirs: mirrored links.** `syncAccountHome` makes `skills`, `plugins` (and `commands`)
 * of every Claude account home links to ONE shared dir. On a POSIX box with identity paths, an
 * included top-level entry of an account root that is a link to a dir named like the entry
 * (`<home>/skills` → `…/.claude/skills`) becomes the same link in the box, and its target is
 * synced ONCE per box as a *linked root*: root = the target's parent, the account rule with only
 * that entry included, two-way like the account root. Its box paths are the target's (the box
 * uses the host's paths), so its baselines, change sets and approvals name the shared files
 * themselves: a box-made change under it is one change, approved once, written to the host file
 * it names (deny list checked on its realpath, as always), and pushed to every other box. The
 * account root then neither walks nor accepts anything below a mirrored entry. Not mirrored (the
 * link's target walked and materialized as before): Windows boxes (links need privileges there)
 * and mapped paths, prepared profile dirs, a target named otherwise, inside the root or holding
 * it, a denied target (never synced at all), and every box where making a link failed once.
 * When the host's entry stops being such a link the box link is removed and the entry syncs as
 * a real dir; when a real dir becomes one, the box's old copy moves to the target (if the box has
 * none yet; else it is dropped) with its baselines, and pending sets touching it go stale.
 *
 * **Claude's plugin cache.** Below `plugins/cache` only the dirs some `installed_plugins.json`
 * points at sync (the host's, and the box's so that a plugin installed in the box is collected
 * for approval with its files); old versions and `temp_git_*` clones stay out.
 */

import { randomUUID } from "node:crypto";
import { createReadStream, watch as watchFs, type FSWatcher } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
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
  daemonConfigDir,
  sessionProfilePreparedRootDir,
  type BoxSyncBaselineEntry,
  type StoredBoxConfigChangeFile,
  type StoredBoxConfigChangeSet
} from "@orquester/config";

import { agentHookScript, agentHookScriptPath } from "../../agent-hooks.ts";
import { unifiedDiff } from "../../mcp/tools/agent-profile-preview.ts";
import type { BoxConfigSync, BoxConnection, BoxHub, BoxSyncProgress, BoxSyncScope } from "../contracts.ts";
import {
  boxPathOf,
  boxStat,
  execBoxHasher,
  forEachLimited,
  readBoxFile,
  removeBoxPath,
  statBoxFiles,
  walkBox,
  writeBoxFile,
  writeBoxTar,
  type BoxFile,
  type BoxHasher
} from "./box-fs.ts";
import { syncCodec, type CodecContext } from "./codecs.ts";
import {
  hostFileAt,
  hostWriteTarget,
  HostViewHashes,
  isAbsentError,
  MAX_SYNC_FILE_BYTES,
  orAbsent,
  relOf,
  sha256,
  walkHost,
  writeHostFileAtomic,
  writeHostStreamAtomic,
  type HostFile,
  type HostWatchTarget
} from "./host-fs.ts";
import {
  CLAUDE_INSTALLED_PLUGINS_REL,
  defaultSyncDenyRoots,
  executableConfigKeys,
  installedPluginCacheDirs,
  isDeniedRealPath,
  isExecutableChange,
  isInsidePath,
  isSyncedRel,
  isUninstalledPluginCache,
  ruleExcluding,
  ruleWithOnly,
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
  /**
   * How long a `turnStarted` mark holds the idle flush without its `turnEnded` (default 6 h): a
   * turn whose end never arrives (the agent host gone mid-turn) must not hold a box's changes
   * back for good. Past it, the changes are grouped by the idle debounce again.
   */
  turnMarkMaxMs?: number;
  /** Box event coalescing delay. */
  boxEventDebounceMs?: number;
  hasher?: BoxHasher;
  /** Watch host trees with `fs.watch` (off: call {@link BoxConfigSyncService.hostChanged} instead). */
  watchHost?: boolean;
  /** A pass sending at least this many raw files sends them as one tar stream (default {@link BULK_MIN_FILES}). */
  bulkMinFiles?: number;
  now?: () => Date;
}

/** Raw files a pass sends as one tar stream from this many on. */
export const BULK_MIN_FILES = 16;
/** File channels (or removals, mkdirs) in flight at once when files go one by one. */
const PUSH_CONCURRENCY = 12;

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
  /** A linked root (module doc): the one top-level entry it stands for. */
  link?: string;
}

interface PassOptions {
  mode: "full" | "host" | "paths";
  paths?: ReadonlySet<string>;
  signal?: AbortSignal;
  onProgress?: (progress: BoxSyncProgress) => void;
}

function linkedRootKey(agent: SyncAgent, target: string): string {
  return `${agent}:link:${target}`;
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
  /** Threads with a turn running in this box → when it was marked (ms). */
  running: Map<string, number>;
  chain: Promise<void>;
  flushTimer: NodeJS.Timeout | null;
  hostTimer: NodeJS.Timeout | null;
  boxEventTimer: NodeJS.Timeout | null;
  boxEventPaths: Map<string, Set<string>>;
  hostTargets: Map<string, HostWatchTarget[]>;
  /** Root key → the host dirs its last host walk saw (a dir new since then gets a second look). */
  hostDirs: Map<string, Set<string>>;
  hostWatchers: Map<string, HostWatcherEntry>;
  /** Box `fs.watch` ids → the root and dir they cover. */
  boxWatches: Map<string, { root: SyncRoot; dir: string }>;
  connection: BoxConnection | null;
  unbind: (() => void)[];
  hubUnsub: (() => void) | null;
  /** Linked roots by key, with the keys of the roots whose link they stand for. */
  linked: Map<string, { root: SyncRoot; owners: Set<string> }>;
  /** Root key → its mirrored top-level entries (name → target realpath), as of its last host walk. */
  linksOf: Map<string, Map<string, string>>;
  /** Box top-level entries known (this connection) to be in the shape the host wants: path → `dir` or `link:<target>`. */
  boxTops: Map<string, string>;
  /** Making a link in this box failed: nothing is mirrored here any more. */
  noLinks: boolean;
  /** `tar-write` failed on this connection: files go one by one until it reconnects. */
  noTar: boolean;
  /** `orq-agent` here did not inflate a gzipped tar: plain ones until it reconnects. */
  noGzip: boolean;
  /** Root key → the plugin cache dirs the box's `installed_plugins.json` named at its last read. */
  boxPluginDirs: Map<string, Set<string>>;
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
  /** Connections whose box got the managed hook script ({@link BoxConfigSyncService.ensureHookScript}). */
  private readonly hookScripts = new WeakSet<BoxConnection>();
  private readonly denyRoots: readonly string[];
  private readonly hostDebounceMs: number;
  private readonly idleFlushMs: number;
  private readonly turnMarkMaxMs: number;
  private readonly boxEventDebounceMs: number;
  private readonly bulkMinFiles: number;
  private readonly now: () => Date;
  private watchCounter = 0;
  private closed = false;

  constructor(private readonly options: BoxConfigSyncOptions) {
    this.now = options.now ?? (() => new Date());
    this.store = new BoxConfigChangeStore(options.appdir, this.now);
    this.baselines = new BoxSyncBaselines(options.appdir);
    this.hasher = options.hasher ?? execBoxHasher;
    this.preparedRoot = options.preparedRoot === undefined ? sessionProfilePreparedRootDir(options.appdir) : options.preparedRoot;
    this.denyRoots = options.denyRoots ?? defaultSyncDenyRoots(options.appdir);
    this.hostDebounceMs = options.hostDebounceMs ?? 250;
    this.idleFlushMs = options.idleFlushMs ?? 3000;
    this.turnMarkMaxMs = options.turnMarkMaxMs ?? 6 * 60 * 60_000;
    this.boxEventDebounceMs = options.boxEventDebounceMs ?? 100;
    this.bulkMinFiles = options.bulkMinFiles ?? BULK_MIN_FILES;
  }

  // -------------------------------------------------------------------------
  // BoxConfigSync
  // -------------------------------------------------------------------------

  async ensureSynced(
    boxId: string,
    scope: BoxSyncScope,
    signal: AbortSignal,
    options: { onProgress?: (progress: BoxSyncProgress) => void } = {}
  ): Promise<void> {
    const roots = this.resolveRoots(scope);
    const connection = this.requireConnection(boxId);
    const runtime = this.runtime(boxId);
    for (const root of roots) runtime.roots.set(root.key, root);
    await this.enqueue(runtime, async () => {
      await this.store.load();
      await connection.request("agent.ensurePaths", { paths: roots.map((root) => boxPathOf(connection, root.root)) }, { signal });
      await this.ensureHookScript(connection);
      await this.passAll(runtime, connection, roots, { mode: "full", signal, onProgress: options.onProgress });
    });
  }

  /**
   * The managed hook script at its host path in the box, once per connection: the synced configs'
   * managed hooks (Codex `hooks.json`, Claude and Grok settings) run it by that path, and every
   * run of a missing one is a failed hook in the chat. It exits 0 there (no daemon socket to post
   * to). Best effort: a failure is logged, never the sync's.
   */
  private async ensureHookScript(connection: BoxConnection): Promise<void> {
    if (connection.sys.os === "win32" || this.hookScripts.has(connection)) return;
    const path = boxPathOf(connection, agentHookScriptPath(daemonConfigDir(this.options.appdir)));
    try {
      await connection.writeFile(path, agentHookScript(), { mode: 0o755, mkdirs: true });
      this.hookScripts.add(connection);
    } catch (error) {
      this.options.logger?.warn?.(`box sync (${connection.boxId}): could not write the agent hook script: ${error instanceof Error ? error.message : String(error)}`);
    }
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
        await this.passAll(runtime, bound, roots, { mode: "host" });
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
    runtime.running.set(threadId, this.now().getTime());
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
      const twoWay = [...runtime.roots.values()].filter((root) => root.rule.twoWay);
      await this.passAll(runtime, connection, twoWay, { mode: "full" });
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
        running: new Map(),
        chain: Promise.resolve(),
        flushTimer: null,
        hostTimer: null,
        boxEventTimer: null,
        boxEventPaths: new Map(),
        hostTargets: new Map(),
        hostDirs: new Map(),
        hostWatchers: new Map(),
        boxWatches: new Map(),
        connection: null,
        unbind: [],
        hubUnsub: null,
        linked: new Map(),
        linksOf: new Map(),
        boxTops: new Map(),
        noLinks: false,
        noTar: false,
        noGzip: false,
        boxPluginDirs: new Map()
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

  /** The watched roots and the linked roots they own: what host and box watchers cover. */
  private watchTargets(runtime: Runtime): SyncRoot[] {
    const roots = this.watchedRoots(runtime);
    const keys = new Set(roots.map((root) => root.key));
    for (const entry of runtime.linked.values()) {
      if (!keys.has(entry.root.key) && [...entry.owners].some((owner) => keys.has(owner))) {
        keys.add(entry.root.key);
        roots.push(entry.root);
      }
    }
    return roots;
  }

  /** A root this runtime syncs (a scope root or a linked root), by key. */
  private rootByKey(runtime: Runtime, key: string): SyncRoot | undefined {
    return runtime.roots.get(key) ?? runtime.linked.get(key)?.root;
  }

  private rootOf(runtime: Runtime, file: StoredBoxConfigChangeFile): SyncRoot | null {
    // A root synced now (a linked root's rule includes only its entry); else rebuilt from the record.
    for (const root of [...runtime.roots.values(), ...[...runtime.linked.values()].map((entry) => entry.root)]) {
      if ((file.root !== undefined && file.root !== root.root) || (file.agent !== undefined && file.agent !== root.agent)) continue;
      const rel = relOf(root.root, file.path);
      if (rel !== null && isSyncedRel(root.rule, rel) && !runtime.linksOf.get(root.key)?.has(rel.split("/")[0]!)) return root;
    }
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
        // What this connection learned about the box (its links, its orq-agent) is checked again.
        runtime.boxTops.clear();
        runtime.noTar = false;
        runtime.noGzip = false;
        if (!connected || this.closed || runtime.scopes.size === 0) return;
        // Back: watches are gone on the box side; re-create them and compare everything.
        this.background(runtime, "reconnect pass", async () => {
          await this.store.load();
          await this.passAll(runtime, connection, [...runtime.roots.values()], { mode: "full" });
          await this.refreshWatches(runtime);
          if (runtime.collected.size > 0) this.scheduleFlush(runtime);
        });
      })
    );
    if (connection.connected) {
      this.background(runtime, "watch start", async () => {
        await this.store.load();
        await this.passAll(runtime, connection, this.watchedRoots(runtime), { mode: "host" });
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
    runtime.hostDirs.clear();
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
    const roots = this.watchTargets(runtime);
    this.refreshHostWatchers(runtime, roots);
    const connection = runtime.connection;
    if (!connection?.connected) return;
    const wanted = new Map<string, SyncRoot>();
    for (const root of roots) {
      if (!root.rule.twoWay) continue;
      // A linked root's parent is not ours to watch: only its one entry is.
      if (root.link === undefined) wanted.set(root.root, root);
      const links = runtime.linksOf.get(root.key);
      for (const top of root.rule.include) {
        if (links?.has(top)) continue; // the linked root watches its target
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
        const watcher = watchFs(want.dir, { recursive: want.recursive });
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
  }

  /** Queue a host-only pass over the watched roots (pushes host changes, recreates watchers). */
  private hostPassNow(runtime: Runtime): Promise<void> {
    return this.enqueue(runtime, async () => {
      const connection = runtime.connection;
      if (!connection?.connected || this.closed) return;
      await this.store.load();
      await this.passAll(runtime, connection, this.watchedRoots(runtime), { mode: "host" });
      await this.refreshWatches(runtime);
    });
  }

  private onBoxEvent(runtime: Runtime, connection: BoxConnection, event: BoxFsChangeEvent): void {
    const watch = runtime.boxWatches.get(event?.watchId);
    if (!watch || !Array.isArray(event.changes)) return;
    for (const change of event.changes) {
      const hostPath = typeof change?.path === "string" ? boxToHostPath(connection.paths, change.path) : null;
      const rel = hostPath === null ? null : relOf(watch.root.root, hostPath);
      // Denied and excluded paths (the box's own access-token files) are invisible: not even checked.
      if (hostPath === null || rel === null || !isSyncedRel(watch.root.rule, rel)) continue;
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
          const root = this.rootByKey(runtime, key);
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
  }

  /** Whether a turn runs in the box; drops marks older than `turnMarkMaxMs` first. */
  private turnRunning(runtime: Runtime): boolean {
    const oldest = this.now().getTime() - this.turnMarkMaxMs;
    for (const [threadId, markedAt] of runtime.running) {
      if (markedAt < oldest) {
        runtime.running.delete(threadId);
        this.options.logger?.warn?.(`box ${runtime.boxId}: the turn of ${threadId} never ended; its changes are grouped by the idle debounce again`);
      }
    }
    return runtime.running.size > 0;
  }

  private scheduleFlush(runtime: Runtime): void {
    if (this.turnRunning(runtime) || this.closed) return;
    if (runtime.flushTimer !== null) clearTimeout(runtime.flushTimer);
    runtime.flushTimer = setTimeout(() => {
      runtime.flushTimer = null;
      const connection = runtime.connection ?? this.options.hub.get(runtime.boxId);
      if (!connection?.connected || this.turnRunning(runtime)) return;
      this.background(runtime, "idle flush", () => this.flush(runtime, connection, null));
    }, this.idleFlushMs);
  }

  // -------------------------------------------------------------------------
  // The pass
  // -------------------------------------------------------------------------

  /**
   * Pass `roots`, then every linked root they own (each once, after them: an account root's pass
   * makes the box links its linked roots' files are reached through).
   */
  private async passAll(runtime: Runtime, connection: BoxConnection, roots: readonly SyncRoot[], options: PassOptions): Promise<void> {
    const done = new Set<string>();
    for (const root of roots) {
      if (done.has(root.key)) continue;
      done.add(root.key);
      options.signal?.throwIfAborted();
      await this.pass(runtime, connection, root, options);
    }
    for (const root of roots) {
      for (const target of runtime.linksOf.get(root.key)?.values() ?? []) {
        const linked = runtime.linked.get(linkedRootKey(root.agent, target))?.root;
        if (!linked || done.has(linked.key)) continue;
        done.add(linked.key);
        options.signal?.throwIfAborted();
        await this.pass(runtime, connection, linked, options);
      }
    }
  }

  /** Whether `root`'s top-level dir links may be mirrored in this box (module doc). */
  private mirrorsLinks(runtime: Runtime, connection: BoxConnection, root: SyncRoot): boolean {
    return root.rule.twoWay && root.link === undefined && !runtime.noLinks && connection.sys.os !== "win32" && connection.paths.kind === "identity";
  }

  /** Record `root`'s mirrored links (from its host walk) and the linked roots they stand for. */
  private updateLinks(runtime: Runtime, root: SyncRoot, links: ReadonlyMap<string, string>): void {
    const keys = new Set<string>();
    for (const [top, target] of links) {
      const key = linkedRootKey(root.agent, target);
      keys.add(key);
      let entry = runtime.linked.get(key);
      if (!entry) {
        entry = { root: { key, root: posix.dirname(target), agent: root.agent, rule: ruleWithOnly(root.rule, top), link: top }, owners: new Set() };
        runtime.linked.set(key, entry);
      }
      entry.owners.add(root.key);
    }
    for (const target of runtime.linksOf.get(root.key)?.values() ?? []) {
      const key = linkedRootKey(root.agent, target);
      const entry = runtime.linked.get(key);
      if (keys.has(key) || !entry) continue;
      entry.owners.delete(root.key);
      if (entry.owners.size === 0) {
        // Nothing links it any more: no more passes nor watches (its box copy stays, unused).
        runtime.linked.delete(key);
        runtime.hostTargets.delete(key);
        runtime.hostDirs.delete(key);
      }
    }
    runtime.linksOf.set(root.key, new Map(links));
  }

  /**
   * The rule a pass of `root` goes by: its own, and for a Claude account root (or one of its
   * linked roots) with a `plugins/cache`, only the cache dirs an `installed_plugins.json` names
   * (the host's, plus the box's read in `full` passes and when a `paths` pass covers it). A
   * `paths` pass whose box file names new dirs also looks at those dirs (returned in `paths`).
   */
  private async passRule(
    runtime: Runtime,
    connection: BoxConnection,
    root: SyncRoot,
    options: PassOptions
  ): Promise<{ rule: SyncRule; paths: ReadonlySet<string> | undefined }> {
    const { rule } = root;
    if (rule.agent !== "claude" || rule.kind !== "account" || !rule.include.has("plugins")) return { rule, paths: options.paths };
    // A mirrored `plugins` is its linked root's to filter (it was at the last walk; one that stopped
    // being a link is filtered from the next pass on).
    if (runtime.linksOf.get(root.key)?.has("plugins")) return { rule, paths: options.paths };
    const listPath = `${root.root}/${CLAUDE_INSTALLED_PLUGINS_REL}`;
    let hostDirs: string[] | null = null;
    try {
      const file = await hostFileAt(root.root, rule, listPath, this.denyRoots);
      if (file) hostDirs = installedPluginCacheDirs(await readFile(file.real));
    } catch {
      hostDirs = null; // unreadable: no filter (as without the file)
    }
    let paths = options.paths;
    const known = runtime.boxPluginDirs.get(root.key);
    const readBox = options.mode === "full" || (options.mode === "paths" && [...(options.paths ?? [])].some((path) => isInsidePath(listPath, path)));
    if (readBox) {
      const bytes = await readBoxFile(connection, listPath, { signal: options.signal }).catch(() => undefined);
      if (bytes !== undefined) {
        const boxDirs = new Set(bytes === null ? [] : (installedPluginCacheDirs(bytes) ?? []));
        runtime.boxPluginDirs.set(root.key, boxDirs);
        if (options.mode === "paths") {
          const added = [...boxDirs].filter((dir) => !known?.has(dir) && !hostDirs?.includes(dir));
          if (added.length > 0) paths = new Set([...(options.paths ?? []), ...added.map((dir) => `${root.root}/plugins/cache/${dir}`)]);
        }
      }
    }
    if (hostDirs === null) return { rule, paths };
    const allowed = new Set([...hostDirs, ...(runtime.boxPluginDirs.get(root.key) ?? [])]);
    return { rule: ruleExcluding(rule, (rel) => isUninstalledPluginCache(rel, allowed)), paths };
  }

  /**
   * Compare one root and act (table in the module doc). Modes: `full` walks both sides; `host`
   * walks the host and trusts the baseline for the box (a host-change push); `paths` checks the
   * given host paths (and box dirs among them) on both sides.
   */
  private async pass(runtime: Runtime, connection: BoxConnection, root: SyncRoot, options: PassOptions): Promise<void> {
    if (!connection.connected) return;
    const { mode, signal, onProgress } = options;
    onProgress?.({ root: root.root, done: 0, total: 0 });
    const ctx: CodecContext = { paths: connection.paths };
    const baseline = await this.baselines.get(runtime.boxId);
    const { rule, paths: checkPaths } = await this.passRule(runtime, connection, root, options);

    // Host side (`paths` mode: looked up per candidate below).
    const host = new Map<string, HostFile>();
    let hostDirs = new Set<string>();
    /** Host paths whose state could not be read: nothing at or below them is pushed, deleted or recorded. */
    const unreadable: string[] = [];
    if (mode !== "paths") {
      const mirror = this.mirrorsLinks(runtime, connection, root);
      const tree = await walkHost(root.root, rule, this.denyRoots, {
        mirrorLink: mirror
          ? (name, real, rootReal) => posix.basename(real) === name && !isInsidePath(real, rootReal) && !isInsidePath(rootReal, real) && !isInsidePath(root.root, real)
          : undefined
      });
      for (const [path, file] of tree.files) host.set(path, file);
      hostDirs = tree.dirs;
      unreadable.push(...tree.unreadable);
      this.updateLinks(runtime, root, tree.links);
      if (!(await this.alignBoxTops(runtime, connection, root, tree.links, hostDirs, baseline, mode === "full", signal))) {
        // This box cannot make links: everything is materialized here from now on.
        runtime.noLinks = true;
        return this.pass(runtime, connection, root, options);
      }
      if (root.link !== undefined) {
        // A linked root watches its one dir (the target), not the whole parent.
        const dir = `${root.root}/${root.link}`;
        tree.watch = tree.watch.filter((target) => target.logical !== root.root);
        tree.watch.unshift({ dir, recursive: true, name: null, logical: dir });
      }
      runtime.hostTargets.set(root.key, tree.watch);
      // A dir that appeared since the last walk may still be filling (a skill installed as
      // mkdir, then its files): what lands in it before its watcher exists raises no event, so
      // the root gets one more host pass after the debounce.
      const before = runtime.hostDirs.get(root.key);
      runtime.hostDirs.set(root.key, tree.dirs);
      if (before !== undefined && [...tree.dirs].some((dir) => !before.has(dir))) this.scheduleHostPass(runtime);
    }
    // Mirrored entries are the linked roots' business: nothing below them is this root's.
    const links = runtime.linksOf.get(root.key) ?? new Map<string, string>();
    const accept = (path: string): boolean => {
      const rel = relOf(root.root, path);
      return rel !== null && !links.has(rel.split("/")[0]!) && isSyncedRel(rule, rel);
    };
    // Box side (`host` mode: the baseline stands for it).
    let box: Map<string, BoxFile> | null = null;
    let boxDirs = new Set<string>();
    if (mode === "full") {
      const starts = [...rule.include].filter((top) => !links.has(top)).map((top) => `${root.root}/${top}`);
      const tree = await walkBox(connection, starts, accept, signal);
      box = tree.files;
      boxDirs = tree.dirs;
    } else if (mode === "paths") {
      box = new Map();
      for (const path of checkPaths ?? []) {
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
      if (mode === "paths" && ![...(checkPaths ?? [])].some((p) => isInsidePath(path, p))) continue;
      candidates.add(path);
    }
    if (mode === "paths") {
      for (const path of checkPaths ?? []) if (accept(path)) candidates.add(path);
      for (const path of candidates) {
        try {
          const file = await hostFileAt(root.root, rule, path, this.denyRoots);
          if (file) host.set(path, file);
        } catch {
          unreadable.push(path);
        }
      }
    }
    const hostHash = new Map<string, string | null>();
    for (const [path, file] of host) {
      try {
        hostHash.set(path, await this.hashes.hash(file, root.rule, ctx));
      } catch (error) {
        if (isAbsentError(error)) host.delete(path); // removed since the walk
        else unreadable.push(path);
      }
    }
    if (unreadable.length > 0) {
      this.options.logger?.warn?.(`box sync (${runtime.boxId}): ${unreadable.length} host path(s) could not be read; the box keeps its copies there`);
    }
    const isUnreadable = (path: string): boolean => unreadable.some((dir) => isInsidePath(path, dir));

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
      if (!accept(path) || isUnreadable(path)) continue;
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
        // A box-made change: collected for approval, unless the CLI manages the file (left as the box has it).
        if (rule.hostOnly(relOf(root.root, path)!)) runtime.collected.delete(path);
        else runtime.collected.set(path, root);
        continue;
      }
      runtime.collected.delete(path);
      (hh === null ? removals : pushes).push(path);
    }

    // Sending: progress per file sent.
    let sent = 0;
    const sentOne = (): void => {
      sent = Math.min(pushes.length, sent + 1);
      onProgress?.({ root: root.root, done: sent, total: pushes.length });
    };
    if (pushes.length > 0) onProgress?.({ root: root.root, done: 0, total: pushes.length });
    let oneByOne = pushes;
    const raw = pushes.filter((path) => rule.codec(relOf(root.root, path)!) === "raw");
    if (raw.length >= this.bulkMinFiles && !runtime.noTar) {
      const bulk = await this.pushTar(runtime, connection, root, raw, host, hostHash, baseline, sentOne, signal);
      if (bulk) {
        const done = new Set(raw);
        oneByOne = pushes.filter((path) => !done.has(path));
        // The extracting tar made every dir on the way to what it wrote.
        for (const path of raw) for (let dir = posix.dirname(path); relOf(root.root, dir) !== null; dir = posix.dirname(dir)) boxDirs.add(dir);
      } else {
        sent = 0;
      }
    }
    await forEachLimited(oneByOne, PUSH_CONCURRENCY, async (path) => {
      signal?.throwIfAborted();
      try {
        await this.pushToBox(connection, root, path, host.get(path)!, hostHash.get(path)!, baseline, ctx);
      } catch (error) {
        if (!connection.connected) throw error;
        this.options.logger?.warn?.(`box sync (${runtime.boxId}): pushing ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      sentOne();
    });
    await forEachLimited(removals, PUSH_CONCURRENCY, async (path) => {
      await removeBoxPath(connection, path);
      baseline.delete(path);
    });
    if (mode === "full") {
      // Not in CLI-managed trees: the box CLI's own layout there stands (files sent make their dirs).
      const missing = [...hostDirs].filter((dir) => !boxDirs.has(dir) && !rule.hostOnly(relOf(root.root, dir) ?? ""));
      await forEachLimited(missing, PUSH_CONCURRENCY, async (dir) => {
        await connection.request("fs.mkdir", { path: boxPathOf(connection, dir), recursive: true });
      });
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

  /**
   * Send raw files as one tar stream (gzipped unless this box's `orq-agent` cannot inflate it) and
   * record each one's box size and mtime from one concurrent listing of their dirs. False (and
   * nothing recorded) when the box could not extract it: the caller sends them one by one.
   */
  private async pushTar(
    runtime: Runtime,
    connection: BoxConnection,
    root: SyncRoot,
    paths: readonly string[],
    host: ReadonlyMap<string, HostFile>,
    hostHash: ReadonlyMap<string, string | null>,
    baseline: Map<string, BoxSyncBaselineEntry>,
    onFile: () => void,
    signal: AbortSignal | undefined
  ): Promise<boolean> {
    const files = paths.map((path) => {
      const file = host.get(path)!;
      return { path, source: file.real, mode: file.mode };
    });
    let written: Map<string, number> | null = null;
    for (const gzip of runtime.noGzip ? [false] : [true, false]) {
      try {
        written = await writeBoxTar(connection, root.root, files, { gzip, signal, onFile });
        break;
      } catch (error) {
        if (!connection.connected || signal?.aborted) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        if (gzip) {
          runtime.noGzip = true;
          this.options.logger?.warn?.(`box sync (${runtime.boxId}): a gzipped bulk push failed (${reason}); sending it plain`);
        } else {
          runtime.noTar = true;
          this.options.logger?.warn?.(`box sync (${runtime.boxId}): a bulk push failed (${reason}); sending files one by one`);
        }
      }
    }
    if (written === null) return false;
    const boxFiles = await statBoxFiles(connection, paths, signal);
    for (const path of paths) {
      const bytes = written.get(path);
      const info = boxFiles.get(path);
      const hash = hostHash.get(path);
      // A file the box shows at another size than was sent is not known: the next pass hashes it.
      if (bytes !== undefined && info && info.size === bytes && hash) baseline.set(path, { h: hash, s: info.size, m: info.mtimeMs });
    }
    return true;
  }

  /**
   * Make the box's top-level entries of `root` take the host's shape (module doc): a mirrored link
   * is the same link in the box, pointing at the box copy of its target; a host dir is never a
   * link in the box. `verify` (full passes) checks the box even where this connection already
   * did. False when the box could not make a link.
   */
  private async alignBoxTops(
    runtime: Runtime,
    connection: BoxConnection,
    root: SyncRoot,
    links: ReadonlyMap<string, string>,
    hostDirs: ReadonlySet<string>,
    baseline: Map<string, BoxSyncBaselineEntry>,
    verify: boolean,
    signal: AbortSignal | undefined
  ): Promise<boolean> {
    if (root.link !== undefined) return true;
    const tops = [...root.rule.include].filter((top) => links.has(top) || hostDirs.has(`${root.root}/${top}`));
    let linked = true;
    await forEachLimited(tops, PUSH_CONCURRENCY, async (top) => {
      const path = `${root.root}/${top}`;
      const target = links.get(top) ?? null;
      const want = target === null ? "dir" : `link:${target}`;
      if (target !== null) this.dropBaselineBelow(baseline, path, null); // leftovers of a materialized copy
      if (!verify && runtime.boxTops.get(path) === want) return;
      const boxPath = boxPathOf(connection, path);
      const info = await connection.request("fs.stat", { path: boxPath, followSymlinks: false }, { signal });
      if (target === null) {
        if (info?.kind === "symlink") await removeBoxPath(connection, path);
        runtime.boxTops.set(path, want);
        return;
      }
      if (info?.kind === "symlink") {
        if (await this.sameBoxDir(connection, path, target, signal)) {
          runtime.boxTops.set(path, want);
          return;
        }
        await removeBoxPath(connection, path);
      } else if (info?.kind === "dir") {
        // A copy an earlier sync materialized (or the box made): it becomes the target's box copy
        // when there is none yet, else it goes. Pending sets naming its files go stale.
        await this.retireBoxTree(runtime, root, path);
        let there = await boxStat(connection, target, signal);
        if (there?.kind === "dir") {
          const entries = await connection.request("fs.readdir", { path: boxPathOf(connection, target) }, { signal }).catch(() => null);
          if (entries !== null && entries.length === 0) {
            await removeBoxPath(connection, target, true);
            there = null;
          }
        }
        let moved = false;
        if (there === null) {
          await connection.request("agent.ensurePaths", { paths: [boxPathOf(connection, posix.dirname(target))] }, { signal });
          moved = await connection.request("fs.rename", { from: boxPath, to: boxPathOf(connection, target) }, { signal }).then(
            () => true,
            () => false
          );
        }
        if (!moved) await removeBoxPath(connection, path, true);
        this.dropBaselineBelow(baseline, path, moved ? target : null);
      } else if (info !== null) {
        await removeBoxPath(connection, path);
      }
      try {
        // The link first: a box that cannot make one is left with nothing new.
        await connection.request("fs.symlink", { target: boxPathOf(connection, target), path: boxPath }, { signal });
        await connection.request("agent.ensurePaths", { paths: [boxPathOf(connection, target)] }, { signal });
      } catch (error) {
        if (!connection.connected || signal?.aborted) throw error;
        this.options.logger?.warn?.(
          `box sync (${runtime.boxId}): cannot make a link in the box (${error instanceof Error ? error.message : String(error)}); shared dirs are copied per account there`
        );
        linked = false;
        return;
      }
      runtime.boxTops.set(path, want);
    });
    return linked;
  }

  /** Whether the box's `path` (a link) leads to the box's `target` dir. */
  private async sameBoxDir(connection: BoxConnection, path: string, target: string, signal: AbortSignal | undefined): Promise<boolean> {
    const [via, real] = await Promise.all([boxStat(connection, path, signal), boxStat(connection, target, signal)]);
    if (via?.kind !== "dir" || real?.kind !== "dir") return false;
    if (via.identity !== null && real.identity !== null) return via.identity === real.identity;
    const resolve = (hostPath: string) => connection.request("fs.realpath", { path: boxPathOf(connection, hostPath) }, { signal }).catch(() => null);
    const [a, b] = await Promise.all([resolve(path), resolve(target)]);
    return a !== null && a === b;
  }

  /** Baseline entries below `dir` go, or move below `moveTo` (where the box's copy went). */
  private dropBaselineBelow(baseline: Map<string, BoxSyncBaselineEntry>, dir: string, moveTo: string | null): void {
    for (const [path, entry] of [...baseline]) {
      if (path === dir || !isInsidePath(path, dir)) continue;
      baseline.delete(path);
      if (moveTo !== null) {
        const next = `${moveTo}${path.slice(dir.length)}`;
        if (!baseline.has(next)) baseline.set(next, entry);
      }
    }
  }

  /** A box dir stops being `root`'s: pending sets naming files in it go stale; nothing in it stays collected. */
  private async retireBoxTree(runtime: Runtime, root: SyncRoot, dir: string): Promise<void> {
    for (const set of this.store.pending(runtime.boxId)) {
      if (set.files.some((file) => isInsidePath(file.path, dir))) await this.markStale(runtime, set, root);
    }
    for (const path of [...runtime.collected.keys()]) if (isInsidePath(path, dir)) runtime.collected.delete(path);
  }

  /** Remove box dirs that a deletion emptied and that the host no longer has. */
  private async pruneEmptyBoxDirs(connection: BoxConnection, root: SyncRoot, removed: readonly string[], hostDirs: ReadonlySet<string>): Promise<void> {
    const dirs = new Set<string>();
    for (const path of removed) {
      for (let dir = posix.dirname(path); relOf(root.root, dir) !== null; dir = posix.dirname(dir)) dirs.add(dir);
    }
    for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
      if (hostDirs.has(dir)) continue;
      // Kept unless the host dir is known to be absent (an unreadable one may still be there).
      const info = await orAbsent(stat(dir)).catch(() => undefined);
      if (info === undefined || info?.isDirectory()) continue;
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
      let seen: Observed | null;
      try {
        seen = await this.observe(connection, root, path);
      } catch (error) {
        if (!connection.connected) throw error;
        // An unreadable host copy: no card can say what changed; the next full pass looks again.
        this.options.logger?.warn?.(`box sync (${runtime.boxId}): a box change could not be compared: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
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
        // A deletion runs nothing on the host.
        executable:
          change !== "deleted" &&
          isExecutableChange({
            rule: root.rule,
            rel: seen.rel,
            mode: seen.boxMode ?? seen.hostFile?.mode ?? null,
            content: seen.boxBytes,
            configKeysChanged: codec.executableKeysChanged(seen.hostView, seen.boxView, executableConfigKeys(root.agent, seen.rel))
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
    const target = seen.hostFile ? seen.hostFile.real : await hostWriteTarget(path);
    if (isDeniedRealPath(target, this.denyRoots)) {
      this.options.logger?.warn?.("box sync: an approved change targets a denied host path; skipped");
      return;
    }
    const mode = seen.hostFile ? seen.hostFile.mode : seen.boxMode !== null && (seen.boxMode & 0o111) !== 0 ? 0o700 : 0o600;
    if (seen.tooLarge) {
      // Too large to read for the card (raw codec: the bytes are the view): the card stands on
      // the hash the box gave. The bytes travel once, into a host temp file hashed on the host,
      // and replace the host file only when they are exactly what was approved.
      await mkdir(posix.dirname(target), { recursive: true, mode: 0o700 });
      try {
        const stream = await connection.readFile(boxPathOf(connection, path), { length: MAX_SYNC_FILE_BYTES + 1 });
        await writeHostStreamAtomic(target, stream, mode, {
          maxBytes: MAX_SYNC_FILE_BYTES,
          check: ({ sha256: hash }) => (hash === seen.bh ? null : "the box sent other bytes than the approved ones")
        });
      } catch (error) {
        if (!connection.connected) throw error;
        this.options.logger?.warn?.(`box sync (${connection.boxId}): an approved change was not applied: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      baseline.set(path, { h: seen.bh, s: seen.boxSize, m: seen.boxMtimeMs });
      return;
    }
    const boxBytes = seen.boxBytes;
    if (boxBytes === null) return;
    const codec = syncCodec(root.rule.codec(seen.rel));
    const next = codec.toHost(boxBytes, seen.hostBytes, ctx);
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
      // A denied new skill leaves no empty dir behind (dirs the host has stay).
      await this.pruneEmptyBoxDirs(connection, root, [path], new Set());
      return;
    }
    await this.pushToBox(connection, root, path, seen.hostFile, seen.hh, baseline, ctx);
  }

  private async publish(): Promise<void> {
    if (!this.options.publish) return;
    this.options.publish({ changes: await this.listChanges() });
  }
}
