/**
 * The built-in plugins behind Settings → Plugins (spec §3.3, §4.3–4.4, §5).
 * Both are turned on once for the whole server (`enabled`). "Better TS
 * Typecheck" is one engine — tsrs or tsc-rs, native ports of TypeScript 7 —
 * installed and kept up to date under `<appdir>/daemon/plugins/ts-rust/`, and
 * redirected to from every `tsc` an Orquester session runs inside a workspace
 * while the plugin is on.
 * "Excalidraw Whiteboard" ships with the app: its state is only `enabled`,
 * which the clients read to offer the whiteboard tab; it has no jobs.
 *
 * - **plugins.json** is the durable state. Every change is a read-modify-write
 *   of the file in one serialized queue, so the file on disk always wins over a
 *   stale copy in memory, and memory changes only after the write landed. A file
 *   that does not read or parse is never written over: every operation fails
 *   with `PLUGINS_UNREADABLE` (the preload then runs the real tsc).
 * - **The active engine** is the one plugins.json names (`engine`) when it has
 *   a build here, else the platform's default: tsrs where it has one, else
 *   tsc-rs. Checks, installs, rollback, the skip and the last error are the
 *   active engine's; tsc-rs's live in the record's own fields (as older builds
 *   wrote them), tsrs's under `tsrs`. Switching engine installs the new one
 *   (while on) when it has nothing usable; the other keeps its versions.
 * - **Jobs** (update checks and installs, rollback, removing downloads) run one
 *   at a time on the plugin's job queue. A check already queued is not queued
 *   again. Checks run at start, hourly, on demand, and when the plugin is
 *   turned on with nothing installed yet; scheduled ones only while it is on.
 * - **The preload** (`preload.cjs`) is rewritten at start and whenever the
 *   workspaces dir moves, while the plugin is on or once one exists. It is
 *   never deleted: running sessions reference it through NODE_OPTIONS. New
 *   sessions load it while the plugin is on and the write succeeded
 *   (`setSessionNodePreload`).
 *
 * An older build turned tsc-rs on per workspace (`enabledWorkspaces`). A record
 * with that list non-empty and no `enabled` is turned on at start; the list is
 * left in the file for those builds until the plugin is turned off.
 *
 * `events` emits `"changed"` with the whole {@link PluginsResponse} after every
 * state or job change, in order.
 *
 * Boxes (Ephemeral AI VMs spec §10): the box tooling provisioner reads ts-rust's
 * state through `tsRustToolingState` and reports each box's install back
 * (`setBoxToolingStatusSource`, `boxToolingChanged`) as `PluginInfo.boxes`.
 *
 * Every plugin the daemon downloads (`updates: true`) has a {@link PluginUpdater}
 * and its own job lane: checks, installs, rollback and removing downloads run
 * one at a time per plugin, with the job state, the last error and the hourly
 * check its own. "Knowledge Graph" (knowledge/install) is the second one: uv, a
 * pinned myKG venv and an embedding model under its runtime dir. Its settings
 * live on its record (`settings`; `pluginSettings` / `updatePluginSettings`).
 */
import { EventEmitter } from "node:events";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type PluginBoxToolingStatus,
  type PluginId,
  type PluginInfo,
  type PluginJobState,
  type PluginsResponse,
  type SetPluginEnabledRequest,
  type TsCheckerEngine,
  PLUGINS_CHANGED_EVENT,
  PLUGINS_CHANNEL,
  TS_CHECKER_ENGINES,
  TS_RUST_PLUGIN_ID
} from "@orquester/api";
import {
  type PluginInstalledVersion,
  type PluginState,
  type PluginsConfig,
  createDefaultPluginsConfig,
  parsePluginsConfig,
  pluginStateOf,
  pluginsConfigPath,
  storedTsCheckerEngine,
  tsRustPreloadPath
} from "@orquester/config";
import type { Broadcaster } from "../broadcaster.ts";
import { createKnowledgeGraphUpdater } from "../knowledge/install/updater.ts";
import { BUILT_IN_PLUGINS, pluginCatalogEntry } from "./catalog.ts";
import { PluginsError } from "./errors.ts";
import { setSessionNodePreload } from "./session-env.ts";
import { type HostLibc, type TsRustInstallerDeps, defaultTsRustInstallerDeps, detectHostLibc } from "./ts-rust/installer.ts";
import { type TsRustPreloadOptions, writeTsRustPreload } from "./ts-rust/preload.ts";
import type { TsRustToolingState } from "./ts-rust/box-tooling.ts";
import { type TsRustUpdater, createTsRustUpdater, engineVersions } from "./ts-rust/updater.ts";
import type { PluginUpdateTarget, PluginUpdater } from "./updater.ts";

export { PluginsError } from "./errors.ts";
export type { PluginsErrorCode } from "./errors.ts";

/** How often a scheduled update check runs while the plugin is on. */
export const PLUGIN_CHECK_INTERVAL_MS = 60 * 60_000;

export interface PluginsServiceOptions {
  /** The appdir base; plugins.json and the plugin dirs come from the `packages/config` helpers. */
  baseDir: string;
  /** A getter: PUT /api/config/daemon can move it at runtime (then call `workspacesChanged`). */
  workspacesDir: () => string;
  /** Atomic JSON write (the daemon's `writeJsonFile`). */
  writeJson: (file: string, value: unknown) => Promise<void>;
  /** Registry, download, smoke-test runner and clock; the real ones by default. */
  installer?: TsRustInstallerDeps;
  /** The daemon's env, which the smoke test runs with (minus `ORQUESTER_*`). */
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  /** A Linux host's C library (picks tsrs's build); detected from Node's report by default. */
  libc?: HostLibc;
  writePreload?: (path: string, options: TsRustPreloadOptions) => Promise<void>;
  setSessionPreload?: (path: string | null) => void;
  /**
   * "Knowledge Graph"'s updater (uv, the myKG venv, the embedding model); by default
   * `createKnowledgeGraphUpdater` over the real network for this host.
   */
  knowledgeGraph?: PluginUpdater;
  logger?: Pick<Console, "warn" | "error">;
}

interface QueuedCheck {
  /** A manual check runs even while the plugin is off. */
  force: boolean;
}

/** One downloaded plugin's job lane: its updater, job state and serialized job queue. */
interface Lane {
  readonly updater: PluginUpdater;
  job: PluginJobState;
  jobQueue: Promise<unknown>;
  queuedCheck: QueuedCheck | null;
  jobAbort: AbortController | null;
}

/** The job state of every lane at one moment (the views carry it beside the config). */
type JobStates = ReadonlyMap<PluginId, PluginJobState>;

export class PluginsService {
  readonly events = new EventEmitter();

  private readonly configFile: string;
  private readonly preloadPath: string;
  /** ts-rust's engines, platform packages and version targets. */
  private readonly tsRust: TsRustUpdater;
  /** Each downloaded plugin's lane, in catalog order. */
  private readonly lanes = new Map<PluginId, Lane>();
  private readonly writePreload: (path: string, options: TsRustPreloadOptions) => Promise<void>;
  private readonly setSessionPreload: (path: string | null) => void;
  private readonly logger: Pick<Console, "warn" | "error">;

  /** The last plugins.json read or written; null until the first good read. */
  private config: PluginsConfig | null = null;
  /** Why the last read failed; set until a read succeeds again. */
  private readError: string | null = null;
  private fileQueue: Promise<unknown> = Promise.resolve();

  private runtimeQueue: Promise<unknown> = Promise.resolve();
  /** The real and configured workspaces roots the preload on disk was written with by this process; null if not (yet). */
  private preloadRoot: string | null = null;
  /** Whether the plugin was on at the last runtime refresh; null before the first. */
  private enabledAtRefresh: boolean | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private emitQueue: Promise<unknown> = Promise.resolve();
  /** boxes: each plugin's install status per box, from the box tooling provisioner. */
  private boxToolingStatus: ((id: PluginId) => PluginBoxToolingStatus[]) | null = null;
  /** Background refreshes in flight (`workspacesChanged`, the timer), for `settled()`. */
  private readonly inflight = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly options: PluginsServiceOptions) {
    this.configFile = pluginsConfigPath(options.baseDir);
    this.preloadPath = tsRustPreloadPath(options.baseDir);
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    const libc = platform === "linux" ? (options.libc ?? detectHostLibc()) : "glibc";
    const env = options.env ?? process.env;
    this.writePreload = options.writePreload ?? writeTsRustPreload;
    this.setSessionPreload = options.setSessionPreload ?? setSessionNodePreload;
    this.logger = options.logger ?? console;
    this.tsRust = createTsRustUpdater({
      baseDir: options.baseDir,
      platform,
      arch,
      libc,
      installer: options.installer ?? defaultTsRustInstallerDeps,
      env,
      logger: this.logger
    });
    const knowledgeGraph =
      options.knowledgeGraph ?? createKnowledgeGraphUpdater({ baseDir: options.baseDir, platform, arch, libc, env });
    for (const updater of [this.tsRust, knowledgeGraph]) {
      this.lanes.set(updater.id, { updater, job: "idle", jobQueue: Promise.resolve(), queuedCheck: null, jobAbort: null });
    }
    for (const entry of BUILT_IN_PLUGINS) {
      if (entry.updates !== this.lanes.has(entry.id)) {
        throw new Error(`Built-in plugin "${entry.id}" ${entry.updates ? "has no updater" : "ships with the app"}.`);
      }
    }
  }

  /**
   * Empty the staging dir, read plugins.json (turning a per-workspace record
   * on), write the preload, and queue the start-up check. Never throws: a bad
   * plugins.json is reported by the routes.
   */
  async start(): Promise<void> {
    for (const lane of this.lanes.values()) {
      await lane.updater.clearStaging().catch((error) => this.logger.warn(`Failed to empty the ${lane.updater.id} staging dir`, error));
    }
    await this.reload().catch((error) => this.logger.error("Failed to read plugins.json", error));
    await this.migrateWorkspaceRecord();
    await this.refreshRuntime();
    for (const lane of this.lanes.values()) this.requestCheck(lane, false);
  }

  /** Stop the timer, cancel the running jobs, and let queued file writes land. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.disarm();
    for (const lane of this.lanes.values()) lane.jobAbort?.abort();
    await Promise.all([...this.jobQueues(), this.fileQueue, this.runtimeQueue]).catch(() => undefined);
  }

  private jobQueues(): Promise<unknown>[] {
    return [...this.lanes.values()].map((lane) => lane.jobQueue);
  }

  /**
   * The workspaces dir moved, or a workspace under it came or went: rewrite the
   * preload when the root it has baked in is no longer the configured one.
   * Only a root move changes anything; the plugin is on for every workspace.
   */
  workspacesChanged(): Promise<void> {
    return this.track(async () => {
      if (await this.refreshRuntime()) this.emitChanged();
    });
  }

  /** Every queued job, state refresh and change event has run (for tests and shutdown). */
  async settled(): Promise<void> {
    for (;;) {
      const queues = [...this.jobQueues(), this.fileQueue, this.runtimeQueue, this.emitQueue, ...this.inflight];
      await Promise.all(queues).catch(() => undefined);
      const after = [...this.jobQueues(), this.fileQueue, this.runtimeQueue, this.emitQueue, ...this.inflight];
      if (after.length === queues.length && after.every((queue, index) => queue === queues[index])) return;
    }
  }

  /** Run `task` as a tracked background step that `settled()` waits for; never rejects. */
  private track(task: () => Promise<void>): Promise<void> {
    const run: Promise<void> = task()
      .catch((error) => this.logger.error("Plugin state refresh failed", error))
      .finally(() => this.inflight.delete(run));
    this.inflight.add(run);
    return run;
  }

  async list(): Promise<PluginsResponse> {
    await this.ensureReadable();
    return this.response(this.config, this.jobStates());
  }

  async get(id: PluginId): Promise<PluginInfo> {
    await this.ensureReadable();
    const [config, jobs] = [this.config, this.jobStates()];
    return this.info(id, config, jobs);
  }

  /**
   * Whether `id` is on, from the last good read of plugins.json (false before
   * one, or while the file does not read). For services that gate on a plugin.
   */
  isEnabled(id: PluginId): boolean {
    if (this.config === null || this.readError !== null) return false;
    return this.state(id).enabled === true;
  }

  /** The record's `settings` value as stored (unvalidated; the plugin reads it), or undefined. */
  pluginSettings(id: PluginId): unknown {
    if (this.config === null || this.readError !== null) return undefined;
    return this.state(id).settings;
  }

  /**
   * Merge `patch` into the record's `settings` object (a key set to undefined is
   * removed; keys the patch does not name, including ones another build wrote,
   * are kept). Written through the file queue; broadcasts the plugins. Resolves
   * the stored settings.
   */
  async updatePluginSettings(id: PluginId, patch: Record<string, unknown>): Promise<unknown> {
    pluginCatalogEntry(id);
    await this.ensureReadable();
    const settings = await this.mutate((config) => {
      const state = stateIn(config, id);
      const current = state.settings;
      const next: Record<string, unknown> =
        typeof current === "object" && current !== null && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      state.settings = next;
      return next;
    });
    this.emitChanged();
    return settings;
  }

  /**
   * Turn a plugin on or off for the whole server, and/or choose ts-rust's
   * engine. Turning ts-rust on is refused where no engine has a build, and
   * choosing an engine where it has none; while on, an active engine with
   * nothing usable installed gets its install queued, and new sessions follow
   * at once. Turning a plugin off drops an older build's per-workspace list
   * too, so no build reads it as on.
   */
  async update(id: PluginId, change: SetPluginEnabledRequest): Promise<PluginInfo> {
    pluginCatalogEntry(id);
    const lane = this.lanes.get(id);
    const { enabled, engine } = change;
    if (engine !== undefined) {
      if (id !== TS_RUST_PLUGIN_ID) {
        throw new PluginsError(400, "INVALID_REQUEST", "This plugin has no engine to choose.");
      }
      if (this.tsRust.platformPackages[engine] === null) throw this.tsRust.unsupported(engine);
    }
    if (enabled === true && lane && !lane.updater.supported()) {
      throw lane.updater.unsupported();
    }
    await this.ensureReadable();
    const on = await this.mutate((config) => {
      const state = stateIn(config, id);
      if (engine !== undefined) state.engine = engine;
      if (enabled === true) {
        state.enabled = true;
      } else if (enabled === false) {
        delete state.enabled;
        delete state.enabledWorkspaces;
      }
      return state.enabled === true;
    });
    this.emitChanged();
    if (lane) {
      await this.refreshRuntime();
      if (on) {
        await this.requestInstallIfMissing(lane);
      }
    }
    return this.get(id);
  }

  /** `POST /check`: queue a check now, whether or not the plugin is on. */
  async checkNow(id: PluginId): Promise<void> {
    const lane = this.assertUpdatable(id);
    if (!lane.updater.supported()) {
      throw lane.updater.unsupported();
    }
    await this.ensureReadable();
    this.requestCheck(lane, true);
  }

  /**
   * The active engine: swap current and previous, and skip the version rolled
   * back from until the registry's latest moves past it. Prunes nothing.
   */
  async rollback(id: PluginId): Promise<PluginInfo> {
    const lane = this.assertUpdatable(id);
    await this.ensureReadable();
    this.assertIdle(lane);
    await this.onJobQueue(lane, async () => {
      const target = lane.updater.target(this.state(id));
      const previous = target.versions(this.state(id)).previous;
      if (!previous) {
        throw new PluginsError(409, "NO_PREVIOUS_VERSION", "There is no previous version to roll back to.");
      }
      if (!(await installedFiles(target, previous.version))) {
        throw new PluginsError(409, "NO_PREVIOUS_VERSION", `The files of version ${previous.version} are missing.`);
      }
      await this.mutate((config) => {
        const state = target.versionsIn(stateIn(config, id));
        if (!state.previous || state.previous.version !== previous.version || !state.current) {
          throw new PluginsError(409, "NO_PREVIOUS_VERSION", "There is no previous version to roll back to.");
        }
        const from = state.current;
        state.current = state.previous;
        state.previous = from;
        state.skippedVersion = from.version;
      });
      this.emitChanged();
    });
    return this.get(id);
  }

  /** Delete every downloaded version (ts-rust: of every engine). Refused while the plugin is on. */
  async removeDownloads(id: PluginId): Promise<PluginInfo> {
    const lane = this.assertUpdatable(id);
    await this.ensureReadable();
    this.assertIdle(lane);
    await this.onJobQueue(lane, async () => {
      if (this.state(id).enabled === true) {
        throw new PluginsError(409, "PLUGIN_ENABLED", "Turn the plugin off before removing its downloads.");
      }
      await this.mutate((config) => {
        lane.updater.clearRecords(stateIn(config, id));
      });
      this.emitChanged();
      await lane.updater.removeFiles();
    });
    return this.get(id);
  }

  // ---- boxes (Ephemeral AI VMs spec §10) -----------------------------------------------------

  /**
   * ts-rust's state as the box tooling needs it: on or off, the engine
   * plugins.json names, and the host's current version of each engine. Null
   * while plugins.json does not read.
   */
  tsRustToolingState(): TsRustToolingState | null {
    if (this.config === null || this.readError !== null) return null;
    const state = this.state(TS_RUST_PLUGIN_ID);
    return {
      enabled: state.enabled === true,
      engine: storedTsCheckerEngine(state),
      current: {
        tsrs: engineVersions(state, "tsrs").current?.version ?? null,
        "tsc-rs": engineVersions(state, "tsc-rs").current?.version ?? null
      }
    };
  }

  /** Where `PluginInfo.boxes` comes from: the box tooling provisioner's statuses (null: none). */
  setBoxToolingStatusSource(source: ((id: PluginId) => PluginBoxToolingStatus[]) | null): void {
    this.boxToolingStatus = source;
  }

  /** A box's tooling status changed: publish the plugins again. */
  boxToolingChanged(): void {
    this.emitChanged();
  }

  // ---- update checks and installs ------------------------------------------------------------

  private requestCheck(lane: Lane, force: boolean): void {
    if (this.stopped || !lane.updater.supported()) return;
    if (lane.queuedCheck) {
      lane.queuedCheck.force ||= force;
      return;
    }
    const queued: QueuedCheck = { force };
    lane.queuedCheck = queued;
    void this.onJobQueue(lane, () => this.runCheck(lane, queued)).catch((error) =>
      this.logger.error(lane.updater.checkFailedMessage, error)
    );
  }

  /**
   * Queue a check when the plugin's active target has nothing usable
   * installed: no current version, or its files are gone. The check itself
   * runs only while the plugin is on.
   */
  private async requestInstallIfMissing(lane: Lane): Promise<void> {
    if (this.config === null || this.readError !== null) return;
    const state = this.state(lane.updater.id);
    const target = lane.updater.target(state);
    const current = target.versions(state).current;
    if (!current || !(await target.hasFiles(current.version))) {
      this.requestCheck(lane, false);
    }
  }

  /** A check and install of the target active when it starts; its outcome is recorded for that target. */
  private async runCheck(lane: Lane, queued: QueuedCheck): Promise<void> {
    const { updater } = lane;
    const id = updater.id;
    if (lane.queuedCheck === queued) lane.queuedCheck = null;
    if (this.stopped || this.config === null || this.readError !== null) return;
    if (!queued.force && this.state(id).enabled !== true) return;
    const target = updater.target(this.state(id));
    if (!target.available) return;

    const abort = new AbortController();
    lane.jobAbort = abort;
    this.setJob(lane, "checking");
    try {
      let installed: PluginInstalledVersion;
      let releaseVersion: string | undefined;
      try {
        const state = target.versions(this.state(id));
        // A current version whose files are gone (deleted from outside) is repaired: ts-rust's
        // every tsc would otherwise print "<engine> failed to start" until the downloads were removed.
        const currentMissing = state.current !== undefined && !(await target.hasFiles(state.current.version));
        // Nothing installed yet: the target's first-install version when it names one.
        let release = await target.resolve(abort.signal, state.current === undefined ? target.firstInstall : undefined);
        if (release.version === state.skippedVersion && currentMissing && state.current) {
          // Latest is the version rolled back from: reinstall the one rolled back to instead.
          release = await target.resolve(abort.signal, state.current.version);
        } else if (
          !currentMissing &&
          (release.version === state.current?.version || release.version === state.skippedVersion)
        ) {
          await this.recordCheck(lane, target, null);
          return;
        } else if (
          updater.skipFailedOnSchedule &&
          !queued.force &&
          !currentMissing &&
          state.current !== undefined &&
          state.lastError?.version === release.version
        ) {
          // This release failed to install last time and a working version is in place:
          // only a manual check tries it again.
          await this.recordCheck(lane, target, "keep");
          return;
        }
        releaseVersion = release.version;
        this.setJob(lane, "installing");
        installed = await target.install(release, abort.signal);
      } catch (error) {
        await this.recordCheck(lane, target, error, releaseVersion);
        return;
      }
      const at = updater.now().toISOString();
      const state = await this.mutate(async (config) => {
        const next = target.versionsIn(stateIn(config, id));
        if (next.current?.version !== installed.version) {
          // A current version whose files are gone is no rollback target: the old previous stays.
          if (next.current && (await installedFiles(target, next.current.version))) next.previous = next.current;
          // Only a version other than the skipped one gets here.
          delete next.skippedVersion;
        }
        // A repair of the current version keeps previous and the skip as they were.
        next.current = installed;
        delete next.lastError;
        next.lastCheckAt = at;
        return next;
      });
      const keep = [state.current?.version, state.previous?.version].filter((v): v is string => Boolean(v));
      await target.prune(keep).catch((error) => this.logger.warn(`Failed to prune old ${target.name} versions`, error));
    } finally {
      lane.jobAbort = null;
      this.setJob(lane, "idle");
    }
  }

  /**
   * Note a finished check of `target`: its time, and its error or none
   * (`"keep"`: leave the last error as it is). Nothing is written after `stop()`.
   */
  private async recordCheck(
    lane: Lane,
    target: PluginUpdateTarget,
    error: unknown,
    version?: string
  ): Promise<void> {
    if (this.stopped) return;
    const at = lane.updater.now().toISOString();
    if (error && error !== "keep") {
      this.logger.warn(`${target.name} update check failed`, error);
    }
    await this.mutate((config) => {
      const state = target.versionsIn(stateIn(config, lane.updater.id));
      state.lastCheckAt = at;
      if (error === "keep") return;
      if (error) {
        state.lastError = lane.updater.errorRecord(error, at, version);
      } else {
        delete state.lastError;
      }
    }).catch((writeError) => this.logger.error(`Failed to record the ${target.name} check`, writeError));
  }

  private onJobQueue<T>(lane: Lane, task: () => Promise<T>): Promise<T> {
    const run = lane.jobQueue.then(task);
    lane.jobQueue = run.catch(() => undefined);
    return run;
  }

  /** The version routes are for plugins the daemon downloads; a bundled one has no versions. */
  private assertUpdatable(id: PluginId): Lane {
    const lane = pluginCatalogEntry(id).updates ? this.lanes.get(id) : undefined;
    if (!lane) {
      throw new PluginsError(409, "PLUGIN_BUNDLED", "This plugin ships with Orquester and has no downloads or updates.");
    }
    return lane;
  }

  private assertIdle(lane: Lane): void {
    if (lane.job !== "idle" || lane.queuedCheck !== null) {
      throw new PluginsError(409, "PLUGIN_BUSY", "An update check or install is running; try again when it has finished.");
    }
  }

  private setJob(lane: Lane, job: PluginJobState): void {
    if (lane.job === job) return;
    lane.job = job;
    this.emitChanged();
  }

  private jobStates(): JobStates {
    return new Map([...this.lanes].map(([id, lane]) => [id, lane.job]));
  }

  // ---- preload, session env and the hourly timer ---------------------------------------------

  /**
   * Bring the runtime in line with the state: the preload written for the
   * current workspaces root, new sessions told whether to load it, and the
   * hourly timer armed while a downloaded plugin is on. Serialized. Resolves
   * whether ts-rust's on/off changed since the last refresh.
   */
  private refreshRuntime(): Promise<boolean> {
    const run = this.runtimeQueue.then(async (): Promise<boolean> => {
      const changed = await this.refreshTsRustPreload();
      this.syncTimer();
      return changed;
    });
    this.runtimeQueue = run.catch((error) => this.logger.error("Failed to refresh the plugin runtime", error));
    return run.catch(() => false);
  }

  /** ts-rust's part of {@link refreshRuntime}: the preload and the session env. */
  private async refreshTsRustPreload(): Promise<boolean> {
    if (!this.tsRust.supported() || this.stopped) {
      this.setSessionPreload(null);
      return false;
    }
    const enabled = this.config !== null && this.state(TS_RUST_PLUGIN_ID).enabled === true;
    const changed = enabled !== this.enabledAtRefresh;
    this.enabledAtRefresh = enabled;
    const workspacesDir = this.options.workspacesDir();
    const root = await realpath(workspacesDir).catch(() => resolve(workspacesDir));
    // Both spellings of a symlinked root: a `tsc` path can go through either, so a
    // move to another symlink of the same directory rewrites the preload too.
    const configured = resolve(workspacesDir);
    const roots = `${root}\0${configured}`;
    if (this.preloadRoot !== roots && (enabled || (await isFile(this.preloadPath)))) {
      try {
        await this.writePreload(this.preloadPath, {
          statePath: this.configFile,
          workspacesRoot: root,
          ...(configured !== root ? { configuredWorkspacesRoot: configured } : {}),
          supportedEngines: TS_CHECKER_ENGINES.filter((engine) => this.tsRust.platformPackages[engine] !== null),
          defaultEngine: this.tsRust.defaultEngine
        });
        this.preloadRoot = roots;
      } catch (error) {
        this.preloadRoot = null;
        this.logger.error("Failed to write the TypeScript engine preload", error);
      }
    }
    this.setSessionPreload(enabled && this.preloadRoot === roots ? this.preloadPath : null);
    return changed;
  }

  /** The hourly timer runs while any downloaded plugin with a build here is on. */
  private syncTimer(): void {
    const anyOn =
      !this.stopped &&
      this.config !== null &&
      [...this.lanes.values()].some((lane) => lane.updater.supported() && this.state(lane.updater.id).enabled === true);
    if (anyOn) {
      this.arm();
    } else {
      this.disarm();
    }
  }

  private arm(): void {
    if (this.timer !== null || this.stopped) return;
    this.timer = setInterval(() => {
      void this.track(async () => {
        if (await this.refreshRuntime()) this.emitChanged();
        // Each tick retries a preload write that failed. A check repairs missing files
        // too, and runs only while its plugin is on.
        for (const lane of this.lanes.values()) this.requestCheck(lane, false);
      });
    }, PLUGIN_CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  // ---- plugins.json --------------------------------------------------------------------------

  /**
   * Re-read a plugins.json that did not read before. Once it reads again
   * (repaired by hand), the runtime catches up: preload, session preload, timer,
   * a broadcast, and the install a broken file held back.
   */
  private async ensureReadable(): Promise<void> {
    if (this.config !== null && this.readError === null) return;
    await this.reload();
    await this.migrateWorkspaceRecord();
    await this.refreshRuntime();
    this.emitChanged();
    for (const lane of this.lanes.values()) await this.requestInstallIfMissing(lane);
  }

  /**
   * An older build's per-workspace tsc-rs record: on in some workspace
   * (`enabledWorkspaces` non-empty) and no `enabled` of its own. It is turned
   * on for the whole server; the list stays for those builds. Never throws: a
   * failed write leaves the record as it was, to be turned on at the next start.
   */
  private async migrateWorkspaceRecord(): Promise<void> {
    if (this.config === null || this.readError !== null) return;
    const legacy = (state: PluginState) => state.enabled === undefined && (state.enabledWorkspaces?.length ?? 0) > 0;
    if (!legacy(this.state(TS_RUST_PLUGIN_ID))) return;
    await this.mutate((config) => {
      const state = stateIn(config, TS_RUST_PLUGIN_ID);
      if (legacy(state)) state.enabled = true;
    }).catch((error) => this.logger.error("Failed to turn on the per-workspace tsc-rs record", error));
  }

  /** Re-read plugins.json in the file queue; throws `PLUGINS_UNREADABLE` when it does not read. */
  private reload(): Promise<void> {
    return this.onFileQueue(async () => {
      this.config = await this.readStrict();
    });
  }

  /**
   * Read-modify-write plugins.json in the file queue: `mutate` runs against a
   * fresh read, the file is written only when something changed, and memory
   * takes the new state only once that write landed. A throw from `mutate`
   * writes nothing.
   */
  private mutate<T>(mutate: (config: PluginsConfig) => T | Promise<T>): Promise<T> {
    return this.onFileQueue(async () => {
      const config = await this.readStrict();
      const before = JSON.stringify(config);
      const result = await mutate(config);
      if (JSON.stringify(config) !== before) {
        await this.options.writeJson(this.configFile, config);
      }
      this.config = config;
      return result;
    });
  }

  private onFileQueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.fileQueue.then(task);
    this.fileQueue = run.catch(() => undefined);
    return run;
  }

  /** No file is an empty state; a file that does not read or parse is an error, never a default. */
  private async readStrict(): Promise<PluginsConfig> {
    let raw: string;
    try {
      raw = await readFile(this.configFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.readError = null;
        return createDefaultPluginsConfig();
      }
      throw this.unreadable(`plugins.json could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
    let config: PluginsConfig;
    try {
      config = parsePluginsConfig(JSON.parse(raw));
    } catch {
      throw this.unreadable("plugins.json is not valid plugin state");
    }
    // Records of plugins this build does not know are kept as they are; a malformed record of a
    // built-in plugin makes the file unreadable for this daemon, so it is never written over.
    for (const entry of BUILT_IN_PLUGINS) {
      try {
        pluginStateOf(config, entry.id);
      } catch {
        throw this.unreadable(`plugins.json has a malformed "${entry.id}" record`);
      }
    }
    this.readError = null;
    return config;
  }

  private unreadable(reason: string): PluginsError {
    this.readError = reason;
    return new PluginsError(500, "PLUGINS_UNREADABLE", `${reason}; refusing to overwrite it.`);
  }

  // ---- views ---------------------------------------------------------------------------------

  private state(id: PluginId): PluginState {
    return pluginStateOf(this.config ?? createDefaultPluginsConfig(), id);
  }

  /** `config` and the jobs as they were when the view was asked for. */
  private response(config: PluginsConfig | null, jobs: JobStates): PluginsResponse {
    return { plugins: BUILT_IN_PLUGINS.map((entry) => this.info(entry.id, config, jobs)) };
  }

  private info(id: PluginId, config: PluginsConfig | null, jobs: JobStates): PluginInfo {
    const entry = pluginCatalogEntry(id);
    const state = pluginStateOf(config ?? createDefaultPluginsConfig(), id);
    const enabled = state.enabled === true;
    const boxStatuses = this.boxToolingStatus?.(id) ?? [];
    const boxes = boxStatuses.length > 0 ? { boxes: boxStatuses.map((status) => ({ ...status })) } : {};
    const lane = this.lanes.get(id);
    if (!entry.updates || !lane) {
      return {
        ...entry,
        platform: "supported",
        enabled,
        enabledWorkspaces: [],
        current: null,
        previous: null,
        skippedVersion: null,
        lastCheckAt: null,
        lastError: null,
        job: "idle",
        ...boxes
      };
    }
    const versions = lane.updater.target(state).versions(state);
    const { source, ...extras } = lane.updater.view(state);
    return {
      ...entry,
      source: source ?? { ...entry.source },
      platform: lane.updater.supported() ? "supported" : "unsupported",
      enabled,
      enabledWorkspaces: [],
      current: installedInfo(versions.current),
      previous: installedInfo(versions.previous),
      skippedVersion: versions.skippedVersion ?? null,
      lastCheckAt: versions.lastCheckAt ?? null,
      lastError: versions.lastError
        ? { at: versions.lastError.at, step: versions.lastError.step, message: versions.lastError.message }
        : null,
      job: jobs.get(id) ?? "idle",
      ...extras,
      ...boxes
    };
  }

  /**
   * Queue a `"changed"` event carrying the state and job as they are now (the
   * file queue replaces `config` rather than mutating it, so the reference
   * stays what it was). Events go out in the order they were raised.
   */
  private emitChanged(): void {
    if (this.config === null || this.readError !== null) return;
    const [config, jobs] = [this.config, this.jobStates()];
    this.emitQueue = this.emitQueue
      .then(() => this.events.emit("changed", this.response(config, jobs)))
      .catch((error) => this.logger.error("Failed to publish plugin state", error));
  }
}

/**
 * Every plugin change → the `/events` bus as `plugins.changed` on
 * {@link PLUGINS_CHANNEL}, carrying the whole `PluginsResponse`.
 */
export function publishPluginEvents(service: PluginsService, broadcaster: Pick<Broadcaster, "publish">): void {
  service.events.on("changed", (response: PluginsResponse) =>
    broadcaster.publish(PLUGINS_CHANNEL, PLUGINS_CHANGED_EVENT, response)
  );
}

/** The plugin's record in `config`, created when the file has none yet. */
function stateIn(config: PluginsConfig, id: PluginId): PluginState {
  const state = pluginStateOf(config, id);
  config.plugins[id] = state;
  return state;
}

/** Whether `version` of `target` is installed (a rollback target), even if a check would repair it. */
function installedFiles(target: PluginUpdateTarget, version: string): Promise<boolean> {
  return target.hasInstalled ? target.hasInstalled(version) : target.hasFiles(version);
}

function installedInfo(version: PluginInstalledVersion | undefined): PluginInfo["current"] {
  return version ? { version: version.version, integrity: version.integrity, installedAt: version.installedAt } : null;
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isFile(),
    () => false
  );
}
