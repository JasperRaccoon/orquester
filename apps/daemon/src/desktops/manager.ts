import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { sep } from "node:path";
import type { Duplex } from "node:stream";
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
import type { DesktopAudioHub, DesktopAudioSpawn } from "./audio.ts";
import { type DesktopBoxes, type DesktopGroupOwner, type DesktopHost, type DesktopWatch, LocalDesktopHost } from "./desktop-host.ts";
import {
  CLIENT_CONF_CONTENT,
  DESKTOP_HOST_WINDOW,
  DESKTOP_SESSION_PREFIX,
  type DesktopLayout,
  appEnvFileContent,
  appFile,
  appWindowName,
  defaultPaContent,
  desktopLayout,
  desktopSessionName,
  hostScriptArgs
} from "./host-env.ts";
import { type ReconciledDesktop, reconcile } from "./reconcile.ts";
import { DesktopStore } from "./store.ts";
import { DesktopWindowNotFoundError, DesktopWindowTracker, type DesktopWindowTrackerOptions } from "./windows.ts";
import { newXauthority } from "./x11/xauth.ts";

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
  /** boxes: desktops in Linux VMs (Ephemeral AI VMs). Absent: every desktop runs on this machine. */
  boxes?: DesktopBoxes;
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
  /** boxes: the Linux VM the project lives in (the routes contained the paths there); absent: this machine. */
  boxId?: string;
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
  dirWatcher: DesktopWatch | null;
  appsWatcher: DesktopWatch | null;
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
  /** boxes: not reconciled against its VM since the daemon started (the VM was not connected yet). */
  awaitingBox: boolean;
  /** boxes: the VM's link dropped while the desktop ran there (its processes keep running). */
  linkDown: boolean;
  /**
   * boxes: what runs in the VM is not known for sure any more — its link dropped (the VM may
   * have rebooted meanwhile), or a kill could not reach it — so the next connect reconciles it
   * again: a desktop whose processes are gone ends stopped, leftovers of a stopped one are killed.
   */
  reconcilePending: boolean;
  /** boxes: what a `starting` desktop is waiting on (the install's latest line, the VM). */
  statusDetail?: string;
  /** boxes: the pending coalesced `updated` for install progress. */
  progressTimer: NodeJS.Timeout | null;
}

/** The last state seen of a box with desktops, so only changes act. */
type BoxLinkState = "connected" | "disconnected" | "gone";

const READY_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 5_000;
/** The tail of an app log the log route returns, and of host.log in an error. */
const APP_LOG_TAIL_BYTES = 64 * 1024;
const HOST_LOG_ERROR_TAIL_BYTES = 2048;
/** Install progress goes out at most this often. */
const PROGRESS_EMIT_MS = 250;
const MAX_STATUS_DETAIL = 300;
const BOX_UNREACHABLE = "The VM is not connected right now; try again once it is back.";

/**
 * The daemon's desktops (desktop spec §5): one tmux service session per
 * desktop (`orqsvc-desktop-<id>`) whose `host` window runs desktop-host.sh and
 * whose `app-<appId>` windows run app-run.sh. Everything the scripts report
 * arrives through files in the desktop dir (`ready`, `host.exit`,
 * `apps/<appId>.{pgid,exit}`), watched with fs.watch — never polled. Desktops
 * outlive the daemon; `reattach()` rebuilds their state from tmux and those
 * files on boot.
 *
 * boxes: a desktop of a Linux box project runs entirely in the box — the same
 * scripts, session and files, reached through the box's {@link DesktopHost}.
 * Its record names the box; it is reconciled once the box connects, rides out
 * link drops (`box.connected: false`, everything keeps running there), and
 * ends stopped when the box is gone.
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
  /** This machine. */
  private readonly local: LocalDesktopHost;
  /** boxes: per box, the last link state acted on, and the pass running for it. */
  private readonly boxStates = new Map<string, BoxLinkState>();
  private readonly boxPasses = new Map<string, Promise<void>>();
  /** boxes: boxes whose link dropped since their last pass (each such drop gets a reconcile). */
  private readonly boxesDropped = new Set<string>();
  private readonly unsubscribeBoxes: () => void;

  constructor(private readonly options: DesktopManagerOptions) {
    super();
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => new Date());
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS;
    this.local = new LocalDesktopHost({
      baseDir: options.baseDir,
      tmux: options.tmux,
      baseEnv: options.baseEnv,
      renderNode: options.renderNode,
      tmpDir: options.tmpDir
    });
    this.store = new DesktopStore({ file: options.indexFile, logger: this.logger });
    this.store.setSnapshot(() => ({
      desktops: [...this.desktops.values()].map((rt) => rt.record),
      recent: this.recent
    }));
    this.unsubscribeBoxes = options.boxes?.onChange((boxId) => this.boxChanged(boxId)) ?? (() => {});
  }

  /**
   * Read the index. Every desktop starts `stopped` until `reattach()` finds its
   * host; a VM desktop starts `starting` until its VM connects.
   */
  async load(): Promise<void> {
    const file = await this.store.load();
    this.desktops.clear();
    this.boxStates.clear();
    for (const record of file.desktops) {
      const rt = newRuntime(record);
      if (record.box) {
        rt.status = "starting";
        rt.awaitingBox = true;
        rt.statusDetail = "Waiting for the VM to connect…";
      }
      this.desktops.set(record.id, rt);
    }
    this.recent = file.recent;
  }

  hostStatus(): Promise<DesktopHostStatus> {
    return this.options.hostStatus();
  }

  /** boxes: the desktop stack in a box as it is now (never installs). */
  async boxHostStatus(boxId: string): Promise<DesktopHostStatus> {
    if (!this.options.boxes) {
      throw new DesktopError(409, DESKTOP_UNAVAILABLE_CODE, "VM desktops are not available on this daemon.");
    }
    return this.options.boxes.status(boxId);
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
    return this.reachable(rt).readTail(appFile(this.layout(rt.record), appId, "log"), APP_LOG_TAIL_BYTES);
  }

  /** The RFB socket of a RUNNING desktop on this machine, else null (the relay's lookup). */
  vncSocketPath(id: string): string | null {
    const rt = this.desktops.get(id);
    return rt?.status === "running" && rt.record.box === null ? this.layout(rt.record).vncSocket : null;
  }

  /** boxes: how the relay reaches a RUNNING VM desktop's RFB socket (through the box link), else null. */
  vncStream(id: string): (() => Promise<Duplex>) | null {
    const rt = this.desktops.get(id);
    if (rt?.status !== "running" || rt.record.box === null) return null;
    const machine = this.hostOf(rt);
    if (!machine?.connected || !machine.connectUnix) return null;
    const path = this.layout(rt.record).vncSocket;
    return () => machine.connectUnix!(path);
  }

  /**
   * The pulse socket of a running desktop with audio (and, in a VM, how to
   * start the encoder there), the reason when it has none, null when not
   * running (or its VM is not connected).
   */
  audioSource(id: string): { pulseSocketPath: string; spawn?: DesktopAudioSpawn } | { unavailable: string } | null {
    const rt = this.desktops.get(id);
    if (rt?.status !== "running") return null;
    if (rt.record.box !== null) {
      const machine = this.hostOf(rt);
      if (!machine?.connected) return null;
      if (rt.record.audio !== true || !machine.audioSpawn) {
        return { unavailable: "This desktop was started without sound (PulseAudio or ffmpeg with pulse and libopus is missing in the VM)." };
      }
      return { pulseSocketPath: this.layout(rt.record).pulseSocket, spawn: machine.audioSpawn };
    }
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
   *
   * boxes: in a VM whose desktop stack is incomplete, the missing packages are
   * installed first while the tab shows `starting` with the install's progress
   * (`statusDetail`); an install that cannot happen drops the tab again and
   * throws 409 DESKTOP_UNAVAILABLE with its hint.
   */
  async create(input: CreateDesktopInput): Promise<DesktopSummary> {
    const boxId = input.boxId ?? null;
    const machine = boxId === null ? this.local : this.boxHost(boxId);
    let host = boxId === null ? await this.options.hostStatus() : await this.boxHostStatus(boxId);
    if (boxId === null && !host.available) throw unavailable(host);
    this.requireWritable();
    const id = this.newId();
    const dir = machine.desktopDir(id);
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
      renderThreads: clampThreads(input.renderThreads ?? DESKTOP_DEFAULT_RENDER_THREADS, machine.parallelism),
      socketDir: await machine.socketFallback(dir, id),
      apps: [],
      // Whether this host runs PulseAudio (a passthrough field: older builds keep it).
      audio: host.audioAvailable,
      box: boxId === null ? null : { id: boxId, dir }
    });
    const rt = newRuntime(record);
    rt.status = "starting";
    this.desktops.set(id, rt);
    void this.store.persist();
    this.emit("created", this.summary(rt));
    // A stop (or close) while the VM installs bumps this: the start is then off.
    const generation = rt.generation;
    if (boxId !== null && needsInstall(host)) {
      try {
        host = await this.installInBox(rt, boxId);
      } catch (error) {
        if (this.isCurrent(rt)) {
          this.desktops.delete(id);
          void this.store.persist();
          this.emit("closed", { id });
        }
        throw error;
      }
      rt.record.audio = host.audioAvailable;
    }
    await this.enqueue(rt, async () => {
      // (Closed or stopped while its VM was installing.)
      if (this.isCurrent(rt) && rt.status === "starting" && rt.generation === generation) await this.startHost(rt);
    });
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
      // A VM desktop is stopped in its VM, so the VM must be reachable (close works without).
      this.reachable(rt);
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
      if (rt.record.box !== null) {
        await this.restartInBox(rt, rt.record.box.id);
        return;
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

  /**
   * boxes: `restart` of a VM desktop — installs what its VM is missing first
   * (as `create` does), then starts the host there. An install that cannot
   * happen leaves it `error` with the reason and throws 409.
   */
  private async restartInBox(rt: Runtime, boxId: string): Promise<void> {
    this.reachable(rt);
    this.requireWritable();
    let host = await this.boxHostStatus(boxId);
    rt.status = "starting";
    rt.error = undefined;
    this.emitUpdated(rt);
    if (needsInstall(host)) {
      try {
        host = await this.installInBox(rt, boxId);
      } catch (error) {
        const hint = error instanceof DesktopError && error.hint ? `\n${error.hint}` : "";
        rt.status = "error";
        rt.error = `${errorMessage(error)}${hint}`;
        this.emitUpdated(rt);
        throw error;
      }
    }
    rt.record.audio = host.audioAvailable;
    await this.startHost(rt);
  }

  /**
   * boxes: install the VM's missing desktop packages for a `starting` desktop,
   * its progress in `statusDetail` (coalesced updates). Resolves with the VM's
   * status once complete; throws a DesktopError when the VM cannot get them.
   */
  private async installInBox(rt: Runtime, boxId: string): Promise<DesktopHostStatus> {
    const boxes = this.options.boxes;
    if (!boxes) throw new DesktopError(409, DESKTOP_UNAVAILABLE_CODE, "VM desktops are not available on this daemon.");
    rt.statusDetail = "Checking the desktop packages in the VM…";
    this.emitUpdated(rt);
    try {
      const host = await boxes.ensure(boxId, (line) => {
        const detail = line.trim().slice(0, MAX_STATUS_DETAIL);
        if (!detail) return;
        rt.statusDetail = detail;
        if (rt.progressTimer) return;
        rt.progressTimer = setTimeout(() => {
          rt.progressTimer = null;
          if (rt.status === "starting") this.emitUpdated(rt);
        }, PROGRESS_EMIT_MS);
        rt.progressTimer.unref?.();
      });
      if (!host.available) throw unavailable(host, "in the VM");
      return host;
    } finally {
      if (rt.progressTimer) clearTimeout(rt.progressTimer);
      rt.progressTimer = null;
      rt.statusDetail = undefined;
    }
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
      const machine = this.reachable(rt);
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
      // The machine's base env, the desktop wiring and the GL rules, the user's
      // variables last (and, on this machine, the plugins' NODE_OPTIONS preload).
      const env = await machine.appEnv({
        layout,
        display: rt.record.display,
        renderThreads: rt.record.renderThreads,
        user: input.env
      });
      const { app: appScript } = await machine.scripts();
      const envFile = appFile(layout, app.id, "env");
      await machine.writeFile(envFile, appEnvFileContent(env, input.cwd, input.command), 0o600);
      rt.record.apps.push(app);
      this.pruneApps(rt);
      this.rememberLaunch(realProjectPath(rt.record), input);
      void this.store.persist();
      this.emitUpdated(rt);
      try {
        await machine.tmux.newServiceWindow({
          session: desktopSessionName(id),
          name: appWindowName(app.id),
          cwd: layout.dir,
          env: {},
          bin: "/bin/sh",
          args: [appScript, layout.dir, app.id]
        });
      } catch (error) {
        await machine.rm(envFile).catch(() => {});
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
   *
   * boxes: this machine's desktops are reconciled here; a VM desktop against
   * its VM once that is connected (now, or when it connects).
   */
  async reattach(): Promise<void> {
    await this.reconcileOn(
      this.local,
      [...this.desktops.values()].filter((rt) => rt.record.box === null)
    );
    const boxIds = new Set([...this.desktops.values()].flatMap((rt) => (rt.record.box ? [rt.record.box.id] : [])));
    for (const boxId of boxIds) this.boxChanged(boxId);
  }

  /**
   * Reconcile `runtimes` against their machine's tmux and files (§5.6), and
   * reap that machine's unclaimed desktop sessions. On this machine (boot) the
   * outcome is applied at once. In a box (when it connects) a read that fails —
   * the link dropped again — changes nothing (the next connect retries), and
   * each desktop's outcome is applied in its queue unless an operation ran on
   * it meanwhile.
   */
  private async reconcileOn(machine: DesktopHost, runtimes: Runtime[]): Promise<void> {
    const inBox = machine.boxId !== null;
    // What each desktop was before anything is read: an operation that runs meanwhile (a launch,
    // a stop) is not undone by an outcome read before it (an app launched meanwhile has no window
    // in the listing yet).
    const generations = new Map(runtimes.map((rt) => [rt, rt.generation] as const));
    const knownApps = new Map(runtimes.map((rt) => [rt, new Set(rt.record.apps.map((app) => app.id))] as const));
    let liveSessions: string[];
    const windowsBySession = new Map<string, string[]>();
    try {
      liveSessions = await machine.tmux.listServiceSessions(DESKTOP_SESSION_PREFIX);
      for (const session of liveSessions) {
        windowsBySession.set(
          session,
          (await machine.tmux.listServiceWindows(session)).map((window) => window.name)
        );
      }
    } catch (error) {
      if (inBox) {
        this.logger.warn(`Desktops in box ${machine.boxId}: reattach deferred, its tmux could not be listed`, error);
        return;
      }
      // tmux could not be read: reconciling now would stop live desktops and kill
      // their apps. Leave every process alone; the desktops show as unknown-stopped.
      this.logger.error("Desktop reattach skipped: tmux could not be listed", error);
      for (const rt of runtimes) {
        rt.status = "error";
        rt.error = "Could not reach tmux at startup; restart the daemon to reattach this desktop.";
        this.emitUpdated(rt);
      }
      return;
    }
    const readyFiles = new Map<string, number>();
    const hostExitFiles = new Set<string>();
    const appExitFiles = new Map<string, Map<string, number | null>>();
    try {
      for (const rt of runtimes) {
        const layout = this.layout(rt.record);
        // In a box a failed read must not read as "no file": it would stop a live desktop.
        const display = inBox ? parseIntText(await machine.readText(layout.ready)) : await readInt(machine, layout.ready);
        if (display !== null) readyFiles.set(rt.record.id, display);
        if (await machine.exists(layout.hostExit)) hostExitFiles.add(rt.record.id);
        appExitFiles.set(rt.record.id, await readExitFiles(machine, layout, inBox));
      }
    } catch (error) {
      // Only a box's reads throw.
      this.logger.warn(`Desktops in box ${machine.boxId}: reattach deferred, the VM could not be read`, error);
      return;
    }
    const result = reconcile({
      records: runtimes.map((rt) => rt.record),
      liveSessions,
      windowsBySession,
      readyFiles,
      hostExitFiles,
      appExitFiles,
      indexLoaded: this.store.loaded,
      // Every desktop of this daemon claims its session name, wherever it runs.
      claimedIds: [...this.store.rejectedIds(), ...this.desktops.keys()]
    });

    for (const session of result.reap) {
      this.logger.warn(`Reaping desktop session ${session}${inBox ? ` in box ${machine.boxId}` : ""}: no desktop record claims it.`);
      if (inBox) await this.reapInBox(machine, session);
      else await machine.tmux.killServiceSession(session);
    }
    const now = this.now().toISOString();
    for (const reconciled of result.desktops) {
      const rt = this.desktops.get(reconciled.id);
      if (!rt) continue;
      if (!inBox) {
        await this.applyReconciled(machine, rt, reconciled, now);
        continue;
      }
      await this.enqueue(rt, async () => {
        if (this.stopped || !this.isCurrent(rt) || rt.generation !== generations.get(rt) || !machine.connected) return;
        const known = knownApps.get(rt)!;
        const outcome = { ...reconciled, apps: reconciled.apps.filter((app) => known.has(app.id)) };
        if (rt.awaitingBox) await this.applyReconciled(machine, rt, outcome, now);
        else await this.applyReconnected(machine, rt, outcome, now);
        rt.awaitingBox = false;
        rt.reconcilePending = false;
        rt.linkDown = false;
        rt.statusDetail = undefined;
        void this.store.persist();
        this.emitUpdated(rt);
      }).catch((error) => this.logger.warn(`Desktop ${rt.record.id}: reattach in its VM failed`, error));
    }
    if (inBox) return;
    void this.store.persist();
    for (const rt of runtimes) this.emitUpdated(rt);
  }

  /**
   * boxes: a VM desktop's reconciled state after its VM was out of sight (the
   * link dropped, a kill could not reach it). A running one that still runs
   * there carries on (watched and tracked again); one whose processes are gone
   * (the VM restarted, they were killed) ends stopped, saying so. A stopped or
   * failed one with leftovers there (a host that came up after its start timed
   * out, a stop that lost the link) has them killed, and stays as it is.
   */
  private async applyReconnected(machine: DesktopHost, rt: Runtime, reconciled: ReconciledDesktop, now: string): Promise<void> {
    // Starting (its VM installing): the create that is installing it decides what comes next.
    if (rt.status === "starting") return;
    if (rt.status === "stopped" || rt.status === "error") {
      if (reconciled.status !== "running" && !reconciled.killSession) return;
      const layout = this.layout(rt.record);
      for (const outcome of reconciled.apps) {
        if (outcome.status !== "running") continue;
        const app = rt.record.apps.find((candidate) => candidate.id === outcome.id);
        const pgid = app?.pgid ?? (await readInt(machine, appFile(layout, outcome.id, "pgid")));
        if (pgid !== null) await machine.signalGroup(pgid, "SIGKILL", appOwner(layout));
      }
      await this.killHost(rt);
      return;
    }
    await this.applyReconciled(machine, rt, reconciled, now);
    // Running here: still running there, or its processes are gone.
    if (reconciled.status === "running") return;
    rt.generation += 1;
    this.unwatch(rt);
    this.stopTracker(rt);
    for (const timer of rt.killTimers.values()) clearTimeout(timer);
    rt.killTimers.clear();
    rt.pendingStops.clear();
    this.options.audio?.stopDesktop(rt.record.id);
    rt.error = "The desktop's processes in the VM ended while the VM was out of reach (did it restart?).";
    rt.windows = [];
    rt.activeWindowId = null;
    this.emit("windows", { desktopId: rt.record.id, windows: [], activeWindowId: null });
  }

  /** One desktop's reconciled state, applied: apps, then running (watched, tracked) or stopped. */
  private async applyReconciled(machine: DesktopHost, rt: Runtime, reconciled: ReconciledDesktop, now: string): Promise<void> {
    const layout = this.layout(rt.record);
    for (const outcome of reconciled.apps) {
      const app = rt.record.apps.find((candidate) => candidate.id === outcome.id);
      if (!app) continue;
      if (outcome.status === "exited") {
        const wasLive = app.status !== "exited";
        if (wasLive && reconciled.status === "stopped" && app.pgid !== null) {
          // The host died while the daemon was away; its apps' groups may outlive it.
          // Kill only a group whose leader still carries this desktop's X authority path.
          if (await machine.leaderBelongsTo(app.pgid, layout.xauthority)) await machine.signalGroup(app.pgid, "SIGKILL", appOwner(layout));
        }
        app.status = "exited";
        app.exitCode = outcome.exitCode;
        app.exitedAt = app.exitedAt ?? now;
      } else {
        app.pgid = app.pgid ?? (await readInt(machine, appFile(layout, app.id, "pgid")));
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

  /**
   * boxes: take down a desktop session in a box that no record claims (a tab
   * closed while its VM was unreachable): the app groups still carrying its
   * authority path (out of the session's reach), the session and its host's
   * group, then its directories.
   */
  private async reapInBox(machine: DesktopHost, session: string): Promise<void> {
    const id = session.slice(DESKTOP_SESSION_PREFIX.length);
    const dir = machine.desktopDir(id);
    const socketDir = await machine.socketFallback(dir, id);
    const layout = desktopLayout(dir, socketDir);
    try {
      for (const name of await machine.readdir(layout.appsDir)) {
        if (!name.endsWith(".pgid")) continue;
        const pgid = await readInt(machine, appFile(layout, name.slice(0, -".pgid".length), "pgid"));
        if (pgid !== null) await machine.signalGroup(pgid, "SIGKILL", appOwner(layout));
      }
      const windows = await machine.tmux.listServiceWindows(session).catch(() => []);
      const hostWindow = windows.find((window) => window.name === DESKTOP_HOST_WINDOW);
      await machine.tmux.killServiceSession(session);
      if (hostWindow) {
        await waitFor(machine, layout.dir, () => machine.exists(layout.hostExit), this.stopGraceMs);
        await machine.signalGroup(hostWindow.panePid, "SIGKILL", hostOwner(layout));
      }
      await machine.rm(layout.dir, { recursive: true });
      if (layout.socketDir !== layout.dir) await machine.rm(layout.socketDir, { recursive: true });
    } catch (error) {
      this.logger.warn(`Reaping desktop session ${session} in box ${machine.boxId} failed`, error);
    }
  }

  /**
   * Daemon shutdown: close watchers, trackers and timers only. The desktops
   * keep running in tmux; the next boot reattaches them.
   */
  async shutdown(): Promise<void> {
    this.stopped = true;
    this.unsubscribeBoxes();
    for (const rt of this.desktops.values()) {
      this.unwatch(rt);
      this.stopTracker(rt);
      for (const timer of rt.killTimers.values()) clearTimeout(timer);
      rt.killTimers.clear();
      if (rt.progressTimer) clearTimeout(rt.progressTimer);
      rt.progressTimer = null;
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
    const machine = this.hostOf(rt);
    try {
      if (!machine?.connected) throw new Error(machine ? "the VM is not connected" : "its VM is gone");
      const scripts = await machine.scripts();
      // The socket fallback lives in the shared tmp dir under a recorded name: refuse
      // one someone else created (or a symlink) rather than put our sockets in it.
      await machine.prepareDirs([...new Set([layout.dir, layout.socketDir, layout.pulseDir, layout.runDir, layout.appsDir])]);
      await machine.rm(layout.ready);
      await machine.rm(layout.hostExit);
      // A fresh authority file: removed first, so the new one is created 0600.
      await machine.rm(layout.xauthority);
      await machine.writeFile(layout.xauthority, newXauthority(), 0o600);
      await machine.writeFile(layout.defaultPa, defaultPaContent(layout), 0o600);
      await machine.writeFile(layout.clientConf, CLIENT_CONF_CONTENT, 0o600);
      // A session left over from an earlier host (a failed start) must not collide.
      await machine.tmux.killServiceSession(session);
      await machine.tmux.newServiceSession({
        name: session,
        windowName: DESKTOP_HOST_WINDOW,
        cwd: layout.dir,
        env: {},
        bin: "/bin/sh",
        args: hostScriptArgs(layout, rt.record.size, rt.record.audio === true, scripts.host)
      });
    } catch (error) {
      await this.failStart(rt, `Could not start the desktop host: ${errorMessage(error)}`);
      return;
    }

    const settled = await waitFor(
      machine,
      layout.dir,
      async () => (await exists(machine, layout.ready)) || (await exists(machine, layout.hostExit)),
      this.readyTimeoutMs
    );
    if (generation !== rt.generation || !this.isCurrent(rt)) return;
    const display = settled && !(await exists(machine, layout.hostExit)) ? await readInt(machine, layout.ready) : null;
    if (display === null) {
      const reason = (await exists(machine, layout.hostExit))
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
    const tail = (await tailOf(this.hostOf(rt), this.layout(rt.record).hostLog, HOST_LOG_ERROR_TAIL_BYTES)).trim();
    rt.status = "error";
    rt.error = tail ? `${reason}\n${tail}` : reason;
    rt.record.display = null;
    void this.store.persist();
    this.emitUpdated(rt);
  }

  /**
   * Kill the service session and wait (bounded) for the host's trap to record
   * `host.exit` — by then it has TERMed and reaped its children — then SIGKILL
   * whatever is left of its process group (the pane pid leads it). A VM that
   * cannot be reached (now, or any more by the end) is marked for the next
   * connect, which kills what is left there.
   */
  private async killHost(rt: Runtime): Promise<void> {
    const machine = this.hostOf(rt);
    if (machine && !machine.connected) rt.reconcilePending = true;
    if (!machine?.connected) return;
    const session = desktopSessionName(rt.record.id);
    const layout = this.layout(rt.record);
    const windows = await machine.tmux.listServiceWindows(session).catch(() => []);
    const host = windows.find(
      (window) => window.name === DESKTOP_HOST_WINDOW
    );
    await machine.tmux.killServiceSession(session);
    if (host) {
      await waitFor(machine, layout.dir, () => exists(machine, layout.hostExit), this.stopGraceMs);
      await machine.signalGroup(host.panePid, "SIGKILL", hostOwner(layout));
    }
    if (!machine.connected) rt.reconcilePending = true;
  }

  /**
   * Take a desktop down (§5.4 "Stop desktop"): watchers and tracker off, every
   * live app's group SIGKILLed and its exit awaited (app-run.sh records it once
   * it has reaped the app), then the host, the audio encoder and the directory.
   * Apps end `exited`. A VM desktop whose VM cannot be reached (or is gone)
   * only has its state taken down here; the next connect reaps what is left.
   */
  private async teardown(rt: Runtime): Promise<void> {
    rt.generation += 1;
    this.unwatch(rt);
    this.stopTracker(rt);
    for (const timer of rt.killTimers.values()) clearTimeout(timer);
    rt.killTimers.clear();
    rt.pendingStops.clear();
    const layout = this.layout(rt.record);
    const candidate = this.hostOf(rt);
    const machine = candidate?.connected ? candidate : null;
    const live = rt.record.apps.filter((app) => app.status !== "exited");
    if (machine) {
      for (const app of live) {
        app.pgid = app.pgid ?? (await readInt(machine, appFile(layout, app.id, "pgid")));
        if (app.pgid !== null) await machine.signalGroup(app.pgid, "SIGKILL", appOwner(layout));
      }
      const signalled = live.filter((app) => app.pgid !== null);
      if (signalled.length > 0) {
        await waitFor(
          machine,
          layout.appsDir,
          async () => {
            for (const app of signalled) if (!(await exists(machine, appFile(layout, app.id, "exit")))) return false;
            return true;
          },
          this.stopGraceMs
        );
      }
    }
    const exitedAt = this.now().toISOString();
    for (const app of live) {
      // Read first, as `syncApps` does: never `exited` without its code.
      const exitCode = machine ? await readInt(machine, appFile(layout, app.id, "exit")) : null;
      app.status = "exited";
      app.exitCode = exitCode;
      app.exitedAt = exitedAt;
    }
    await this.killHost(rt);
    this.options.audio?.stopDesktop(rt.record.id);
    rt.record.display = null;
    rt.windows = [];
    rt.activeWindowId = null;
    rt.linkDown = false;
    rt.awaitingBox = false;
    rt.statusDetail = undefined;
    this.emit("windows", { desktopId: rt.record.id, windows: [], activeWindowId: null });
    if (!machine) return;
    try {
      await machine.rm(layout.dir, { recursive: true });
      if (layout.socketDir !== layout.dir) await machine.rm(layout.socketDir, { recursive: true });
    } catch (error) {
      // On this machine a directory that cannot go is the caller's error, as it always was.
      if (machine.boxId === null) throw error;
      this.logger.warn(`Desktop ${rt.record.id}: its directory in the VM could not be removed`, error);
    }
  }

  /**
   * The host exited on its own (Xvnc crash, host killed): §5.4 "Host exit".
   * boxes: not while the VM's reconnect reconcile is due — a box watch checks
   * again as soon as the link is back, and a `host.exit` its trap wrote while
   * the VM shut down is that reconcile's to report (the VM restarted).
   */
  private async onHostExit(rt: Runtime, generation: number): Promise<void> {
    await this.enqueue(rt, async () => {
      if (generation !== rt.generation || !this.isCurrent(rt) || rt.status !== "running" || rt.reconcilePending) return;
      rt.generation += 1;
      this.unwatch(rt);
      this.stopTracker(rt);
      const layout = this.layout(rt.record);
      const machine = this.hostOf(rt);
      const exitedAt = this.now().toISOString();
      for (const app of rt.record.apps) {
        if (app.status === "exited") continue;
        // Apps run in their own groups, out of the host trap's reach. A pgid
        // written but not yet synced is read from its file, as teardown does.
        app.pgid = app.pgid ?? (machine ? await readInt(machine, appFile(layout, app.id, "pgid")) : null);
        if (app.pgid !== null) await machine?.signalGroup(app.pgid, "SIGKILL", appOwner(layout));
        app.status = "exited";
        app.exitCode = null;
        app.exitedAt = exitedAt;
        const timer = rt.killTimers.get(app.id);
        if (timer) clearTimeout(timer);
        rt.killTimers.delete(app.id);
      }
      rt.pendingStops.clear();
      await machine?.tmux.killServiceSession(desktopSessionName(rt.record.id));
      this.options.audio?.stopDesktop(rt.record.id);
      const code = machine ? await readInt(machine, layout.hostExit) : null;
      const tail = (await tailOf(machine, layout.hostLog, HOST_LOG_ERROR_TAIL_BYTES)).trim();
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
    const machine = this.hostOf(rt);
    // (After shutdown nothing is watched: a late reconcile must not leave a watch open.)
    if (!machine || this.stopped) return;
    const layout = this.layout(rt.record);
    const generation = rt.generation;
    const checkHost = () => {
      if (this.stopped) return;
      void exists(machine, layout.hostExit).then((exited) => {
        if (exited && !this.stopped) void this.onHostExit(rt, generation);
      });
    };
    try {
      // (A box's watch reports `null` once it is in place, again after each reconnect.)
      rt.dirWatcher = machine.watch(
        layout.dir,
        (name) => {
          if (name === null || name === "host.exit") checkHost();
        },
        (error) => this.logger.warn(`Desktop ${rt.record.id}: dir watch failed`, error)
      );
      // App logs are appended to constantly; only the status files matter.
      rt.appsWatcher = machine.watch(
        layout.appsDir,
        (name) => {
          if (name === null || name.endsWith(".pgid") || name.endsWith(".exit")) this.syncApps(rt);
        },
        (error) => this.logger.warn(`Desktop ${rt.record.id}: apps watch failed`, error)
      );
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
          const machine = this.hostOf(rt);
          if (!machine) return;
          const layout = this.layout(rt.record);
          let changed = false;
          for (const app of rt.record.apps) {
            if (app.status === "exited") continue;
            if (app.pgid === null) {
              const pgid = await readInt(machine, appFile(layout, app.id, "pgid"));
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
            if (await exists(machine, exitPath)) {
              // Read before the app turns `exited`: a summary taken during
              // the read (`get()`, another update) would show it exited with
              // no code.
              const exitCode = await readInt(machine, exitPath);
              app.status = "exited";
              app.exitCode = exitCode;
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
    const machine = this.hostOf(rt);
    if (rt.record.display === null || !machine?.connected || this.stopped) return;
    const options: DesktopWindowTrackerOptions = machine.trackerOptions({
      display: rt.record.display,
      xauthorityPath: this.layout(rt.record).xauthority,
      appForPgid: (pgid) => rt.record.apps.find((app) => app.pgid === pgid)?.id ?? null
    });
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
    const machine = this.hostOf(rt);
    const owner = appOwner(this.layout(rt.record));
    if (app.pgid === null || !machine) return;
    void machine.signalGroup(app.pgid, force ? "SIGKILL" : "SIGTERM", owner);
    if (force || rt.killTimers.has(app.id)) return;
    const pgid = app.pgid;
    const timer = setTimeout(() => {
      rt.killTimers.delete(app.id);
      if (app.status !== "exited") void machine.signalGroup(pgid, "SIGKILL", owner);
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
    const machine = this.hostOf(rt);
    for (const appId of doomed) {
      for (const ext of ["log", "exit", "pgid"] as const) {
        void machine?.rm(appFile(layout, appId, ext)).catch(() => {});
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
    return desktopLayout(record.box?.dir ?? desktopRuntimeDir(this.options.baseDir, record.id), record.socketDir);
  }

  /** The machine a desktop runs on: this one, or its box's host (null once the box is gone, or without box support). */
  private hostOf(rt: Runtime): DesktopHost | null {
    if (rt.record.box === null) return this.local;
    return this.options.boxes?.host(rt.record.box.id) ?? null;
  }

  /** The desktop's machine, which must be reachable now (always, for this machine's desktops). */
  private reachable(rt: Runtime): DesktopHost {
    const machine = this.hostOf(rt);
    if (machine === null) throw new DesktopError(409, "DESKTOP_BOX_GONE", "The VM this desktop ran in is gone.");
    if (!machine.connected) throw new DesktopError(409, "DESKTOP_BOX_UNREACHABLE", BOX_UNREACHABLE);
    return machine;
  }

  /** boxes: a box's host for a new desktop, reachable now. */
  private boxHost(boxId: string): DesktopHost {
    const machine = this.options.boxes?.host(boxId) ?? null;
    if (machine === null) throw new DesktopError(409, DESKTOP_UNAVAILABLE_CODE, "This project's VM cannot run desktops.");
    if (!machine.connected) throw new DesktopError(409, "DESKTOP_BOX_UNREACHABLE", BOX_UNREACHABLE);
    return machine;
  }

  // ---------------------------------------------------------------------------
  // boxes: VM links
  // ---------------------------------------------------------------------------

  /** A box connected, dropped its link or changed state: bring its desktops in line, one pass at a time per box. */
  private boxChanged(boxId: string): void {
    if (this.stopped) return;
    // A drop is taken in now: the link may be back before the pass below runs, and what
    // ran there meanwhile must still be checked again.
    const machine = this.options.boxes?.host(boxId) ?? null;
    if (machine && !machine.connected) {
      this.boxesDropped.add(boxId);
      for (const rt of this.desktops.values()) if (rt.record.box?.id === boxId) this.linkLost(rt);
    }
    const run = (this.boxPasses.get(boxId) ?? Promise.resolve())
      .then(() => this.syncBox(boxId))
      .catch((error) => this.logger.error(`Desktops in box ${boxId}: could not follow its link`, error));
    this.boxPasses.set(boxId, run);
    void run.then(() => {
      if (this.boxPasses.get(boxId) === run) this.boxPasses.delete(boxId);
    });
  }

  /**
   * Act on a change of the box's link: gone → its desktops stop for good;
   * down → they show the outage; up → desktops not reconciled yet (since boot)
   * are, unclaimed sessions there are reaped, and the others get their window
   * tracker back (their watches come back on their own).
   */
  private async syncBox(boxId: string): Promise<void> {
    if (this.stopped) return;
    const runtimes = [...this.desktops.values()].filter((rt) => rt.record.box?.id === boxId);
    const machine = this.options.boxes?.host(boxId) ?? null;
    const state: BoxLinkState = machine === null ? "gone" : machine.connected ? "connected" : "disconnected";
    const previous = this.boxStates.get(boxId);
    this.boxStates.set(boxId, state);
    if (machine === null) {
      if (state === previous) return;
      const reason = this.options.boxes
        ? "The VM this desktop ran in is gone."
        : "This desktop runs in a VM, and VMs are not available on this daemon.";
      for (const rt of runtimes) {
        await this.enqueue(rt, () => this.boxGone(rt, reason)).catch((error) =>
          this.logger.warn(`Desktop ${rt.record.id}: could not stop after its VM went away`, error)
        );
      }
      return;
    }
    if (state === "disconnected") {
      for (const rt of runtimes) this.linkLost(rt);
      return;
    }
    // Everything that ran there while it was out of sight is checked again (the VM may have
    // restarted), and its unclaimed sessions reaped: after every drop, however short.
    const dropped = this.boxesDropped.delete(boxId);
    const unsure = runtimes.filter((rt) => rt.awaitingBox || rt.reconcilePending);
    if (state === previous && !dropped && unsure.length === 0) return;
    await this.reconcileOn(machine, unsure);
    for (const rt of runtimes) {
      // (One the reconcile left alone: an operation ran on it meanwhile.)
      if (!rt.awaitingBox && rt.linkDown) {
        await this.enqueue(rt, () => this.linkBack(rt)).catch((error) =>
          this.logger.warn(`Desktop ${rt.record.id}: could not resume after its VM reconnected`, error)
        );
      }
    }
  }

  /**
   * The VM's link dropped: the desktop keeps running there; its view and window
   * list wait for the link, and the next connect reconciles it.
   */
  private linkLost(rt: Runtime): void {
    if (rt.awaitingBox) return;
    rt.reconcilePending = true;
    if (rt.linkDown) return;
    rt.linkDown = true;
    // Its X connection went with the link; a fresh tracker comes back with it.
    this.stopTracker(rt);
    this.options.audio?.stopDesktop(rt.record.id);
    this.emitUpdated(rt);
  }

  /** The VM's link is back: the window tracker reconnects; app and host state catch up through the watches. */
  private async linkBack(rt: Runtime): Promise<void> {
    if (!this.isCurrent(rt) || !rt.linkDown) return;
    rt.linkDown = false;
    if (rt.status === "running") {
      await this.startTracker(rt);
      this.syncApps(rt);
    }
    this.emitUpdated(rt);
  }

  /** The desktop's VM is gone (destroyed, deleted with its project): it ends stopped, nothing left to reach. */
  private async boxGone(rt: Runtime, reason: string): Promise<void> {
    if (!this.isCurrent(rt)) return;
    rt.generation += 1;
    this.unwatch(rt);
    this.stopTracker(rt);
    for (const timer of rt.killTimers.values()) clearTimeout(timer);
    rt.killTimers.clear();
    rt.pendingStops.clear();
    const exitedAt = this.now().toISOString();
    for (const app of rt.record.apps) {
      if (app.status === "exited") continue;
      app.status = "exited";
      app.exitCode = null;
      app.exitedAt = exitedAt;
    }
    this.options.audio?.stopDesktop(rt.record.id);
    rt.status = "stopped";
    rt.error = reason;
    rt.statusDetail = undefined;
    rt.awaitingBox = false;
    rt.linkDown = false;
    rt.record.display = null;
    rt.windows = [];
    rt.activeWindowId = null;
    this.emit("windows", { desktopId: rt.record.id, windows: [], activeWindowId: null });
    void this.store.persist();
    this.emitUpdated(rt);
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
      ...(rt.statusDetail && rt.status === "starting" ? { statusDetail: rt.statusDetail } : {}),
      ...(record.box ? { box: { id: record.box.id, connected: this.hostOf(rt)?.connected ?? false } } : {}),
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
    syncAgain: false,
    awaitingBox: false,
    linkDown: false,
    reconcilePending: false,
    progressTimer: null
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

function unavailable(host: DesktopHostStatus, where = "on the server"): DesktopError {
  const missing = host.tools.filter((tool) => tool.required && tool.path === null).map((tool) => tool.name);
  const message =
    missing.length > 0
      ? `Desktops need ${missing.join(", ")} ${where}.`
      : `Desktops need tmux 3.2 or newer ${where}.`;
  return new DesktopError(409, DESKTOP_UNAVAILABLE_CODE, message, host.installHint);
}

/**
 * boxes: the VM's stack lacks something its installer would see to — a required
 * tool, or an optional one (sound, the compositor, a terminal, fonts: a hint is
 * then given). The installer runs once per VM; what it cannot add stays optional.
 */
function needsInstall(host: DesktopHostStatus): boolean {
  return !host.available || host.installHint !== null;
}

function clampThreads(threads: number, parallelism: number): number {
  return Math.min(Math.max(1, Math.round(threads)), Math.max(1, parallelism));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An app group's leader carries the desktop's X authority path (app-run.sh exports the app's env file). */
function appOwner(layout: DesktopLayout): DesktopGroupOwner {
  return { environ: `XAUTHORITY=${layout.xauthority}` };
}

/** The host group's leader is desktop-host.sh, run with the desktop dir as an argument. */
function hostOwner(layout: DesktopLayout): DesktopGroupOwner {
  return { argument: layout.dir };
}

/** The integer a small status file (`ready`, `.pgid`, `.exit`) holds, or null. */
function parseIntText(text: string | null): number | null {
  const trimmed = text?.trim() ?? "";
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/** The integer in a small status file, or null (also when it cannot be read: a box link that dropped). */
async function readInt(machine: DesktopHost, path: string): Promise<number | null> {
  return parseIntText(await machine.readText(path).catch(() => null));
}

/** Whether a file exists; false when it cannot be told (a box link that dropped). */
function exists(machine: DesktopHost, path: string): Promise<boolean> {
  return machine.exists(path).catch(() => false);
}

/** A file's tail ("" when it cannot be read, or without a machine). */
async function tailOf(machine: DesktopHost | null, path: string, bytes: number): Promise<string> {
  return machine ? machine.readTail(path, bytes).catch(() => "") : "";
}

/** Each app's exit status found in the apps dir. `strict`: a read that fails throws instead of reading as absent. */
async function readExitFiles(machine: DesktopHost, layout: DesktopLayout, strict = false): Promise<Map<string, number | null>> {
  const exits = new Map<string, number | null>();
  for (const name of await machine.readdir(layout.appsDir)) {
    if (!name.endsWith(".exit")) continue;
    const appId = name.slice(0, -".exit".length);
    const path = appFile(layout, appId, "exit");
    exits.set(appId, strict ? parseIntText(await machine.readText(path)) : await readInt(machine, path));
  }
  return exits;
}

/**
 * Resolve true once `done()` holds, re-checked on every watch event in `dir`
 * (one check at a time), or false after `timeoutMs` (or when `dir` cannot be
 * watched and the condition is not already true). No polling.
 */
function waitFor(machine: DesktopHost, dir: string, done: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let watcher: DesktopWatch | null = null;
    let settled = false;
    let checking = false;
    let again = false;
    const holds = () => done().catch(() => false);
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      resolve(value);
    };
    const check = () => {
      if (settled) return;
      if (checking) {
        again = true;
        return;
      }
      checking = true;
      void (async () => {
        do {
          again = false;
          if (await holds()) finish(true);
        } while (again && !settled);
        checking = false;
      })();
    };
    const timer = setTimeout(() => void holds().then(finish), timeoutMs);
    try {
      watcher = machine.watch(dir, check, () => void holds().then(finish));
    } catch {
      void holds().then(finish);
      return;
    }
    check();
  });
}

/** The record's project realpath (records from before `projectRealPath` stored the realpath as `projectPath`). */
function realProjectPath(record: DesktopRecord): string {
  return record.projectRealPath ?? record.projectPath;
}
