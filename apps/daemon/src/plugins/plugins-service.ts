/**
 * The built-in plugins behind Settings → Plugins (spec §3.3, §4.3–4.4, §5).
 * Today one plugin, "Better TS Typecheck": tsc-rs installed and kept up to
 * date under `<appdir>/daemon/plugins/ts-rust/`, and redirected to from every
 * `tsc` an Orquester session in an enabled workspace runs.
 *
 * - **plugins.json** is the durable state. Every change is a read-modify-write
 *   of the file in one serialized queue, so the file on disk always wins over a
 *   stale copy in memory, and memory changes only after the write landed. A file
 *   that does not read or parse is never written over: every operation fails
 *   with `PLUGINS_UNREADABLE` (the preload then runs the real tsc).
 * - **Jobs** (update checks and installs, rollback, removing downloads) run one
 *   at a time on the plugin's job queue. A check already queued is not queued
 *   again. Checks run at start, hourly, on demand, and when a workspace is
 *   enabled with nothing installed yet; scheduled ones only while the plugin is
 *   on in at least one existing workspace.
 * - **The preload** (`preload.cjs`) is rewritten at start and whenever the
 *   workspaces dir moves, while the plugin is on anywhere or once one exists.
 *   It is never deleted: running sessions reference it through NODE_OPTIONS.
 *   New sessions load it while the plugin is on in at least one workspace and
 *   the write succeeded (`setSessionNodePreload`).
 *
 * Workspace names stay in `enabledWorkspaces` when the workspace is renamed or
 * deleted; a name with no workspace dir is ignored and hidden from clients.
 *
 * `events` emits `"changed"` with the whole {@link PluginsResponse} after every
 * state or job change, in order.
 */
import { EventEmitter } from "node:events";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type PluginId,
  type PluginInfo,
  type PluginJobState,
  type PluginsResponse,
  PLUGINS_CHANGED_EVENT,
  PLUGINS_CHANNEL,
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
  tsRustPluginDir,
  tsRustPreloadPath
} from "@orquester/config";
import type { Broadcaster } from "../broadcaster.ts";
import { BUILT_IN_PLUGINS, pluginCatalogEntry } from "./catalog.ts";
import { setSessionNodePreload } from "./session-env.ts";
import {
  type TsRustInstallerDeps,
  TsRustInstallError,
  clearTsRustStaging,
  defaultTsRustInstallerDeps,
  installTsRustRelease,
  pruneTsRustVersions,
  removeTsRustVersions,
  resolveTsRustRelease,
  tsRustBinaryPath,
  tsRustPlatformPackage
} from "./ts-rust/installer.ts";
import { type TsRustPreloadOptions, writeTsRustPreload } from "./ts-rust/preload.ts";

/** How often a scheduled update check runs while the plugin is on somewhere. */
export const PLUGIN_CHECK_INTERVAL_MS = 60 * 60_000;

type PluginsErrorCode =
  | "PLUGINS_UNREADABLE"
  | "PLUGIN_UNSUPPORTED"
  | "PLUGIN_BUSY"
  | "PLUGIN_ENABLED"
  | "NO_PREVIOUS_VERSION"
  | "WORKSPACE_NOT_FOUND";

/** A refusal the routes answer verbatim: `status` with `{ code, message }`. */
export class PluginsError extends Error {
  constructor(
    readonly status: 404 | 409 | 500,
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
  /** A getter: PUT /api/config/daemon can move it at runtime (then call `workspacesDirChanged`). */
  workspacesDir: () => string;
  /** Atomic JSON write (the daemon's `writeJsonFile`). */
  writeJson: (file: string, value: unknown) => Promise<void>;
  /** Registry, download, smoke-test runner and clock; the real ones by default. */
  installer?: TsRustInstallerDeps;
  /** The daemon's env, which the smoke test runs with (minus `ORQUESTER_*`). */
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  writePreload?: (path: string, options: TsRustPreloadOptions) => Promise<void>;
  setSessionPreload?: (path: string | null) => void;
  logger?: Pick<Console, "warn" | "error">;
}

interface QueuedCheck {
  /** A manual check runs even while the plugin is on nowhere. */
  force: boolean;
}

export class PluginsService {
  readonly events = new EventEmitter();

  private readonly configFile: string;
  private readonly pluginDir: string;
  private readonly preloadPath: string;
  private readonly platform: string;
  private readonly platformPackage: string | null;
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
  /** The workspaces root the preload on disk was written with by this process; null if not (yet). */
  private preloadRoot: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private emitQueue: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: PluginsServiceOptions) {
    this.configFile = pluginsConfigPath(options.baseDir);
    this.pluginDir = tsRustPluginDir(options.baseDir);
    this.preloadPath = tsRustPreloadPath(options.baseDir);
    this.platform = options.platform ?? process.platform;
    this.platformPackage = tsRustPlatformPackage(this.platform, options.arch ?? process.arch);
    this.installer = options.installer ?? defaultTsRustInstallerDeps;
    this.env = options.env ?? process.env;
    this.writePreload = options.writePreload ?? writeTsRustPreload;
    this.setSessionPreload = options.setSessionPreload ?? setSessionNodePreload;
    this.logger = options.logger ?? console;
  }

  /**
   * Empty the staging dir, read plugins.json, write the preload, and queue the
   * start-up check. Never throws: a bad plugins.json is reported by the routes.
   */
  async start(): Promise<void> {
    await clearTsRustStaging(this.pluginDir).catch((error) =>
      this.logger.warn("Failed to empty the tsc-rs staging dir", error)
    );
    await this.reload().catch((error) => this.logger.error("Failed to read plugins.json", error));
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

  /** The workspaces dir moved: rewrite the preload for the new root and re-evaluate the rest. */
  async workspacesDirChanged(): Promise<void> {
    await this.refreshRuntime();
    this.emitChanged();
  }

  /** Every queued job, state refresh and change event has run (for tests and shutdown). */
  async settled(): Promise<void> {
    for (;;) {
      const queues = [this.jobQueue, this.fileQueue, this.runtimeQueue, this.emitQueue];
      await Promise.all(queues).catch(() => undefined);
      const after = [this.jobQueue, this.fileQueue, this.runtimeQueue, this.emitQueue];
      if (after.every((queue, index) => queue === queues[index])) return;
    }
  }

  async list(): Promise<PluginsResponse> {
    await this.ensureReadable();
    return this.response(this.config, this.job);
  }

  async get(id: PluginId): Promise<PluginInfo> {
    await this.ensureReadable();
    const [config, job] = [this.config, this.job];
    return this.info(id, config, job, await this.workspaceNames());
  }

  /** Whether `name` is an existing workspace directory. */
  async hasWorkspace(name: string): Promise<boolean> {
    return (await this.workspaceNames()).includes(name);
  }

  /**
   * Turn the plugin on or off for one workspace. Turning it on where nothing is
   * installed yet queues the first install.
   */
  async setWorkspaceEnabled(id: PluginId, workspace: string, enabled: boolean): Promise<PluginInfo> {
    if (enabled && this.platformPackage === null) {
      throw this.unsupported();
    }
    if (!(await this.hasWorkspace(workspace))) {
      throw new PluginsError(404, "WORKSPACE_NOT_FOUND", `Workspace "${workspace}" does not exist.`);
    }
    await this.mutate((config) => {
      const state = stateIn(config, id);
      const listed = state.enabledWorkspaces.includes(workspace);
      if (enabled && !listed) {
        state.enabledWorkspaces = [...state.enabledWorkspaces, workspace];
      } else if (!enabled && listed) {
        state.enabledWorkspaces = state.enabledWorkspaces.filter((name) => name !== workspace);
      }
    });
    this.emitChanged();
    await this.refreshRuntime();
    if (enabled && !this.state(id).current) {
      this.requestCheck(false);
    }
    return this.get(id);
  }

  /** `POST /check`: queue a check now, whether or not the plugin is on anywhere. */
  async checkNow(_id: PluginId): Promise<void> {
    if (this.platformPackage === null) {
      throw this.unsupported();
    }
    await this.ensureReadable();
    this.requestCheck(true);
  }

  /**
   * Swap current and previous, and skip the version rolled back from until the
   * registry's latest moves past it. Prunes nothing.
   */
  async rollback(id: PluginId): Promise<PluginInfo> {
    await this.ensureReadable();
    this.assertIdle();
    await this.onJobQueue(async () => {
      const previous = this.state(id).previous;
      if (!previous) {
        throw new PluginsError(409, "NO_PREVIOUS_VERSION", "There is no previous version to roll back to.");
      }
      const binary = tsRustBinaryPath(this.pluginDir, previous.version, this.platform);
      if (!(await isFile(binary))) {
        throw new PluginsError(409, "NO_PREVIOUS_VERSION", `The files of version ${previous.version} are missing.`);
      }
      await this.mutate((config) => {
        const state = stateIn(config, id);
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

  /** Delete every downloaded version. Refused while the plugin is on in any existing workspace. */
  async removeDownloads(id: PluginId): Promise<PluginInfo> {
    await this.ensureReadable();
    this.assertIdle();
    await this.onJobQueue(async () => {
      if ((await this.activeWorkspaces(this.state(id))).length > 0) {
        throw new PluginsError(409, "PLUGIN_ENABLED", "Turn the plugin off in every workspace before removing its downloads.");
      }
      await this.mutate((config) => {
        const state = stateIn(config, id);
        delete state.current;
        delete state.previous;
        delete state.skippedVersion;
      });
      this.emitChanged();
      // preload.cjs stays: sessions started while the plugin was on still require it.
      await removeTsRustVersions(this.pluginDir);
    });
    return this.get(id);
  }

  // ---- update checks and installs ------------------------------------------------------------

  private requestCheck(force: boolean): void {
    if (this.stopped || this.platformPackage === null) return;
    if (this.queuedCheck) {
      this.queuedCheck.force ||= force;
      return;
    }
    const queued: QueuedCheck = { force };
    this.queuedCheck = queued;
    void this.onJobQueue(() => this.runCheck(queued)).catch((error) =>
      this.logger.error("tsc-rs update check failed", error)
    );
  }

  private async runCheck(queued: QueuedCheck): Promise<void> {
    if (this.queuedCheck === queued) this.queuedCheck = null;
    const platformPackage = this.platformPackage;
    if (this.stopped || platformPackage === null || this.config === null || this.readError !== null) return;
    if (!queued.force && (await this.activeWorkspaces(this.state(TS_RUST_PLUGIN_ID))).length === 0) return;

    const abort = new AbortController();
    this.jobAbort = abort;
    this.setJob("checking");
    try {
      let installed: PluginInstalledVersion;
      try {
        const release = await resolveTsRustRelease(platformPackage, this.installer, abort.signal);
        const state = this.state(TS_RUST_PLUGIN_ID);
        if (release.version === state.current?.version || release.version === state.skippedVersion) {
          await this.recordCheck(null);
          return;
        }
        this.setJob("installing");
        installed = await installTsRustRelease(this.pluginDir, release, this.installer, {
          platform: this.platform,
          env: this.env,
          signal: abort.signal
        });
      } catch (error) {
        await this.recordCheck(error);
        return;
      }
      const at = this.installer.now().toISOString();
      const state = await this.mutate((config) => {
        const next = stateIn(config, TS_RUST_PLUGIN_ID);
        if (next.current) next.previous = next.current;
        next.current = installed;
        // Only a version past the skipped one gets here.
        delete next.skippedVersion;
        delete next.lastError;
        next.lastCheckAt = at;
        return next;
      });
      const keep = [state.current?.version, state.previous?.version].filter((v): v is string => Boolean(v));
      await pruneTsRustVersions(this.pluginDir, keep).catch((error) =>
        this.logger.warn("Failed to prune old tsc-rs versions", error)
      );
    } finally {
      this.jobAbort = null;
      this.setJob("idle");
    }
  }

  /** Note a finished check: its time, and its error or none. Nothing is written after `stop()`. */
  private async recordCheck(error: unknown): Promise<void> {
    if (this.stopped) return;
    const at = this.installer.now().toISOString();
    if (error) {
      this.logger.warn("tsc-rs update check failed", error);
    }
    await this.mutate((config) => {
      const state = stateIn(config, TS_RUST_PLUGIN_ID);
      state.lastCheckAt = at;
      if (error) {
        state.lastError =
          error instanceof TsRustInstallError
            ? { at, step: error.step, message: error.message }
            : { at, step: "check", message: error instanceof Error ? error.message : String(error) };
      } else {
        delete state.lastError;
      }
    }).catch((writeError) => this.logger.error("Failed to record the tsc-rs check", writeError));
  }

  private onJobQueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.jobQueue.then(task);
    this.jobQueue = run.catch(() => undefined);
    return run;
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
   * hourly timer armed while any workspace is enabled. Serialized.
   */
  private refreshRuntime(): Promise<void> {
    const run = this.runtimeQueue.then(async () => {
      if (this.platformPackage === null || this.stopped) {
        this.setSessionPreload(null);
        this.disarm();
        return;
      }
      const state = this.config === null ? null : this.state(TS_RUST_PLUGIN_ID);
      const active = state === null ? [] : await this.activeWorkspaces(state);
      const workspacesDir = this.options.workspacesDir();
      const root = await realpath(workspacesDir).catch(() => resolve(workspacesDir));
      if (this.preloadRoot !== root && (active.length > 0 || (await isFile(this.preloadPath)))) {
        try {
          await this.writePreload(this.preloadPath, { statePath: this.configFile, workspacesRoot: root });
          this.preloadRoot = root;
        } catch (error) {
          this.preloadRoot = null;
          this.logger.error("Failed to write the tsc-rs preload", error);
        }
      }
      this.setSessionPreload(active.length > 0 && this.preloadRoot === root ? this.preloadPath : null);
      // Armed for any listed name, existing or not: each tick re-reads the workspaces, so a
      // re-created workspace picks the plugin up again within the hour.
      if (state !== null && state.enabledWorkspaces.length > 0) {
        this.arm();
      } else {
        this.disarm();
      }
    });
    this.runtimeQueue = run.catch((error) => this.logger.error("Failed to refresh the plugin runtime", error));
    return run.catch(() => undefined);
  }

  private arm(): void {
    if (this.timer !== null || this.stopped) return;
    this.timer = setInterval(() => {
      void this.refreshRuntime();
      this.requestCheck(false);
    }, PLUGIN_CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  // ---- plugins.json --------------------------------------------------------------------------

  private async ensureReadable(): Promise<void> {
    if (this.config === null || this.readError !== null) {
      await this.reload();
    }
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
    try {
      const config = parsePluginsConfig(JSON.parse(raw));
      this.readError = null;
      return config;
    } catch {
      throw this.unreadable("plugins.json is not valid plugin state");
    }
  }

  private unreadable(reason: string): PluginsError {
    this.readError = reason;
    return new PluginsError(500, "PLUGINS_UNREADABLE", `${reason}; refusing to overwrite it.`);
  }

  // ---- views ---------------------------------------------------------------------------------

  private state(id: PluginId): PluginState {
    return pluginStateOf(this.config ?? createDefaultPluginsConfig(), id);
  }

  /** `config` and `job` as they were when the view was asked for; the workspaces as they are. */
  private async response(config: PluginsConfig | null, job: PluginJobState): Promise<PluginsResponse> {
    const names = await this.workspaceNames();
    return { plugins: BUILT_IN_PLUGINS.map((entry) => this.info(entry.id, config, job, names)) };
  }

  private info(
    id: PluginId,
    config: PluginsConfig | null,
    job: PluginJobState,
    workspaceNames: readonly string[]
  ): PluginInfo {
    const state = pluginStateOf(config ?? createDefaultPluginsConfig(), id);
    const existing = new Set(workspaceNames);
    return {
      ...pluginCatalogEntry(id),
      platform: this.platformPackage === null ? "unsupported" : "supported",
      enabledWorkspaces: state.enabledWorkspaces.filter((name) => existing.has(name)),
      current: installedInfo(state.current),
      previous: installedInfo(state.previous),
      skippedVersion: state.skippedVersion ?? null,
      lastCheckAt: state.lastCheckAt ?? null,
      lastError: state.lastError
        ? { at: state.lastError.at, step: state.lastError.step, message: state.lastError.message }
        : null,
      job
    };
  }

  /** Workspace directories, as the workspace listing reads them. */
  private async workspaceNames(): Promise<string[]> {
    try {
      const entries = await readdir(this.options.workspacesDir(), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn("Failed to list workspaces for plugins", error);
      }
      return [];
    }
  }

  /** The enabled names that are existing workspaces. */
  private async activeWorkspaces(state: PluginState): Promise<string[]> {
    if (state.enabledWorkspaces.length === 0) return [];
    const existing = new Set(await this.workspaceNames());
    return state.enabledWorkspaces.filter((name) => existing.has(name));
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
      .then(async () => this.events.emit("changed", await this.response(config, job)))
      .catch((error) => this.logger.error("Failed to publish plugin state", error));
  }

  private unsupported(): PluginsError {
    return new PluginsError(409, "PLUGIN_UNSUPPORTED", `tsc-rs has no build for ${this.platform}/${this.options.arch ?? process.arch}.`);
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

function installedInfo(version: PluginInstalledVersion | undefined): PluginInfo["current"] {
  return version ? { version: version.version, integrity: version.integrity, installedAt: version.installedAt } : null;
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isFile(),
    () => false
  );
}
