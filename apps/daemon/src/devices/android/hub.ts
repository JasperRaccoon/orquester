/**
 * The local expo-device-hub (devices spec §6.2, spikes §2): used only to stream and drive emulators
 * by serial (`--platform android --hide-boot-device`), on a reserved loopback port with
 * `--require-token`. It runs detached (output to `logs/hub.log`, the token redacted by
 * `hub-launcher.mjs`) so a daemon restart reattaches to it; its pid and port are in the host's
 * state file. Supervision polls (a reattached hub is not our child): a dead or unhealthy hub is
 * restarted with exponential backoff, reset after 60 s healthy.
 *
 * Capture sessions linger for minutes after the last viewer leaves (ffmpeg keeps re-encoding a
 * still screen) and the hub has no API to end one without killing the emulator, so a hub that has
 * capture children, no loopback connection and no viewer signal for {@link RECYCLE_IDLE_MS} is
 * restarted ("recycled").
 *
 * The token: with `--require-token` the hub CLI generates its own (it overwrites
 * `EXPO_DEVICE_HUB_SESSION_TOKEN`), and publishes it in `<EXPO_DEVICE_HUB_STATE_DIR>/server-<port>.json`
 * (0600), where this reads it. It is never in argv, logs, or anything returned to a client.
 */

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isPortFree, pickFreePort } from "./emulator.ts";
import { delay, descendantsOf, isProcessAlive, listProcStats, processMatches, readEstablishedOnPort, signalGroup, waitForExit } from "./procs.ts";
import type { HubRecord } from "./state.ts";

export const HUB_LAUNCHER = fileURLToPath(new URL("./hub-launcher.mjs", import.meta.url));
export const HUB_READY_TIMEOUT_MS = 30_000;
export const HUB_TICK_MS = 5_000;
export const HUB_HEALTHY_RESET_MS = 60_000;
export const HUB_BACKOFF_MAX_MS = 60_000;
export const RECYCLE_IDLE_MS = 60_000;

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
  /** Tests: time and polling. */
  now?: () => number;
}

/** The hub's arguments after the CLI path. */
export function hubArgs(port: number): string[] {
  return ["--platform", "android", "--host", "127.0.0.1", "--port", String(port), "--require-token", "--hide-sidebar", "--hide-boot-device"];
}

/** The restart delay after `failures` failures in a row. */
export function hubBackoffMs(failures: number): number {
  return Math.min(HUB_BACKOFF_MAX_MS, 1_000 * 2 ** Math.max(0, failures - 1));
}

/** Whether a hub's capture sessions should be ended now (pure: the supervisor feeds it each tick). */
export function shouldRecycle(input: { captureChildren: number; connections: number; lastViewerAt: number | null; idleSince: number | null; now: number }): boolean {
  if (input.captureChildren === 0 || input.connections > 0) return false;
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
  private readonly now: () => number;

  constructor(private readonly deps: HubDeps) {
    this.now = deps.now ?? Date.now;
  }

  status(): HubStatus {
    return this.statusValue;
  }

  detail(): string | null {
    return this.detailValue;
  }

  origin(): string | null {
    return this.statusValue === "running" && this.record ? `http://127.0.0.1:${this.record.port}` : null;
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

  /** Reattach to a recorded hub that is still ours and healthy; false when it is not. */
  async attach(record: HubRecord): Promise<boolean> {
    if (!(await processMatches(record.pid, this.deps.marker, [HUB_LAUNCHER]))) return false;
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
      if (this.statusValue === "running" && this.record && (await isProcessAlive(this.record.pid))) {
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
    let next = HUB_TICK_MS;
    try {
      if (this.statusValue === "running" && this.record) {
        const alive = await isProcessAlive(this.record.pid);
        if (!alive || !(await this.healthy(this.record.port))) {
          this.deps.logger.warn(`[devices] the device hub ${alive ? "stopped answering" : "exited"}; restarting it`);
          if (alive) await this.kill();
          this.record = null;
          await this.deps.persist(null).catch(() => undefined);
          next = this.fail("The device hub stopped; restarting it.");
        } else {
          if (this.healthySince !== null && this.now() - this.healthySince >= HUB_HEALTHY_RESET_MS) this.failures = 0;
          await this.maybeRecycle();
        }
      } else if (this.statusValue === "failed") {
        await this.spawnHub();
      }
    } catch (error) {
      next = this.fail(error instanceof Error ? error.message : String(error));
    }
    if (this.statusValue === "failed") next = hubBackoffMs(this.failures);
    this.schedule(next);
  }

  private fail(message: string): number {
    this.failures += 1;
    this.healthySince = null;
    this.setStatus("failed", message);
    return hubBackoffMs(this.failures);
  }

  private async maybeRecycle(): Promise<void> {
    const record = this.record!;
    const captureChildren = descendantsOf(record.pid, await listProcStats()).length;
    const connections = await readEstablishedOnPort(record.port);
    const now = this.now();
    if (captureChildren === 0 || connections > 0) this.idleSince = null;
    else this.idleSince ??= now;
    if (!shouldRecycle({ captureChildren, connections, lastViewerAt: this.lastViewerAt, idleSince: this.idleSince, now })) return;
    this.deps.logger.info(`[devices] recycling the device hub: ${captureChildren} capture process(es) with no viewer for ${Math.round((now - this.idleSince!) / 1000)} s`);
    this.idleSince = null;
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
    const port = preferredPort !== undefined && (await isPortFree(preferredPort)) ? preferredPort : await pickFreePort();
    const log = openSync(this.deps.logPath, "a", 0o600);
    let pid: number | undefined;
    try {
      const child = spawn(this.deps.nodePath, [HUB_LAUNCHER, cli, ...hubArgs(port)], { env: this.deps.env, cwd: this.deps.env.HOME, detached: true, stdio: ["ignore", log, log] });
      child.on("error", () => undefined);
      child.unref();
      pid = child.pid;
    } finally {
      closeSync(log);
    }
    if (pid === undefined) {
      this.fail("The device hub did not start.");
      throw new Error("The device hub did not start.");
    }
    const record: HubRecord = { pid, port, startedAt: new Date(this.now()).toISOString() };
    await this.deps.persist(record);
    const deadline = Date.now() + HUB_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!(await isProcessAlive(pid))) break;
      const token = await this.readToken(record);
      if (token && (await this.healthy(port))) {
        this.record = record;
        this.sessionToken = token;
        this.healthySince = this.now();
        this.lastViewerAt = null;
        this.idleSince = null;
        this.setStatus("running", null);
        this.deps.logger.info(`[devices] device hub started (pid ${pid}, port ${port})`);
        return;
      }
      await delay(250);
    }
    signalGroup(pid, pid, "SIGKILL");
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
    if (await processMatches(record.pid, this.deps.marker)) {
      signalGroup(record.pid, record.pid, "SIGTERM");
      if (!(await waitForExit(record.pid, 10_000))) {
        signalGroup(record.pid, record.pid, "SIGKILL");
        await waitForExit(record.pid, 5_000);
      }
    }
    await this.deps.persist(null).catch(() => undefined);
  }

  private async readToken(record: HubRecord): Promise<string | null> {
    try {
      const state = JSON.parse(await readFile(join(this.deps.hubStateDir, `server-${record.port}.json`), "utf8")) as { pid?: unknown; token?: unknown };
      return state.pid === record.pid && typeof state.token === "string" && state.token.length > 0 ? state.token : null;
    } catch {
      return null;
    }
  }

  private async healthy(port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2_000) });
      await response.arrayBuffer().catch(() => undefined);
      return response.ok;
    } catch {
      return false;
    }
  }
}
