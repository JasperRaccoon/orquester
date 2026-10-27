/**
 * The local expo-device-hub (devices spec §6.2, spikes §2): used only to stream and drive emulators
 * by serial (`--platform android --hide-boot-device`), on a reserved loopback port with
 * `--require-token`. It runs detached (output to `logs/hub.log`, the token redacted by
 * `hub-launcher.mjs`) so a daemon restart reattaches to it; its pid and port are in the host's
 * state file. Supervision polls (a reattached hub is not our child): a dead or unhealthy hub is
 * restarted with exponential backoff, reset after 60 s healthy.
 *
 * Capture sessions linger for minutes after the last viewer leaves (ffmpeg keeps re-encoding a
 * still screen) and the hub has no API to end one without killing the emulator, so the hub is
 * restarted ("recycled") once it has capture children and nobody watches: {@link RECYCLE_AFTER_LAST_VIEWER_MS}
 * after the proxy reports its last stream closed (`setViewers(0)`), or — without counts (a hub
 * reattached after a restart) — after {@link RECYCLE_IDLE_MS} with no loopback connection and no
 * viewer signal. One hub streams every device, so it waits until no device is watched.
 *
 * The token: with `--require-token` the hub CLI generates its own (it overwrites
 * `EXPO_DEVICE_HUB_SESSION_TOKEN`), and publishes it in `<EXPO_DEVICE_HUB_STATE_DIR>/server-<port>.json`
 * (0600), where this reads it. It is never in argv, logs, or anything returned to a client.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type DeviceExecutor, LOCAL_EXECUTOR } from "./executor.ts";
import { delay, descendantsOf, establishedOnPort, isProcessAlive, processMatches, waitForExit } from "./procs.ts";
import type { HubRecord } from "./state.ts";

export const HUB_LAUNCHER = fileURLToPath(new URL("./hub-launcher.mjs", import.meta.url));
export const HUB_READY_TIMEOUT_MS = 30_000;
export const HUB_TICK_MS = 5_000;
export const HUB_HEALTHY_RESET_MS = 60_000;
const HUB_BACKOFF_MAX_MS = 60_000;
export const RECYCLE_IDLE_MS = 60_000;
/** After the proxy reports the last viewer gone: a short grace for a reconnect (a reload, a tab switch). */
export const RECYCLE_AFTER_LAST_VIEWER_MS = 15_000;

export type HubStatus = "stopped" | "starting" | "running" | "failed";

export interface HubDeps {
  nodePath: string;
  /** The installed hub's `cli.mjs`, or null when it is not installed. */
  cli: () => string | null;
  env: NodeJS.ProcessEnv;
  hubStateDir: string;
  logPath: string;
  /** Marks this appdir's processes (`/proc/<pid>/environ`). */
  marker: { key: string; value: string };
  /** Record (or clear) the running hub in the host's state file. */
  persist(record: HubRecord | null): Promise<void>;
  onChange(): void;
  logger: Pick<Console, "info" | "warn" | "error">;
  /** Where the hub runs (absent: this machine). Paths above are its paths. */
  executor?: DeviceExecutor;
  /** The launcher script where it runs (absent: {@link HUB_LAUNCHER}; a box host uploads it). */
  launcher?: string;
  /**
   * How this daemon reaches the hub's port (absent: `http://127.0.0.1:<port>`); a box host forwards
   * it over the box link. `close` ends the forward when the hub goes.
   */
  endpoint?: (port: number) => Promise<HubEndpoint>;
}

/** The hub's port as this daemon reaches it. */
export interface HubEndpoint {
  origin: string;
  close(): Promise<void>;
}

/** The hub's arguments after the CLI path. */
export function hubArgs(port: number): string[] {
  return ["--platform", "android", "--host", "127.0.0.1", "--port", String(port), "--require-token", "--hide-sidebar", "--hide-boot-device"];
}

/** The restart delay after `failures` failures in a row. */
function hubBackoffMs(failures: number): number {
  return Math.min(HUB_BACKOFF_MAX_MS, 1_000 * 2 ** Math.max(0, failures - 1));
}

/** Whether a hub's capture sessions should be ended now (pure: the supervisor feeds it each tick). */
export function shouldRecycle(input: {
  captureChildren: number;
  connections: number;
  /** Streams the proxy has open now; null: no count reported since the hub started. */
  openViewers: number | null;
  /** When the proxy's count last dropped to 0. */
  lastViewerLeftAt: number | null;
  lastViewerAt: number | null;
  idleSince: number | null;
  now: number;
}): boolean {
  if (input.captureChildren === 0) return false;
  if (input.openViewers !== null) {
    if (input.openViewers > 0 || input.lastViewerLeftAt === null) return false;
    return input.now - input.lastViewerLeftAt >= RECYCLE_AFTER_LAST_VIEWER_MS;
  }
  if (input.connections > 0) return false;
  if (input.lastViewerAt !== null && input.now - input.lastViewerAt < RECYCLE_IDLE_MS) return false;
  return input.idleSince !== null && input.now - input.idleSince >= RECYCLE_IDLE_MS;
}

export class HubSupervisor {
  private record: HubRecord | null = null;
  private sessionToken: string | null = null;
  private statusValue: HubStatus = "stopped";
  private detailValue: string | null = null;
  private failures = 0;
  private healthySince: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private supervising = false;
  private busy: Promise<void> = Promise.resolve();
  private lastViewerAt: number | null = null;
  private idleSince: number | null = null;
  private openViewers: number | null = null;
  private lastViewerLeftAt: number | null = null;
  private readonly now: () => number;
  private readonly x: DeviceExecutor;
  private readonly launcher: string;
  /** The way to the hub's port (forwarded for a box). */
  private endpointValue: (HubEndpoint & { port: number }) | null = null;

  constructor(private readonly deps: HubDeps) {
    this.now = Date.now;
    this.x = deps.executor ?? LOCAL_EXECUTOR;
    this.launcher = deps.launcher ?? HUB_LAUNCHER;
  }

  status(): HubStatus {
    return this.statusValue;
  }

  detail(): string | null {
    return this.detailValue;
  }

  origin(): string | null {
    return this.statusValue === "running" && this.record && this.endpointValue?.port === this.record.port ? this.endpointValue.origin : null;
  }

  /** The recorded hub (pid, port), while one is known. */
  current(): HubRecord | null {
    return this.record;
  }

  token(): string | null {
    return this.statusValue === "running" ? this.sessionToken : null;
  }

  pid(): number | null {
    return this.record?.pid ?? null;
  }

  /** A viewer is watching a device of this hub (the service's viewer signal). */
  noteViewer(): void {
    this.lastViewerAt = this.now();
    this.idleSince = null;
  }

  /** The proxy's count of open streams across every device of this hub. */
  setViewers(count: number): void {
    const previous = this.openViewers;
    this.openViewers = Math.max(0, count);
    if (this.openViewers > 0) this.lastViewerAt = this.now();
    else if (previous === null || previous > 0) this.lastViewerLeftAt = this.now();
  }

  /** Reattach to a recorded hub that is still ours and healthy; false when it is not. */
  async attach(record: HubRecord): Promise<boolean> {
    if (!(await processMatches(record.pid, this.deps.marker, [this.launcher], this.x))) return false;
    const token = await this.readToken(record);
    if (!token || !(await this.healthy(record.port))) return false;
    this.record = record;
    this.sessionToken = token;
    this.setStatus("running", null);
    this.healthySince = this.now();
    this.supervise();
    this.deps.logger.info(`[devices] reattached to the device hub (pid ${record.pid}, port ${record.port})`);
    return true;
  }

  /** Start (or keep) the hub; resolves once it answers. */
  start(): Promise<void> {
    return this.serialize(async () => {
      if (this.statusValue === "running" && this.record && (await isProcessAlive(this.record.pid, this.x))) {
        this.supervise();
        return;
      }
      this.supervise();
      await this.spawnHub();
    });
  }

  /** Stop supervising and stop the hub. */
  stop(): Promise<void> {
    this.supervising = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.serialize(async () => {
      await this.kill();
      this.setStatus("stopped", null);
    });
  }

  /** Stop supervising; the hub keeps running (a restarted daemon reattaches). */
  detach(): void {
    this.supervising = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Forget the hub without stopping it (a box link dropped: it keeps running there and `attach`
   * finds it again); the way to its port closes.
   */
  async forget(): Promise<void> {
    this.detach();
    await this.serialize(async () => {
      this.record = null;
      this.sessionToken = null;
      await this.closeEndpoint();
      this.setStatus("stopped", null);
    });
  }

  private serialize(fn: () => Promise<void>): Promise<void> {
    const next = this.busy.then(fn, fn);
    this.busy = next.catch(() => undefined);
    return next;
  }

  private setStatus(status: HubStatus, detail: string | null): void {
    if (status === this.statusValue && detail === this.detailValue) return;
    this.statusValue = status;
    this.detailValue = detail;
    this.deps.onChange();
  }

  private supervise(): void {
    if (this.supervising) return;
    this.supervising = true;
    this.schedule(HUB_TICK_MS);
  }

  private schedule(ms: number): void {
    if (!this.supervising) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.serialize(() => this.tick()).catch(() => undefined), ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.supervising) return;
    try {
      if (this.statusValue === "running" && this.record) {
        const alive = await isProcessAlive(this.record.pid, this.x);
        if (!alive || !(await this.healthy(this.record.port))) {
          this.deps.logger.warn(`[devices] the device hub ${alive ? "stopped answering" : "exited"}; restarting it`);
          if (alive) await this.kill();
          this.record = null;
          await this.deps.persist(null).catch(() => undefined);
          this.fail("The device hub stopped; restarting it.");
        } else {
          if (this.healthySince !== null && this.now() - this.healthySince >= HUB_HEALTHY_RESET_MS) this.failures = 0;
          await this.maybeRecycle();
        }
      } else if (this.statusValue === "failed") {
        await this.spawnHub();
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
    this.schedule(this.statusValue === "failed" ? hubBackoffMs(this.failures) : HUB_TICK_MS);
  }

  private fail(message: string): void {
    this.failures += 1;
    this.healthySince = null;
    this.setStatus("failed", message);
  }

  private async maybeRecycle(): Promise<void> {
    const record = this.record!;
    const captureChildren = descendantsOf(record.pid, await this.x.procStats()).length;
    const connections = establishedOnPort(await this.x.tcpRows(), record.port);
    const now = this.now();
    if (captureChildren === 0 || connections > 0) this.idleSince = null;
    else this.idleSince ??= now;
    const input = { captureChildren, connections, openViewers: this.openViewers, lastViewerLeftAt: this.lastViewerLeftAt, lastViewerAt: this.lastViewerAt, idleSince: this.idleSince, now };
    if (!shouldRecycle(input)) return;
    const since = this.lastViewerLeftAt ?? this.idleSince ?? now;
    this.deps.logger.info(`[devices] recycling the device hub: ${captureChildren} capture process(es) with no viewer for ${Math.round((now - since) / 1000)} s`);
    this.idleSince = null;
    this.lastViewerLeftAt = null;
    await this.kill();
    await this.spawnHub(record.port);
  }

  private async spawnHub(preferredPort?: number): Promise<void> {
    const cli = this.deps.cli();
    if (!cli) {
      this.fail("expo-device-hub is not installed.");
      throw new Error("expo-device-hub is not installed.");
    }
    this.setStatus("starting", null);
    const port = preferredPort !== undefined && (await this.x.isPortFree(preferredPort)) ? preferredPort : await this.x.pickFreePort();
    let pid: number;
    try {
      pid = await this.x.spawnDetached(this.deps.nodePath, [this.launcher, cli, ...hubArgs(port)], { env: this.deps.env, logPath: this.deps.logPath });
    } catch {
      this.fail("The device hub did not start.");
      throw new Error("The device hub did not start.");
    }
    const record: HubRecord = { pid, port, startedAt: new Date(this.now()).toISOString() };
    await this.deps.persist(record);
    const deadline = Date.now() + HUB_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!(await isProcessAlive(pid, this.x))) break;
      const token = await this.readToken(record);
      if (token && (await this.healthy(port))) {
        this.record = record;
        this.sessionToken = token;
        this.healthySince = this.now();
        this.lastViewerAt = null;
        this.idleSince = null;
        this.openViewers = this.openViewers === null ? null : 0;
        this.lastViewerLeftAt = null;
        this.setStatus("running", null);
        this.deps.logger.info(`[devices] device hub started (pid ${pid}, port ${port})`);
        return;
      }
      await delay(250);
    }
    await this.x.signal(pid, pid, "SIGKILL").catch(() => false);
    await this.closeEndpoint();
    await this.deps.persist(null).catch(() => undefined);
    const message = `The device hub did not start (see ${this.deps.logPath}).`;
    this.fail(message);
    throw new Error(message);
  }

  private async kill(): Promise<void> {
    const record = this.record;
    this.record = null;
    this.sessionToken = null;
    if (!record) return;
    if (await processMatches(record.pid, this.deps.marker, [], this.x)) {
      await this.x.signal(record.pid, record.pid, "SIGTERM");
      if (!(await waitForExit(record.pid, 10_000, 200, this.x))) {
        await this.x.signal(record.pid, record.pid, "SIGKILL");
        await waitForExit(record.pid, 5_000, 200, this.x);
      }
    }
    await this.closeEndpoint();
    await this.deps.persist(null).catch(() => undefined);
  }

  private async readToken(record: HubRecord): Promise<string | null> {
    try {
      const text = await this.x.readText(join(this.deps.hubStateDir, `server-${record.port}.json`));
      if (text === null) return null;
      const state = JSON.parse(text) as { pid?: unknown; token?: unknown };
      return state.pid === record.pid && typeof state.token === "string" && state.token.length > 0 ? state.token : null;
    } catch {
      return null;
    }
  }

  /** The way to `port` (opened once per port; a box forwards it). */
  private async endpointFor(port: number): Promise<string> {
    if (this.endpointValue?.port === port) return this.endpointValue.origin;
    await this.closeEndpoint();
    const opened = this.deps.endpoint ? await this.deps.endpoint(port) : { origin: `http://127.0.0.1:${port}`, close: async () => undefined };
    this.endpointValue = { ...opened, port };
    return opened.origin;
  }

  private async closeEndpoint(): Promise<void> {
    const endpoint = this.endpointValue;
    this.endpointValue = null;
    await endpoint?.close().catch(() => undefined);
  }

  private async healthy(port: number): Promise<boolean> {
    try {
      const origin = await this.endpointFor(port);
      const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(2_000) });
      await response.arrayBuffer().catch(() => undefined);
      return response.ok;
    } catch {
      return false;
    }
  }
}
