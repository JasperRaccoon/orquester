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
  type PluginEngineVersions,
  type PluginInstalledVersion,
  type PluginState,
  type PluginsConfig,
  createDefaultPluginsConfig,
  parsePluginsConfig,
  pluginStateOf,
  pluginsConfigPath,
  storedTsCheckerEngine,
  tsRustPluginDir,
  tsRustPreloadPath,
  tsrsEngineDir
} from "@orquester/config";
import type { Broadcaster } from "../broadcaster.ts";
import { BUILT_IN_PLUGINS, TS_CHECKER_ENGINE_CATALOG, pluginCatalogEntry, tsCheckerEngineEntry } from "./catalog.ts";
import { setSessionNodePreload } from "./session-env.ts";
import {
  type HostLibc,
  type TsRustInstallerDeps,
  TS_CHECKER_ENGINE_SPECS,
  TsRustInstallError,
  clearTsRustStaging,
  defaultTsRustInstallerDeps,
  detectHostLibc,
  installTsRustRelease,
  pruneTsRustVersions,
  removeTsRustVersions,
  resolveTsRustRelease,
  tsRustBinaryPath
} from "./ts-rust/installer.ts";
import { type TsRustPreloadOptions, writeTsRustPreload } from "./ts-rust/preload.ts";
import type { TsRustToolingState } from "./ts-rust/box-tooling.ts";

/** How often a scheduled update check runs while the plugin is on. */
export const PLUGIN_CHECK_INTERVAL_MS = 60 * 60_000;

type PluginsErrorCode =
  | "INVALID_REQUEST"
  | "PLUGINS_UNREADABLE"
  | "PLUGIN_UNSUPPORTED"
  | "PLUGIN_BUSY"
  | "PLUGIN_ENABLED"
  | "NO_PREVIOUS_VERSION"
  | "PLUGIN_BUNDLED";

/** A refusal the routes answer verbatim: `status` with `{ code, message }`. */
export class PluginsError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500,
    readonly code: PluginsErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PluginsError";
  }
}

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
  logger?: Pick<Console, "warn" | "error">;
}

interface QueuedCheck {
  /** A manual check runs even while the plugin is off. */
  force: boolean;
}

export class PluginsService {
  readonly events = new EventEmitter();

  private readonly configFile: string;
  /** Each engine's dir: its versions/ and .tmp/. */
  private readonly engineDirs: Record<TsCheckerEngine, string>;
  private readonly preloadPath: string;
  private readonly platform: string;
  private readonly arch: string;
  /** Each engine's platform package for this host, or null where it has no build. */
  private readonly platformPackages: Record<TsCheckerEngine, string | null>;
  /** The engine used when plugins.json names none with a build here. */
  private readonly defaultEngine: TsCheckerEngine;
  private readonly installer: TsRustInstallerDeps;
  private readonly env: NodeJS.ProcessEnv;
  private readonly writePreload: (path: string, options: TsRustPreloadOptions) => Promise<void>;
  private readonly setSessionPreload: (path: string | null) => void;
  private readonly logger: Pick<Console, "warn" | "error">;

  /** The last plugins.json read or written; null until the first good read. */
  private config: PluginsConfig | null = null;
  /** Why the last read failed; set until a read succeeds again. */
  private readError: string | null = null;
  private fileQueue: Promise<unknown> = Promise.resolve();

  private job: PluginJobState = "idle";
  private jobQueue: Promise<unknown> = Promise.resolve();
  private queuedCheck: QueuedCheck | null = null;
  private jobAbort: AbortController | null = null;

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
    this.engineDirs = { "tsc-rs": tsRustPluginDir(options.baseDir), tsrs: tsrsEngineDir(options.baseDir) };
    this.preloadPath = tsRustPreloadPath(options.baseDir);
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    const libc = this.platform === "linux" ? (options.libc ?? detectHostLibc()) : "glibc";
    const packageFor = (engine: TsCheckerEngine) =>
      TS_CHECKER_ENGINE_SPECS[engine].platformPackage(this.platform, this.arch, libc);
    this.platformPackages = { tsrs: packageFor("tsrs"), "tsc-rs": packageFor("tsc-rs") };
    this.defaultEngine = this.platformPackages.tsrs !== null ? "tsrs" : "tsc-rs";
    this.installer = options.installer ?? defaultTsRustInstallerDeps;
    this.env = options.env ?? process.env;
    this.writePreload = options.writePreload ?? writeTsRustPreload;
    this.setSessionPreload = options.setSessionPreload ?? setSessionNodePreload;
    this.logger = options.logger ?? console;
  }

  /**
   * Empty the staging dir, read plugins.json (turning a per-workspace record
   * on), write the preload, and queue the start-up check. Never throws: a bad
   * plugins.json is reported by the routes.
   */
  async start(): Promise<void> {
    for (const engine of TS_CHECKER_ENGINES) {
      await clearTsRustStaging(this.engineDirs[engine]).catch((error) =>
        this.logger.warn(`Failed to empty the ${engine} staging dir`, error)
      );
    }
    await this.reload().catch((error) => this.logger.error("Failed to read plugins.json", error));
    await this.migrateWorkspaceRecord();
    await this.refreshRuntime();
    this.requestCheck(false);
  }

  /** Stop the timer, cancel a running job, and let queued file writes land. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.disarm();
    this.jobAbort?.abort();
    await Promise.all([this.jobQueue, this.fileQueue, this.runtimeQueue]).catch(() => undefined);
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
      const queues = [this.jobQueue, this.fileQueue, this.runtimeQueue, this.emitQueue, ...this.inflight];
      await Promise.all(queues).catch(() => undefined);
      const after = [this.jobQueue, this.fileQueue, this.runtimeQueue, this.emitQueue, ...this.inflight];
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
    return this.response(this.config, this.job);
  }

  async get(id: PluginId): Promise<PluginInfo> {
    await this.ensureReadable();
    const [config, job] = [this.config, this.job];
    return this.info(id, config, job);
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
    const { updates } = pluginCatalogEntry(id);
    const { enabled, engine } = change;
    if (engine !== undefined) {
      if (id !== TS_RUST_PLUGIN_ID) {
        throw new PluginsError(400, "INVALID_REQUEST", "This plugin has no engine to choose.");
      }
      if (this.platformPackages[engine] === null) throw this.unsupported(engine);
    }
    if (enabled === true && updates && !this.supported()) {
      throw this.unsupported();
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
    if (updates) {
      await this.refreshRuntime();
      if (on) {
        await this.requestInstallIfMissing();
      }
    }
    return this.get(id);
  }

  /** `POST /check`: queue a check now, whether or not the plugin is on. */
  async checkNow(id: PluginId): Promise<void> {
    this.assertUpdatable(id);
    if (!this.supported()) {
      throw this.unsupported();
    }
    await this.ensureReadable();
    this.requestCheck(true);
  }

  /**
   * The active engine: swap current and previous, and skip the version rolled
   * back from until the registry's latest moves past it. Prunes nothing.
   */
  async rollback(id: PluginId): Promise<PluginInfo> {
    this.assertUpdatable(id);
    await this.ensureReadable();
    this.assertIdle();
    await this.onJobQueue(async () => {
      const engine = this.activeEngine();
      const previous = engineVersions(this.state(id), engine).previous;
      if (!previous) {
        throw new PluginsError(409, "NO_PREVIOUS_VERSION", "There is no previous version to roll back to.");
      }
      if (!(await this.binaryExists(engine, previous.version))) {
        throw new PluginsError(409, "NO_PREVIOUS_VERSION", `The files of version ${previous.version} are missing.`);
      }
      await this.mutate((config) => {
        const state = engineVersionsIn(stateIn(config, id), engine);
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

  /** Delete every downloaded version of every engine. Refused while the plugin is on. */
  async removeDownloads(id: PluginId): Promise<PluginInfo> {
    this.assertUpdatable(id);
    await this.ensureReadable();
    this.assertIdle();
    await this.onJobQueue(async () => {
      if (this.state(id).enabled === true) {
        throw new PluginsError(409, "PLUGIN_ENABLED", "Turn the plugin off before removing its downloads.");
      }
      await this.mutate((config) => {
        const state = stateIn(config, id);
        for (const versions of [state, state.tsrs]) {
          if (!versions) continue;
          delete versions.current;
          delete versions.previous;
          delete versions.skippedVersion;
        }
      });
      this.emitChanged();
      // preload.cjs stays: sessions started while the plugin was on still require it.
      for (const engine of TS_CHECKER_ENGINES) {
        await removeTsRustVersions(this.engineDirs[engine]);
      }
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

  private requestCheck(force: boolean): void {
    if (this.stopped || !this.supported()) return;
    if (this.queuedCheck) {
      this.queuedCheck.force ||= force;
      return;
    }
    const queued: QueuedCheck = { force };
    this.queuedCheck = queued;
    void this.onJobQueue(() => this.runCheck(queued)).catch((error) =>
      this.logger.error("TypeScript engine update check failed", error)
    );
  }

  /**
   * Queue a check when the active engine has nothing usable installed: no
   * current version, or its binary is gone. The check itself runs only while
   * the plugin is on.
   */
  private async requestInstallIfMissing(): Promise<void> {
    if (this.config === null || this.readError !== null) return;
    const engine = this.activeEngine();
    const current = engineVersions(this.state(TS_RUST_PLUGIN_ID), engine).current;
    if (!current || !(await this.binaryExists(engine, current.version))) {
      this.requestCheck(false);
    }
  }

  private binaryExists(engine: TsCheckerEngine, version: string): Promise<boolean> {
    return isFile(tsRustBinaryPath(TS_CHECKER_ENGINE_SPECS[engine], this.engineDirs[engine], version, this.platform));
  }

  /** A check and install of the engine active when it starts; its outcome is recorded for that engine. */
  private async runCheck(queued: QueuedCheck): Promise<void> {
    if (this.queuedCheck === queued) this.queuedCheck = null;
    if (this.stopped || this.config === null || this.readError !== null) return;
    if (!queued.force && this.state(TS_RUST_PLUGIN_ID).enabled !== true) return;
    const engine = this.activeEngine();
    const platformPackage = this.platformPackages[engine];
    if (platformPackage === null) return;
    const spec = TS_CHECKER_ENGINE_SPECS[engine];
    const engineDir = this.engineDirs[engine];

    const abort = new AbortController();
    this.jobAbort = abort;
    this.setJob("checking");
    try {
      let installed: PluginInstalledVersion;
      try {
        const state = engineVersions(this.state(TS_RUST_PLUGIN_ID), engine);
        // A current version whose binary is gone (deleted from outside) is repaired: every tsc
        // would otherwise print "<engine> failed to start" until the downloads were removed.
        const currentMissing =
          state.current !== undefined && !(await this.binaryExists(engine, state.current.version));
        let release = await resolveTsRustRelease(spec, platformPackage, this.installer, abort.signal);
        if (release.version === state.skippedVersion && currentMissing && state.current) {
          // Latest is the version rolled back from: reinstall the one rolled back to instead.
          release = await resolveTsRustRelease(spec, platformPackage, this.installer, abort.signal, state.current.version);
        } else if (
          !currentMissing &&
          (release.version === state.current?.version || release.version === state.skippedVersion)
        ) {
          await this.recordCheck(engine, null);
          return;
        }
        this.setJob("installing");
        installed = await installTsRustRelease(spec, engineDir, release, this.installer, {
          platform: this.platform,
          env: this.env,
          signal: abort.signal
        });
      } catch (error) {
        await this.recordCheck(engine, error);
        return;
      }
      const at = this.installer.now().toISOString();
      const state = await this.mutate(async (config) => {
        const next = engineVersionsIn(stateIn(config, TS_RUST_PLUGIN_ID), engine);
        if (next.current?.version !== installed.version) {
          // A current version whose files are gone is no rollback target: the old previous stays.
          if (next.current && (await this.binaryExists(engine, next.current.version))) next.previous = next.current;
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
      await pruneTsRustVersions(engineDir, keep).catch((error) =>
        this.logger.warn(`Failed to prune old ${engine} versions`, error)
      );
    } finally {
      this.jobAbort = null;
      this.setJob("idle");
    }
  }

  /** Note a finished check of `engine`: its time, and its error or none. Nothing is written after `stop()`. */
  private async recordCheck(engine: TsCheckerEngine, error: unknown): Promise<void> {
    if (this.stopped) return;
    const at = this.installer.now().toISOString();
    if (error) {
      this.logger.warn(`${engine} update check failed`, error);
    }
    await this.mutate((config) => {
      const state = engineVersionsIn(stateIn(config, TS_RUST_PLUGIN_ID), engine);
      state.lastCheckAt = at;
      if (error) {
        state.lastError =
          error instanceof TsRustInstallError
            ? { at, step: error.step, message: error.message }
            : { at, step: "check", message: error instanceof Error ? error.message : String(error) };
      } else {
        delete state.lastError;
      }
    }).catch((writeError) => this.logger.error(`Failed to record the ${engine} check`, writeError));
  }

  private onJobQueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.jobQueue.then(task);
    this.jobQueue = run.catch(() => undefined);
    return run;
  }

  /** The version routes are for plugins the daemon downloads; a bundled one has no versions. */
  private assertUpdatable(id: PluginId): void {
    if (!pluginCatalogEntry(id).updates) {
      throw new PluginsError(409, "PLUGIN_BUNDLED", "This plugin ships with Orquester and has no downloads or updates.");
    }
  }

  private assertIdle(): void {
    if (this.job !== "idle" || this.queuedCheck !== null) {
      throw new PluginsError(409, "PLUGIN_BUSY", "An update check or install is running; try again when it has finished.");
    }
  }

  private setJob(job: PluginJobState): void {
    if (this.job === job) return;
    this.job = job;
    this.emitChanged();
  }

  // ---- preload, session env and the hourly timer ---------------------------------------------

  /**
   * Bring the runtime in line with the state: the preload written for the
   * current workspaces root, new sessions told whether to load it, and the
   * hourly timer armed while the plugin is on. Serialized. Resolves whether
   * the plugin's on/off changed since the last refresh.
   */
  private refreshRuntime(): Promise<boolean> {
    const run = this.runtimeQueue.then(async (): Promise<boolean> => {
      if (!this.supported() || this.stopped) {
        this.setSessionPreload(null);
        this.disarm();
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
            supportedEngines: TS_CHECKER_ENGINES.filter((engine) => this.platformPackages[engine] !== null),
            defaultEngine: this.defaultEngine
          });
          this.preloadRoot = roots;
        } catch (error) {
          this.preloadRoot = null;
          this.logger.error("Failed to write the TypeScript engine preload", error);
        }
      }
      this.setSessionPreload(enabled && this.preloadRoot === roots ? this.preloadPath : null);
      if (enabled) {
        this.arm();
      } else {
        this.disarm();
      }
      return changed;
    });
    this.runtimeQueue = run.catch((error) => this.logger.error("Failed to refresh the plugin runtime", error));
    return run.catch(() => false);
  }

  private arm(): void {
    if (this.timer !== null || this.stopped) return;
    this.timer = setInterval(() => {
      void this.track(async () => {
        if (await this.refreshRuntime()) this.emitChanged();
        // Each tick retries a preload write that failed. The check repairs a missing binary
        // too, and runs only while the plugin is on.
        this.requestCheck(false);
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
    await this.requestInstallIfMissing();
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

  /** Whether any engine has a build here. */
  private supported(): boolean {
    return TS_CHECKER_ENGINES.some((engine) => this.platformPackages[engine] !== null);
  }

  /** The engine `state` names when it has a build here, else the platform's default. */
  private activeEngine(state: PluginState = this.state(TS_RUST_PLUGIN_ID)): TsCheckerEngine {
    const stored = storedTsCheckerEngine(state);
    return stored !== undefined && this.platformPackages[stored] !== null ? stored : this.defaultEngine;
  }

  /** `config` and `job` as they were when the view was asked for. */
  private response(config: PluginsConfig | null, job: PluginJobState): PluginsResponse {
    return { plugins: BUILT_IN_PLUGINS.map((entry) => this.info(entry.id, config, job)) };
  }

  private info(id: PluginId, config: PluginsConfig | null, job: PluginJobState): PluginInfo {
    const entry = pluginCatalogEntry(id);
    const state = pluginStateOf(config ?? createDefaultPluginsConfig(), id);
    const enabled = state.enabled === true;
    const boxStatuses = this.boxToolingStatus?.(id) ?? [];
    const boxes = boxStatuses.length > 0 ? { boxes: boxStatuses.map((status) => ({ ...status })) } : {};
    if (!entry.updates) {
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
    const engine = this.activeEngine(state);
    const versions = engineVersions(state, engine);
    return {
      ...entry,
      source: { ...tsCheckerEngineEntry(engine).source },
      platform: this.supported() ? "supported" : "unsupported",
      enabled,
      enabledWorkspaces: [],
      current: installedInfo(versions.current),
      previous: installedInfo(versions.previous),
      skippedVersion: versions.skippedVersion ?? null,
      lastCheckAt: versions.lastCheckAt ?? null,
      lastError: versions.lastError
        ? { at: versions.lastError.at, step: versions.lastError.step, message: versions.lastError.message }
        : null,
      job,
      engine,
      engines: TS_CHECKER_ENGINE_CATALOG.map((option) => ({
        ...option,
        source: { ...option.source },
        platform: this.platformPackages[option.id] === null ? "unsupported" : "supported"
      })),
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
    const [config, job] = [this.config, this.job];
    this.emitQueue = this.emitQueue
      .then(() => this.events.emit("changed", this.response(config, job)))
      .catch((error) => this.logger.error("Failed to publish plugin state", error));
  }

  private unsupported(engine?: TsCheckerEngine): PluginsError {
    const where = `${this.platform}/${this.arch}`;
    return new PluginsError(
      409,
      "PLUGIN_UNSUPPORTED",
      engine ? `${engine} has no build for ${where}.` : `Neither tsrs nor tsc-rs has a build for ${where}.`
    );
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

/** An engine's versions in a ts-rust record: tsc-rs's are the record's own fields, tsrs's under `tsrs`. */
function engineVersions(state: PluginState, engine: TsCheckerEngine): PluginEngineVersions {
  return engine === "tsrs" ? (state.tsrs ?? {}) : state;
}

/** {@link engineVersions} to write to: tsrs's sub-record is created when the record has none yet. */
function engineVersionsIn(state: PluginState, engine: TsCheckerEngine): PluginEngineVersions {
  if (engine !== "tsrs") return state;
  state.tsrs ??= {};
  return state.tsrs;
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
