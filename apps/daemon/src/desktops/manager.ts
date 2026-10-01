import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { type FSWatcher, existsSync, watch } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { sep } from "node:path";
import {
  DESKTOP_UNAVAILABLE_CODE,
  type DesktopAppSummary,
  type DesktopClosedPayload,
  type DesktopHostStatus,
  type DesktopSize,
  type DesktopStatus,
  type DesktopSummary,
  type DesktopWindow,
  type DesktopWindowAction,
  type DesktopWindowsPayload,
  type RecentLaunch
} from "@orquester/api";
import {
  DESKTOP_DEFAULT_RENDER_THREADS,
  DESKTOP_DEFAULT_SIZE,
  DESKTOP_MAX_EXITED_APPS,
  DESKTOP_MAX_RECENT_LAUNCHES,
  type DesktopAppRecord,
  type DesktopRecord,
  type RecentLaunchRecord,
  desktopRecordSchema,
  desktopRuntimeDir
} from "@orquester/config";
import { sessionEnvBase, sessionPath } from "../tmux.ts";
import type { DesktopAudioHub } from "./audio.ts";
import {
  CLIENT_CONF_CONTENT,
  DESKTOP_APP_SCRIPT,
  DESKTOP_HOST_WINDOW,
  DESKTOP_SESSION_PREFIX,
  type DesktopLayout,
  appEnvFileContent,
  appFile,
  appWindowName,
  buildAppEnv,
  defaultPaContent,
  desktopLayout,
  desktopSessionName,
  fallbackSocketDir,
  hostScriptArgs
} from "./host-env.ts";
import { hasRenderNode } from "./host-status.ts";
import { reconcile } from "./reconcile.ts";
import { DesktopStore } from "./store.ts";
import { DesktopWindowNotFoundError, DesktopWindowTracker, type DesktopWindowTrackerOptions } from "./windows.ts";
import { writeXauthority } from "./x11/xauth.ts";

/** A refusal the routes answer verbatim: `status` with `{ code, message, hint? }`. */
export class DesktopError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500 | 503,
    readonly code: string,
    message: string,
    readonly hint: string | null = null
  ) {
    super(message);
    this.name = "DesktopError";
  }
}

/** The tmux calls the manager makes (the daemon's `Tmux`, or a fake in tests). */
export interface DesktopTmux {
  newServiceSession(opts: {
    name: string;
    cwd: string;
    env: Record<string, string>;
    bin: string;
    args: string[];
    windowName?: string;
  }): Promise<void>;
  newServiceWindow(opts: {
    session: string;
    name: string;
    cwd: string;
    env: Record<string, string>;
    bin: string;
    args: string[];
  }): Promise<void>;
  listServiceSessions(prefix: string): Promise<string[]>;
  listServiceWindows(session: string): Promise<Array<{ name: string; panePid: number }>>;
  killServiceSession(name: string): Promise<void>;
}

export interface DesktopManagerOptions {
  /** `<appdir>` — the config path helpers take it. */
  baseDir: string;
  /** `<appdir>/daemon/desktops.json`. */
  indexFile: string;
  tmux: DesktopTmux;
  hostStatus: () => Promise<DesktopHostStatus>;
  audio?: Pick<DesktopAudioHub, "stopDesktop">;
  /** The env apps start from (default: the session base env with the session PATH). */
  baseEnv?: () => Record<string, string>;
  /** Whether a `/dev/dri/renderD*` node exists (default: probed). */
  renderNode?: () => boolean;
  createTracker?: (options: DesktopWindowTrackerOptions) => DesktopWindowTracker;
  /** How long a new host has to write `ready` (default 15 s). */
  readyTimeoutMs?: number;
  /** SIGTERM → SIGKILL grace for an app, and the bound on waits while stopping (default 5 s). */
  stopGraceMs?: number;
  /** Where the short socket fallback dirs go (default os.tmpdir()). */
  tmpDir?: string;
  logger?: Pick<Console, "warn" | "error">;
  now?: () => Date;
}

export interface DesktopManagerEvents {
  created: [DesktopSummary];
  updated: [DesktopSummary];
  closed: [DesktopClosedPayload];
  windows: [DesktopWindowsPayload];
}

/** Validated create input: paths are realpaths inside the fs root (the routes' job). */
export interface CreateDesktopInput {
  /** As the client spells it (kept for the UI's project key). */
  projectPath: string;
  /** Its realpath inside the fs root. */
  projectRealPath: string;
  title?: string;
  size?: DesktopSize;
  renderThreads?: number;
  app?: LaunchAppInput;
}

/** Validated launch input: `cwd` is a realpath inside the fs root. */
export interface LaunchAppInput {
  command: string;
  cwd: string;
  env: Record<string, string>;
}

/** What the manager knows about one desktop beyond its record. Records are the only persisted part. */
interface Runtime {
  record: DesktopRecord;
  status: DesktopStatus;
  error?: string;
  tracker: DesktopWindowTracker | null;
  windows: DesktopWindow[];
  activeWindowId: string | null;
  dirWatcher: FSWatcher | null;
  appsWatcher: FSWatcher | null;
  /** SIGKILL timers of apps asked to stop gracefully. */
  killTimers: Map<string, NodeJS.Timeout>;
  /** Stops asked for before the app's pgid was known (appId → force). */
  pendingStops: Map<string, boolean>;
  /** Lifecycle operations run one at a time per desktop. */
  queue: Promise<unknown>;
  /** Bumped by every host start and teardown: events of an older host are ignored. */
  generation: number;
  syncing: boolean;
  syncAgain: boolean;
}

const READY_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 5_000;
/** The tail of an app log the log route returns, and of host.log in an error. */
export const APP_LOG_TAIL_BYTES = 64 * 1024;
const HOST_LOG_ERROR_TAIL_BYTES = 2048;

/**
 * The daemon's desktops (desktop spec §5): one tmux service session per
 * desktop (`orqsvc-desktop-<id>`) whose `host` window runs desktop-host.sh and
 * whose `app-<appId>` windows run app-run.sh. Everything the scripts report
 * arrives through files in the desktop dir (`ready`, `host.exit`,
 * `apps/<appId>.{pgid,exit}`), watched with fs.watch — never polled. Desktops
 * outlive the daemon; `reattach()` rebuilds their state from tmux and those
 * files on boot.
 *
 * Emits `created`/`updated` (the whole summary), `closed` and `windows`.
 */
export class DesktopManager extends EventEmitter<DesktopManagerEvents> {
  private readonly desktops = new Map<string, Runtime>();
  private recent: Record<string, RecentLaunchRecord[]> = {};
  private readonly store: DesktopStore;
  private readonly readyTimeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly logger: Pick<Console, "warn" | "error">;
  private readonly now: () => Date;
  private stopped = false;

  constructor(private readonly options: DesktopManagerOptions) {
    super();
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => new Date());
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS;
    this.store = new DesktopStore({ file: options.indexFile, logger: this.logger });
    this.store.setSnapshot(() => ({
      desktops: [...this.desktops.values()].map((rt) => rt.record),
      recent: this.recent
    }));
  }

  /** Read the index. Every desktop starts `stopped` until `reattach()` finds its host. */
  async load(): Promise<void> {
    const file = await this.store.load();
    this.desktops.clear();
    for (const record of file.desktops) {
      this.desktops.set(record.id, newRuntime(record));
    }
    this.recent = file.recent;
  }

  hostStatus(): Promise<DesktopHostStatus> {
    return this.options.hostStatus();
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Every desktop (of `projectPath` when given), in tab order. */
  list(projectPath?: string, projectRealPath?: string): DesktopSummary[] {
    return [...this.desktops.values()]
      .filter(
        (rt) =>
          projectPath === undefined ||
          rt.record.projectPath === projectPath ||
          (projectRealPath !== undefined && realProjectPath(rt.record) === projectRealPath)
      )
      .sort((a, b) => a.record.order - b.record.order || a.record.createdAt.localeCompare(b.record.createdAt))
      .map((rt) => this.summary(rt));
  }

  get(id: string): DesktopSummary | undefined {
    const rt = this.desktops.get(id);
    return rt ? this.summary(rt) : undefined;
  }

  /** The project's recent launches, newest first. */
  recentLaunches(projectPath: string): RecentLaunch[] {
    return (this.recent[projectPath] ?? []).map((launch) => ({
      command: launch.command,
      cwd: launch.cwd,
      env: { ...launch.env },
      lastUsedAt: launch.lastUsedAt
    }));
  }

  /** The last 64 KiB of an app's output ("" when it has none yet). */
  async appLog(id: string, appId: string): Promise<string> {
    const rt = this.mustGet(id);
    if (!rt.record.apps.some((app) => app.id === appId)) {
      throw new DesktopError(404, "DESKTOP_APP_NOT_FOUND", "No such app in this desktop.");
    }
    return readTail(appFile(this.layout(rt.record), appId, "log"), APP_LOG_TAIL_BYTES);
  }

  /** The RFB socket of a RUNNING desktop, else null (the relay's lookup). */
  vncSocketPath(id: string): string | null {
    const rt = this.desktops.get(id);
    return rt?.status === "running" ? this.layout(rt.record).vncSocket : null;
  }

  /** The pulse socket of a running desktop with audio, the reason when it has none, null when not running. */
  audioSource(id: string): { pulseSocketPath: string } | { unavailable: string } | null {
    const rt = this.desktops.get(id);
    if (rt?.status !== "running") return null;
    if (rt.record.audio !== true) {
      return { unavailable: "This desktop was started without sound (PulseAudio or ffmpeg with pulse and libopus is missing)." };
    }
    return { pulseSocketPath: this.layout(rt.record).pulseSocket };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Create a desktop and start its host (§5.4); resolves once it is running or
   * has failed (status `error`, with the tail of host.log). `created` goes out
   * first, while it is still `starting`, so every client opens the tab at once.
   */
  async create(input: CreateDesktopInput): Promise<DesktopSummary> {
    const host = await this.options.hostStatus();
    if (!host.available) throw unavailable(host);
    this.requireWritable();
    const id = this.newId();
    const dir = desktopRuntimeDir(this.options.baseDir, id);
    const siblings = [...this.desktops.values()].filter((rt) => rt.record.projectPath === input.projectPath);
    const record = desktopRecordSchema.parse({
      id,
      projectPath: input.projectPath,
      projectRealPath: input.projectRealPath,
      title: input.title?.trim() || "Desktop",
      order: siblings.reduce((max, rt) => Math.max(max, rt.record.order + 1), 0),
      createdAt: this.now().toISOString(),
      display: null,
      size: input.size ?? { ...DESKTOP_DEFAULT_SIZE },
      renderThreads: clampThreads(input.renderThreads ?? DESKTOP_DEFAULT_RENDER_THREADS),
      socketDir: fallbackSocketDir(dir, id, { tmpDir: this.options.tmpDir ?? tmpdir(), uid: process.getuid?.() ?? 0 }),
      apps: [],
      // Whether this host runs PulseAudio (a passthrough field: older builds keep it).
      audio: host.audioAvailable
    });
    const rt = newRuntime(record);
    rt.status = "starting";
    this.desktops.set(id, rt);
    void this.store.persist();
    this.emit("created", this.summary(rt));
    await this.enqueue(rt, () => this.startHost(rt));
    // (startHost moved the status on; TS still holds the "starting" assigned above.)
    if (input.app && (rt.status as DesktopStatus) === "running") {
      await this.launchApp(id, input.app).catch((error) =>
        this.logger.warn(`Desktop ${id}: first app failed to launch`, error)
      );
    }
    return this.summary(rt);
  }

  /** Stop the host and every app, keeping the record as `stopped` (the tab stays, offering Restart). */
  async stop(id: string): Promise<DesktopSummary> {
    const rt = this.mustGet(id);
    await this.enqueue(rt, async () => {
      if (!this.isCurrent(rt)) return;
      await this.teardown(rt);
      rt.status = "stopped";
      rt.error = undefined;
      void this.store.persist();
      this.emitUpdated(rt);
    });
    return this.summary(rt);
  }

  /** Start a new host for a stopped (or failed) desktop, same record and size; apps are not relaunched. */
  async restart(id: string): Promise<DesktopSummary> {
    const rt = this.mustGet(id);
    await this.enqueue(rt, async () => {
      if (!this.isCurrent(rt)) return;
      if (rt.status !== "stopped" && rt.status !== "error") {
        throw new DesktopError(409, "DESKTOP_NOT_STOPPED", "Only a stopped desktop can be restarted.");
      }
      const host = await this.options.hostStatus();
      if (!host.available) throw unavailable(host);
      this.requireWritable();
      rt.record.audio = host.audioAvailable;
      rt.status = "starting";
      rt.error = undefined;
      this.emitUpdated(rt);
      await this.startHost(rt);
    });
    return this.summary(rt);
  }

  /** Stop everything and drop the record and its directory (tab close, project delete). */
  async close(id: string): Promise<void> {
    const rt = this.mustGet(id);
    await this.enqueue(rt, async () => {
      if (!this.isCurrent(rt)) return;
      await this.teardown(rt);
      this.desktops.delete(id);
      void this.store.persist();
      this.emit("closed", { id });
    });
  }

  /** Close every desktop of `path` or of any project under it (project, workspace and fs deletes). */
  async closeForProject(path: string): Promise<void> {
    const prefix = path.endsWith(sep) ? path : `${path}${sep}`;
    const doomed = [...this.desktops.values()].filter((rt) =>
      [realProjectPath(rt.record), rt.record.projectPath].some((p) => p === path || p.startsWith(prefix))
    );
    for (const rt of doomed) {
      await this.close(rt.record.id).catch((error) =>
        this.logger.error(`Failed to close desktop ${rt.record.id}`, error)
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Apps and windows
  // ---------------------------------------------------------------------------

  /** Launch an app into a running desktop; it is `starting` until app-run.sh records its pgid. */
  async launchApp(id: string, input: LaunchAppInput): Promise<DesktopAppSummary> {
    const rt = this.mustGet(id);
    return this.enqueue(rt, async () => {
      if (!this.isCurrent(rt) || rt.status !== "running" || rt.record.display === null) {
        throw new DesktopError(409, "DESKTOP_NOT_RUNNING", "The desktop is not running.");
      }
      this.requireWritable();
      const layout = this.layout(rt.record);
      const app: DesktopAppRecord = {
        id: this.newAppId(rt),
        desktopId: id,
        command: input.command,
        cwd: input.cwd,
        env: { ...input.env },
        status: "starting",
        exitCode: null,
        pgid: null,
        startedAt: this.now().toISOString(),
        exitedAt: null
      };
      const env = buildAppEnv({
        base: this.options.baseEnv?.() ?? { ...sessionEnvBase(), PATH: sessionPath() },
        layout,
        display: rt.record.display,
        renderNode: this.options.renderNode?.() ?? hasRenderNode(),
        renderThreads: rt.record.renderThreads,
        user: input.env
      });
      const envFile = appFile(layout, app.id, "env");
      await writeFile(envFile, appEnvFileContent(env, input.cwd, input.command), { mode: 0o600 });
      rt.record.apps.push(app);
      this.pruneApps(rt);
      this.rememberLaunch(realProjectPath(rt.record), input);
      void this.store.persist();
      this.emitUpdated(rt);
      try {
        await this.options.tmux.newServiceWindow({
          session: desktopSessionName(id),
          name: appWindowName(app.id),
          cwd: layout.dir,
          env: {},
          bin: "/bin/sh",
          args: [DESKTOP_APP_SCRIPT, layout.dir, app.id]
        });
      } catch (error) {
        await rm(envFile, { force: true });
        app.status = "exited";
        app.exitedAt = this.now().toISOString();
        void this.store.persist();
        this.emitUpdated(rt);
        throw new DesktopError(500, "DESKTOP_LAUNCH_FAILED", `Could not launch the app: ${errorMessage(error)}`);
      }
      // The pgid file may already be there (the watcher then saw it before the app was recorded as ours).
      this.syncApps(rt);
      return appSummary(app);
    });
  }

  /** SIGTERM the app's process group (SIGKILL with `force`, or 5 s later if it is still alive). */
  stopApp(id: string, appId: string, force = false): void {
    const rt = this.mustGet(id);
    const app = rt.record.apps.find((candidate) => candidate.id === appId);
    if (!app) throw new DesktopError(404, "DESKTOP_APP_NOT_FOUND", "No such app in this desktop.");
    if (app.status === "exited") return;
    if (app.pgid === null) {
      // Not started yet: applied the moment its pgid appears.
      rt.pendingStops.set(appId, force || (rt.pendingStops.get(appId) ?? false));
      return;
    }
    this.signalApp(rt, app, force);
  }

  async windowAction(id: string, windowId: string, action: DesktopWindowAction): Promise<void> {
    const rt = this.mustGet(id);
    if (rt.status !== "running" || !rt.tracker) {
      throw new DesktopError(409, "DESKTOP_NOT_RUNNING", "The desktop is not running.");
    }
    try {
      await rt.tracker.action(windowId, action);
    } catch (error) {
      if (error instanceof DesktopWindowNotFoundError) {
        throw new DesktopError(404, "DESKTOP_WINDOW_NOT_FOUND", "No such window in this desktop.");
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Boot and shutdown
  // ---------------------------------------------------------------------------

  /**
   * Boot reconciliation (§5.6): a desktop whose session is live with `ready`
   * and without `host.exit` is running again (watchers and window tracker
   * reconnected); every other one is stopped. A live `orqsvc-desktop-*`
   * session no record claims is killed — but only when the index loaded
   * cleanly, never on an unreadable one.
   */
  async reattach(): Promise<void> {
    let liveSessions: string[];
    const windowsBySession = new Map<string, string[]>();
    try {
      liveSessions = await this.options.tmux.listServiceSessions(DESKTOP_SESSION_PREFIX);
      for (const session of liveSessions) {
        windowsBySession.set(
          session,
          (await this.options.tmux.listServiceWindows(session)).map((window) => window.name)
        );
      }
    } catch (error) {
      // tmux could not be read: reconciling now would stop live desktops and kill
      // their apps. Leave every process alone; the desktops show as unknown-stopped.
      this.logger.error("Desktop reattach skipped: tmux could not be listed", error);
      for (const rt of this.desktops.values()) {
        rt.status = "error";
        rt.error = "Could not reach tmux at startup; restart the daemon to reattach this desktop.";
        this.emitUpdated(rt);
      }
      return;
    }
    const readyFiles = new Map<string, number>();
    const hostExitFiles = new Set<string>();
    const appExitFiles = new Map<string, Map<string, number | null>>();
    for (const rt of this.desktops.values()) {
      const layout = this.layout(rt.record);
      const display = await readInt(layout.ready);
      if (display !== null) readyFiles.set(rt.record.id, display);
      if (existsSync(layout.hostExit)) hostExitFiles.add(rt.record.id);
      appExitFiles.set(rt.record.id, await readExitFiles(layout));
    }
    const result = reconcile({
      records: [...this.desktops.values()].map((rt) => rt.record),
      liveSessions,
      windowsBySession,
      readyFiles,
      hostExitFiles,
      appExitFiles,
      indexLoaded: this.store.loaded,
      claimedIds: this.store.rejectedIds()
    });

    for (const session of result.reap) {
      this.logger.warn(`Reaping desktop session ${session}: no desktop record claims it.`);
      await this.options.tmux.killServiceSession(session);
    }
    const now = this.now().toISOString();
    for (const reconciled of result.desktops) {
      const rt = this.desktops.get(reconciled.id);
      if (!rt) continue;
      const layout = this.layout(rt.record);
      for (const outcome of reconciled.apps) {
        const app = rt.record.apps.find((candidate) => candidate.id === outcome.id);
        if (!app) continue;
        if (outcome.status === "exited") {
          const wasLive = app.status !== "exited";
          if (wasLive && reconciled.status === "stopped" && app.pgid !== null) {
            // The host died while the daemon was away; its apps' groups may outlive it.
            // Kill only a group whose leader still carries this desktop's X authority path.
            if (await leaderBelongsTo(app.pgid, layout.xauthority)) signalGroup(app.pgid, "SIGKILL");
          }
          app.status = "exited";
          app.exitCode = outcome.exitCode;
          app.exitedAt = app.exitedAt ?? now;
        } else {
          app.pgid = app.pgid ?? (await readInt(appFile(layout, app.id, "pgid")));
          app.status = app.pgid === null ? "starting" : "running";
        }
      }
      if (reconciled.status === "running") {
        rt.generation += 1;
        rt.status = "running";
        rt.record.display = reconciled.display;
        this.watch(rt);
        await this.startTracker(rt);
        this.syncApps(rt);
      } else {
        rt.status = "stopped";
        rt.record.display = null;
        if (reconciled.killSession) await this.killHost(rt);
      }
    }
    void this.store.persist();
    for (const rt of this.desktops.values()) this.emitUpdated(rt);
  }

  /**
   * Daemon shutdown: close watchers, trackers and timers only. The desktops
   * keep running in tmux; the next boot reattaches them.
   */
  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const rt of this.desktops.values()) {
      this.unwatch(rt);
      this.stopTracker(rt);
      for (const timer of rt.killTimers.values()) clearTimeout(timer);
      rt.killTimers.clear();
    }
    await this.store.flush();
  }

  /** Resolves once every queued index write has run (tests, shutdown). */
  flush(): Promise<void> {
    return this.store.flush();
  }

  // ---------------------------------------------------------------------------
  // Host
  // ---------------------------------------------------------------------------

  /** Prepare the dir, open the service session, wait for `ready` (§5.4 steps 3–6). Never throws. */
  private async startHost(rt: Runtime): Promise<void> {
    rt.generation += 1;
    const generation = rt.generation;
    const layout = this.layout(rt.record);
    const session = desktopSessionName(rt.record.id);
    try {
      for (const dir of new Set([layout.dir, layout.socketDir, layout.pulseDir, layout.runDir, layout.appsDir])) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        // The socket fallback lives in the shared tmp dir under a recorded name: refuse
        // one someone else created (or a symlink) rather than put our sockets in it.
        const info = await lstat(dir);
        if (!info.isDirectory() || info.uid !== process.getuid?.()) {
          throw new Error(`${dir} is not a directory owned by the daemon's user`);
        }
        await chmod(dir, 0o700);
      }
      await rm(layout.ready, { force: true });
      await rm(layout.hostExit, { force: true });
      await writeXauthority(layout.xauthority);
      await writeFile(layout.defaultPa, defaultPaContent(layout), { mode: 0o600 });
      await writeFile(layout.clientConf, CLIENT_CONF_CONTENT, { mode: 0o600 });
      // A session left over from an earlier host (a failed start) must not collide.
      await this.options.tmux.killServiceSession(session);
      await this.options.tmux.newServiceSession({
        name: session,
        windowName: DESKTOP_HOST_WINDOW,
        cwd: layout.dir,
        env: {},
        bin: "/bin/sh",
        args: hostScriptArgs(layout, rt.record.size, rt.record.audio === true)
      });
    } catch (error) {
      await this.failStart(rt, `Could not start the desktop host: ${errorMessage(error)}`);
      return;
    }

    const settled = await waitFor(
      layout.dir,
      () => existsSync(layout.ready) || existsSync(layout.hostExit),
      this.readyTimeoutMs
    );
    if (generation !== rt.generation || !this.isCurrent(rt)) return;
    const display = settled && !existsSync(layout.hostExit) ? await readInt(layout.ready) : null;
    if (display === null) {
      const reason = existsSync(layout.hostExit)
        ? "The desktop host exited while starting."
        : `The desktop did not start within ${Math.round(this.readyTimeoutMs / 1000)} s.`;
      await this.killHost(rt);
      await this.failStart(rt, reason);
      return;
    }
    rt.record.display = display;
    rt.status = "running";
    this.watch(rt);
    await this.startTracker(rt);
    void this.store.persist();
    this.emitUpdated(rt);
  }

  private async failStart(rt: Runtime, reason: string): Promise<void> {
    const tail = (await readTail(this.layout(rt.record).hostLog, HOST_LOG_ERROR_TAIL_BYTES)).trim();
    rt.status = "error";
    rt.error = tail ? `${reason}\n${tail}` : reason;
    rt.record.display = null;
    void this.store.persist();
    this.emitUpdated(rt);
  }

  /**
   * Kill the service session and wait (bounded) for the host's trap to record
   * `host.exit` — by then it has TERMed and reaped its children — then SIGKILL
   * whatever is left of its process group (the pane pid leads it).
   */
  private async killHost(rt: Runtime): Promise<void> {
    const session = desktopSessionName(rt.record.id);
    const layout = this.layout(rt.record);
    const windows = await this.options.tmux.listServiceWindows(session).catch(() => []);
    const host = windows.find(
      (window) => window.name === DESKTOP_HOST_WINDOW
    );
    await this.options.tmux.killServiceSession(session);
    if (host) {
      await waitFor(layout.dir, () => existsSync(layout.hostExit), this.stopGraceMs);
      signalGroup(host.panePid, "SIGKILL");
    }
  }

  /**
   * Take a desktop down (§5.4 "Stop desktop"): watchers and tracker off, every
   * live app's group SIGKILLed and its exit awaited (app-run.sh records it once
   * it has reaped the app), then the host, the audio encoder and the directory.
   * Apps end `exited`.
   */
  private async teardown(rt: Runtime): Promise<void> {
    rt.generation += 1;
    this.unwatch(rt);
    this.stopTracker(rt);
    for (const timer of rt.killTimers.values()) clearTimeout(timer);
    rt.killTimers.clear();
    rt.pendingStops.clear();
    const layout = this.layout(rt.record);
    const live = rt.record.apps.filter((app) => app.status !== "exited");
    for (const app of live) {
      app.pgid = app.pgid ?? (await readInt(appFile(layout, app.id, "pgid")));
      if (app.pgid !== null) signalGroup(app.pgid, "SIGKILL");
    }
    const signalled = live.filter((app) => app.pgid !== null);
    if (signalled.length > 0) {
      await waitFor(
        layout.appsDir,
        () => signalled.every((app) => existsSync(appFile(layout, app.id, "exit"))),
        this.stopGraceMs
      );
    }
    const exitedAt = this.now().toISOString();
    for (const app of live) {
      app.status = "exited";
      app.exitCode = await readInt(appFile(layout, app.id, "exit"));
      app.exitedAt = exitedAt;
    }
    await this.killHost(rt);
    this.options.audio?.stopDesktop(rt.record.id);
    rt.record.display = null;
    rt.windows = [];
    rt.activeWindowId = null;
    this.emit("windows", { desktopId: rt.record.id, windows: [], activeWindowId: null });
    await rm(layout.dir, { recursive: true, force: true });
    if (layout.socketDir !== layout.dir) await rm(layout.socketDir, { recursive: true, force: true });
  }

  /** The host exited on its own (Xvnc crash, host killed): §5.4 "Host exit". */
  private async onHostExit(rt: Runtime, generation: number): Promise<void> {
    await this.enqueue(rt, async () => {
      if (generation !== rt.generation || !this.isCurrent(rt) || rt.status !== "running") return;
      rt.generation += 1;
      this.unwatch(rt);
      this.stopTracker(rt);
      const layout = this.layout(rt.record);
      const exitedAt = this.now().toISOString();
      for (const app of rt.record.apps) {
        if (app.status === "exited") continue;
        // Apps run in their own groups, out of the host trap's reach. A pgid
        // written but not yet synced is read from its file, as teardown does.
        app.pgid = app.pgid ?? (await readInt(appFile(layout, app.id, "pgid")));
        if (app.pgid !== null) signalGroup(app.pgid, "SIGKILL");
        app.status = "exited";
        app.exitCode = null;
        app.exitedAt = exitedAt;
        const timer = rt.killTimers.get(app.id);
        if (timer) clearTimeout(timer);
        rt.killTimers.delete(app.id);
      }
      rt.pendingStops.clear();
      await this.options.tmux.killServiceSession(desktopSessionName(rt.record.id));
      this.options.audio?.stopDesktop(rt.record.id);
      const code = await readInt(layout.hostExit);
      const tail = (await readTail(layout.hostLog, HOST_LOG_ERROR_TAIL_BYTES)).trim();
      rt.status = "stopped";
      rt.error = `The desktop host exited${code === null ? "" : ` (${code})`}.${tail ? `\n${tail}` : ""}`;
      rt.record.display = null;
      rt.windows = [];
      rt.activeWindowId = null;
      this.emit("windows", { desktopId: rt.record.id, windows: [], activeWindowId: null });
      void this.store.persist();
      this.emitUpdated(rt);
    }).catch((error) => this.logger.error(`Desktop ${rt.record.id}: host exit handling failed`, error));
  }

  // ---------------------------------------------------------------------------
  // Watchers and the window tracker
  // ---------------------------------------------------------------------------

  private watch(rt: Runtime): void {
    this.unwatch(rt);
    const layout = this.layout(rt.record);
    const generation = rt.generation;
    const checkHost = () => {
      if (!this.stopped && existsSync(layout.hostExit)) void this.onHostExit(rt, generation);
    };
    try {
      rt.dirWatcher = watch(layout.dir, (_event, name) => {
        if (name === null || name === "host.exit") checkHost();
      });
      rt.dirWatcher.on("error", (error) => this.logger.warn(`Desktop ${rt.record.id}: dir watch failed`, error));
      // App logs are appended to constantly; only the status files matter.
      rt.appsWatcher = watch(layout.appsDir, (_event, name) => {
        if (name === null || name.endsWith(".pgid") || name.endsWith(".exit")) this.syncApps(rt);
      });
      rt.appsWatcher.on("error", (error) => this.logger.warn(`Desktop ${rt.record.id}: apps watch failed`, error));
    } catch (error) {
      this.logger.warn(`Desktop ${rt.record.id}: could not watch its directory`, error);
    }
    // Anything that landed before the watch existed.
    checkHost();
  }

  private unwatch(rt: Runtime): void {
    rt.dirWatcher?.close();
    rt.appsWatcher?.close();
    rt.dirWatcher = null;
    rt.appsWatcher = null;
  }

  /**
   * Apply what app-run.sh reported: `.pgid` → running (and any stop asked for
   * meanwhile), `.exit` → exited with its status. Coalesced: one pass at a time.
   */
  private syncApps(rt: Runtime): void {
    if (rt.syncing) {
      rt.syncAgain = true;
      return;
    }
    rt.syncing = true;
    const generation = rt.generation;
    void (async () => {
      try {
        do {
          rt.syncAgain = false;
          if (generation !== rt.generation || rt.status !== "running" || !this.isCurrent(rt)) return;
          const layout = this.layout(rt.record);
          let changed = false;
          for (const app of rt.record.apps) {
            if (app.status === "exited") continue;
            if (app.pgid === null) {
              const pgid = await readInt(appFile(layout, app.id, "pgid"));
              if (pgid !== null) {
                app.pgid = pgid;
                app.status = "running";
                changed = true;
                const force = rt.pendingStops.get(app.id);
                if (force !== undefined) {
                  rt.pendingStops.delete(app.id);
                  this.signalApp(rt, app, force);
                }
              }
            }
            const exitPath = appFile(layout, app.id, "exit");
            if (existsSync(exitPath)) {
              app.status = "exited";
              app.exitCode = await readInt(exitPath);
              app.exitedAt = this.now().toISOString();
              const timer = rt.killTimers.get(app.id);
              if (timer) clearTimeout(timer);
              rt.killTimers.delete(app.id);
              rt.pendingStops.delete(app.id);
              changed = true;
            }
          }
          if (changed && generation === rt.generation) {
            this.pruneApps(rt);
            rt.tracker?.refreshApps();
            void this.store.persist();
            this.emitUpdated(rt);
          }
        } while (rt.syncAgain);
      } catch (error) {
        this.logger.warn(`Desktop ${rt.record.id}: app state sync failed`, error);
      } finally {
        rt.syncing = false;
      }
    })();
  }

  private async startTracker(rt: Runtime): Promise<void> {
    this.stopTracker(rt);
    if (rt.record.display === null) return;
    const options: DesktopWindowTrackerOptions = {
      display: rt.record.display,
      xauthorityPath: this.layout(rt.record).xauthority,
      appForPgid: (pgid) => rt.record.apps.find((app) => app.pgid === pgid)?.id ?? null
    };
    const tracker = this.options.createTracker?.(options) ?? new DesktopWindowTracker(options);
    rt.tracker = tracker;
    tracker.on("change", (snapshot) => {
      if (rt.tracker !== tracker) return;
      rt.windows = snapshot.windows;
      rt.activeWindowId = snapshot.activeWindowId;
      this.emit("windows", {
        desktopId: rt.record.id,
        windows: snapshot.windows,
        activeWindowId: snapshot.activeWindowId
      });
    });
    tracker.on("resize", (size) => {
      if (rt.tracker !== tracker) return;
      if (size.width === rt.record.size.width && size.height === rt.record.size.height) return;
      rt.record.size = { width: size.width, height: size.height };
      void this.store.persist();
      this.emitUpdated(rt);
    });
    tracker.on("error", (error) => this.logger.warn(`Desktop ${rt.record.id}: window tracker failed`, error));
    try {
      await tracker.start();
      if (rt.tracker !== tracker) return;
      const snapshot = tracker.snapshot();
      rt.windows = snapshot.windows;
      rt.activeWindowId = snapshot.activeWindowId;
    } catch (error) {
      this.logger.warn(`Desktop ${rt.record.id}: window tracker could not connect`, error);
      if (rt.tracker === tracker) {
        tracker.stop();
        rt.tracker = null;
      }
    }
  }

  private stopTracker(rt: Runtime): void {
    rt.tracker?.stop();
    rt.tracker = null;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private signalApp(rt: Runtime, app: DesktopAppRecord, force: boolean): void {
    if (app.pgid === null) return;
    signalGroup(app.pgid, force ? "SIGKILL" : "SIGTERM");
    if (force || rt.killTimers.has(app.id)) return;
    const pgid = app.pgid;
    const timer = setTimeout(() => {
      rt.killTimers.delete(app.id);
      if (app.status !== "exited") signalGroup(pgid, "SIGKILL");
    }, this.stopGraceMs);
    timer.unref?.();
    rt.killTimers.set(app.id, timer);
  }

  /** Keep the newest DESKTOP_MAX_EXITED_APPS exited apps; the older ones' files go too. */
  private pruneApps(rt: Runtime): void {
    const exited = rt.record.apps
      .filter((app) => app.status === "exited")
      .sort((a, b) => (b.exitedAt ?? b.startedAt).localeCompare(a.exitedAt ?? a.startedAt));
    const doomed = new Set(exited.slice(DESKTOP_MAX_EXITED_APPS).map((app) => app.id));
    if (doomed.size === 0) return;
    rt.record.apps = rt.record.apps.filter((app) => !doomed.has(app.id));
    const layout = this.layout(rt.record);
    for (const appId of doomed) {
      for (const ext of ["log", "exit", "pgid"] as const) {
        void rm(appFile(layout, appId, ext), { force: true }).catch(() => {});
      }
    }
  }

  /** Newest first, one entry per command + cwd, capped per project. */
  private rememberLaunch(projectPath: string, input: LaunchAppInput): void {
    const launches = (this.recent[projectPath] ?? []).filter(
      (launch) => !(launch.command === input.command && launch.cwd === input.cwd)
    );
    launches.unshift({
      command: input.command,
      cwd: input.cwd,
      env: { ...input.env },
      lastUsedAt: this.now().toISOString()
    });
    this.recent = { ...this.recent, [projectPath]: launches.slice(0, DESKTOP_MAX_RECENT_LAUNCHES) };
  }

  private layout(record: DesktopRecord): DesktopLayout {
    return desktopLayout(desktopRuntimeDir(this.options.baseDir, record.id), record.socketDir);
  }

  private summary(rt: Runtime): DesktopSummary {
    const { record } = rt;
    return {
      id: record.id,
      projectPath: record.projectPath,
      title: record.title,
      order: record.order,
      createdAt: record.createdAt,
      display: record.display,
      size: { width: record.size.width, height: record.size.height },
      renderThreads: record.renderThreads,
      status: rt.status,
      ...(rt.error ? { error: rt.error } : {}),
      audio: record.audio === true ? "available" : "unavailable",
      apps: record.apps.map(appSummary),
      windows: rt.windows,
      activeWindowId: rt.activeWindowId
    };
  }

  private emitUpdated(rt: Runtime): void {
    if (this.isCurrent(rt)) this.emit("updated", this.summary(rt));
  }

  private isCurrent(rt: Runtime): boolean {
    return this.desktops.get(rt.record.id) === rt;
  }

  private mustGet(id: string): Runtime {
    const rt = this.desktops.get(id);
    if (!rt) throw new DesktopError(404, "DESKTOP_NOT_FOUND", "No such desktop.");
    return rt;
  }

  private requireWritable(): void {
    if (this.store.readOnlyReason !== null) {
      throw new DesktopError(503, "DESKTOPS_UNAVAILABLE", `${this.store.readOnlyReason}; restart the daemon after fixing it.`);
    }
  }

  /** Run `fn` after every earlier lifecycle operation of this desktop. */
  private enqueue<T>(rt: Runtime, fn: () => Promise<T>): Promise<T> {
    const run = rt.queue.then(fn, fn);
    rt.queue = run.catch(() => undefined);
    return run;
  }

  private newId(): string {
    for (;;) {
      const id = randomBytes(6).toString("hex");
      if (!this.desktops.has(id)) return id;
    }
  }

  private newAppId(rt: Runtime): string {
    for (;;) {
      const id = randomBytes(4).toString("hex");
      if (!rt.record.apps.some((app) => app.id === id)) return id;
    }
  }
}

function newRuntime(record: DesktopRecord): Runtime {
  return {
    record,
    status: "stopped",
    tracker: null,
    windows: [],
    activeWindowId: null,
    dirWatcher: null,
    appsWatcher: null,
    killTimers: new Map(),
    pendingStops: new Map(),
    queue: Promise.resolve(),
    generation: 0,
    syncing: false,
    syncAgain: false
  };
}

function appSummary(app: DesktopAppRecord): DesktopAppSummary {
  return {
    id: app.id,
    desktopId: app.desktopId,
    command: app.command,
    cwd: app.cwd,
    env: { ...app.env },
    status: app.status,
    exitCode: app.exitCode,
    startedAt: app.startedAt,
    exitedAt: app.exitedAt
  };
}

function unavailable(host: DesktopHostStatus): DesktopError {
  const missing = host.tools.filter((tool) => tool.required && tool.path === null).map((tool) => tool.name);
  const message =
    missing.length > 0
      ? `Desktops need ${missing.join(", ")} on the server.`
      : "Desktops need tmux 3.2 or newer on the server.";
  return new DesktopError(409, DESKTOP_UNAVAILABLE_CODE, message, host.installHint);
}

function clampThreads(threads: number): number {
  return Math.min(Math.max(1, Math.round(threads)), Math.max(1, availableParallelism()));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Signal a whole process group; a gone group (or a nonsense pgid) is ignored. */
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  // > 1: never the caller's own group (0) or init's.
  if (!Number.isInteger(pgid) || pgid <= 1) return;
  try {
    process.kill(-pgid, signal);
  } catch {
    /* already gone */
  }
}

/** Whether the process `pid` carries `XAUTHORITY=<xauthority>` (a desktop app's leader, not a recycled pid). */
async function leaderBelongsTo(pid: number, xauthority: string): Promise<boolean> {
  try {
    const environ = await readFile(`/proc/${pid}/environ`, "utf8");
    return environ.split("\0").includes(`XAUTHORITY=${xauthority}`);
  } catch {
    return false;
  }
}

/** The integer in a small status file (`ready`, `.pgid`, `.exit`), or null. */
async function readInt(path: string): Promise<number | null> {
  try {
    const text = (await readFile(path, "utf8")).trim();
    return /^-?\d+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

async function readExitFiles(layout: DesktopLayout): Promise<Map<string, number | null>> {
  const exits = new Map<string, number | null>();
  let names: string[];
  try {
    names = await readdir(layout.appsDir);
  } catch {
    return exits;
  }
  for (const name of names) {
    if (!name.endsWith(".exit")) continue;
    const appId = name.slice(0, -".exit".length);
    exits.set(appId, await readInt(appFile(layout, appId, "exit")));
  }
  return exits;
}

/** The last `bytes` of a file as UTF-8 ("" when it does not exist). */
async function readTail(path: string, bytes: number): Promise<string> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return "";
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Resolve true once `done()` holds, re-checked on every fs.watch event in
 * `dir`, or false after `timeoutMs` (or when `dir` cannot be watched and the
 * condition is not already true). No polling.
 */
function waitFor(dir: string, done: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let watcher: FSWatcher | null = null;
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(done()), timeoutMs);
    try {
      watcher = watch(dir, () => {
        if (done()) finish(true);
      });
      watcher.on("error", () => finish(done()));
    } catch {
      finish(done());
      return;
    }
    if (done()) finish(true);
  });
}

/** The record's project realpath (records from before `projectRealPath` stored the realpath as `projectPath`). */
function realProjectPath(record: DesktopRecord): string {
  return record.projectRealPath ?? record.projectPath;
}
