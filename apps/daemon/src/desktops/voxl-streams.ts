import type { Duplex } from "node:stream";
import type { DesktopVoxlStream } from "@orquester/api";
import { type DesktopHost, type DesktopWatch, waitFor } from "./desktop-host.ts";
import type { DesktopLayout } from "./host-env.ts";
import {
  VOXL_WINDOW,
  newVoxlPassword,
  parseVoxlEnvFile,
  voxlArgs,
  voxlBindFailed,
  voxlEnvFileContent,
  voxlFailureLine,
  voxlFiles,
  voxlHealthz,
  voxlListening
} from "./voxl.ts";

// The voxl process of each running `voxl` desktop (spec 2026-11-10 §5, R4.3/R4.9).
//
// voxl costs CPU whenever the screen changes, viewers or not, so it runs only while someone
// watches: the first relay viewer starts it (as the `voxl` window of the desktop's tmux service
// session — torn down with the desktop), the last one leaving stops it after a grace period (a
// reconnect within it is instant). Readiness is voxl's listen line in its log (watched, never
// polled) confirmed by one `/healthz`; its exit lands in `voxl.exit`, also watched. A voxl that
// fails to start or exits on its own never touches the desktop: its stream turns `unavailable`
// (viewers use RFB) with the reason, and the next viewer may try again.
//
// The summary's state: `ready` = viewers may connect (whether or not voxl runs right now),
// `unavailable` = use RFB. After a daemon restart a voxl still running is adopted (port and
// password are in its env file), else whatever is left of it is stopped.
//
// Keymap: voxl reads the X keymap once, at its start, and binds keysyms it lacks onto spare keycodes
// from its own list; the automation engine re-reads the keymap on every MappingNotify and prefers
// spare keycodes outside voxl's list (engine.ts), so neither overwrites the other's bindings. One
// voxl per desktop at most (a second would wipe the first one's scratch bindings).

/** What the streams need of a running desktop. */
export interface VoxlDesktop {
  id: string;
  machine: DesktopHost;
  layout: DesktopLayout;
  display: number;
  /** Its tmux service session. */
  session: string;
}

/** One viewer's hold on a running voxl: how the relay reaches it. `release()` once the viewer left. */
export interface VoxlLease {
  port: number;
  password: string;
  connect(): Promise<Duplex>;
  release(): void;
}

/** Why a viewer cannot have voxl (the relay closes with it). */
export class VoxlUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoxlUnavailableError";
  }
}

interface VoxlProcess {
  port: number;
  password: string;
  exitWatch: DesktopWatch | null;
  /** Its stop was asked for: its exit is no news. */
  stopping: boolean;
}

interface Entry {
  desktop: VoxlDesktop;
  state: DesktopVoxlStream;
  binary: string | null;
  proc: VoxlProcess | null;
  starting: Promise<VoxlProcess> | null;
  viewers: number;
  idleTimer: NodeJS.Timeout | null;
  /** Bumped when the desktop goes or switches away: work of an older attach is dropped. */
  epoch: number;
}

export interface DesktopVoxlStreamsOptions {
  /** A desktop's stream state changed (the manager emits `updated`). */
  changed(desktopId: string): void;
  logger: Pick<Console, "warn">;
  /** How long voxl has to print its listen line (default 15 s). */
  readyTimeoutMs?: number;
  /** SIGTERM → SIGKILL grace when stopping it (default 5 s). */
  stopGraceMs?: number;
  /** How long voxl keeps running after its last viewer left (default 30 s). */
  idleStopMs?: number;
}

const READY_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 5_000;
const IDLE_STOP_MS = 30_000;
const HEALTHZ_TIMEOUT_MS = 5_000;
const LOG_TAIL_BYTES = 16 * 1024;

export class DesktopVoxlStreams {
  private readonly entries = new Map<string, Entry>();
  private readonly readyTimeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly idleStopMs: number;

  constructor(private readonly options: DesktopVoxlStreamsOptions) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS;
    this.idleStopMs = options.idleStopMs ?? IDLE_STOP_MS;
  }

  /** The stream state of a desktop the streams follow, else undefined. */
  state(desktopId: string): DesktopVoxlStream | undefined {
    const entry = this.entries.get(desktopId);
    return entry ? { ...entry.state } : undefined;
  }

  /**
   * A desktop now runs with `video: voxl`: find its machine's voxl (state `ready`, or `unavailable`
   * with the reason). `adopt` (daemon restart): a voxl still running from before is taken over,
   * anything else left of one is stopped. Never throws.
   */
  async attach(desktop: VoxlDesktop, options: { adopt?: boolean } = {}): Promise<void> {
    this.dropEntry(desktop.id);
    const entry: Entry = {
      desktop,
      state: { state: "starting" },
      binary: null,
      proc: null,
      starting: null,
      viewers: 0,
      idleTimer: null,
      epoch: 0
    };
    this.entries.set(desktop.id, entry);
    const epoch = entry.epoch;
    this.options.changed(desktop.id);
    let reason: string | null = null;
    try {
      const status = await desktop.machine.voxl();
      if (status.available && status.path) entry.binary = status.path;
      else reason = status.reason ?? "voxl is not available.";
    } catch (error) {
      reason = `voxl could not be checked: ${errorMessage(error)}`;
    }
    if (!this.current(entry, epoch)) return;
    if (options.adopt) await this.adoptOrClean(entry).catch((error) => this.options.logger.warn(`Desktop ${desktop.id}: voxl reattach failed`, error));
    if (!this.current(entry, epoch)) return;
    entry.state = entry.binary !== null || entry.proc !== null ? { state: "ready" } : { state: "unavailable", reason: reason ?? "voxl is not available." };
    this.options.changed(desktop.id);
  }

  /**
   * The desktop stops streaming with voxl (switched to RFB, stopped, gone). `kill`: stop a running
   * voxl too (a switch); a teardown leaves that to the session's end. Its viewers' relays close.
   */
  async detach(desktopId: string, options: { kill?: boolean } = {}): Promise<void> {
    const entry = this.entries.get(desktopId);
    if (!entry) return;
    this.dropEntry(desktopId);
    if (!options.kill) return;
    const proc = entry.proc ?? (await entry.starting?.catch(() => null)) ?? null;
    if (proc || entry.starting) await this.stopProcess(entry.desktop, proc);
  }

  /**
   * A viewer wants voxl: the running one, or a new one started for it (concurrent viewers share
   * one start). Throws {@link VoxlUnavailableError} when voxl cannot run (the state says why).
   */
  async acquire(desktopId: string): Promise<VoxlLease> {
    const entry = this.entries.get(desktopId);
    if (!entry) throw new VoxlUnavailableError("This desktop does not stream with voxl.");
    if (entry.binary === null && entry.proc === null) {
      throw new VoxlUnavailableError(entry.state.reason ?? (entry.state.state === "starting" ? "voxl is still being checked." : "voxl is not available."));
    }
    const epoch = entry.epoch;
    entry.viewers += 1;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    let proc: VoxlProcess;
    try {
      proc = entry.proc ?? (await (entry.starting ??= this.startProcess(entry, epoch)));
    } catch (error) {
      this.leave(entry, epoch);
      throw error instanceof VoxlUnavailableError ? error : new VoxlUnavailableError(errorMessage(error));
    }
    if (!this.current(entry, epoch)) {
      throw new VoxlUnavailableError("This desktop no longer streams with voxl.");
    }
    let released = false;
    const { machine } = entry.desktop;
    return {
      port: proc.port,
      password: proc.password,
      connect: () => machine.connectTcp(proc.port),
      release: () => {
        if (released) return;
        released = true;
        this.leave(entry, epoch);
      }
    };
  }

  /** Daemon shutdown: timers and watches only; a running voxl keeps running (the next boot adopts or stops it). */
  shutdown(): void {
    for (const id of [...this.entries.keys()]) this.dropEntry(id);
  }

  // ---------------------------------------------------------------------------

  private current(entry: Entry, epoch: number): boolean {
    return this.entries.get(entry.desktop.id) === entry && entry.epoch === epoch;
  }

  private dropEntry(desktopId: string): void {
    const entry = this.entries.get(desktopId);
    if (!entry) return;
    entry.epoch += 1;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    entry.proc?.exitWatch?.close();
    if (entry.proc) entry.proc.exitWatch = null;
    this.entries.delete(desktopId);
  }

  /** A viewer left: the last one arms the idle stop. */
  private leave(entry: Entry, epoch: number): void {
    if (!this.current(entry, epoch)) return;
    entry.viewers = Math.max(0, entry.viewers - 1);
    if (entry.viewers > 0 || entry.idleTimer) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (!this.current(entry, epoch) || entry.viewers > 0 || !entry.proc) return;
      const proc = entry.proc;
      proc.stopping = true;
      proc.exitWatch?.close();
      proc.exitWatch = null;
      entry.proc = null;
      void this.stopProcess(entry.desktop, proc).catch((error) => this.options.logger.warn(`Desktop ${entry.desktop.id}: stopping voxl failed`, error));
    }, this.idleStopMs);
    entry.idleTimer.unref?.();
  }

  /** Start voxl for `entry` (a taken port is retried once with another); the state follows the outcome. */
  private async startProcess(entry: Entry, epoch: number): Promise<VoxlProcess> {
    const { desktop } = entry;
    try {
      const proc = await this.launch(entry, epoch);
      if (!this.current(entry, epoch)) {
        await this.stopProcess(desktop, proc);
        throw new VoxlUnavailableError("This desktop no longer streams with voxl.");
      }
      entry.proc = proc;
      this.watchExit(entry, epoch, proc);
      if (entry.state.state !== "ready") {
        entry.state = { state: "ready" };
        this.options.changed(desktop.id);
      }
      if (entry.viewers === 0) this.leave(entry, epoch);
      return proc;
    } catch (error) {
      const reason = error instanceof VoxlUnavailableError ? error.message : `voxl could not start: ${errorMessage(error)}`;
      if (this.current(entry, epoch)) {
        this.options.logger.warn(`Desktop ${desktop.id}: ${reason}`);
        entry.state = { state: "unavailable", reason };
        this.options.changed(desktop.id);
      }
      throw new VoxlUnavailableError(reason);
    } finally {
      if (this.current(entry, epoch)) entry.starting = null;
    }
  }

  private async launch(entry: Entry, epoch: number): Promise<VoxlProcess> {
    const { desktop } = entry;
    const { machine, layout } = desktop;
    const files = voxlFiles(layout.dir);
    const scripts = await machine.scripts();
    // At most one voxl per display: anything left of an earlier one goes first.
    await this.stopProcess(desktop, null);
    for (let attempt = 1; ; attempt++) {
      if (!this.current(entry, epoch)) throw new VoxlUnavailableError("This desktop no longer streams with voxl.");
      const port = await machine.allocatePort();
      const password = newVoxlPassword();
      await machine.rm(files.exit);
      await machine.rm(files.log);
      // Removed first so the new file is created 0600.
      await machine.rm(files.env);
      await machine.writeFile(
        files.env,
        voxlEnvFileContent({ display: desktop.display, xauthority: layout.xauthority, runDir: layout.runDir, password, port }),
        0o600
      );
      await machine.tmux.newServiceWindow({
        session: desktop.session,
        name: VOXL_WINDOW,
        cwd: layout.dir,
        env: {},
        bin: "/bin/sh",
        args: [scripts.voxl, layout.dir, entry.binary!, ...voxlArgs(port)]
      });
      const tail = () => machine.readTail(files.log, LOG_TAIL_BYTES).catch(() => "");
      const settled = await waitFor(
        machine,
        layout.dir,
        async () => voxlListening(await tail(), port) || (await machine.exists(files.exit).catch(() => false)),
        this.readyTimeoutMs
      );
      const exited = await machine.exists(files.exit).catch(() => false);
      if (exited) {
        const log = await tail();
        if (voxlBindFailed(log) && attempt === 1) continue;
        const code = parseCode(await machine.readText(files.exit).catch(() => null));
        const line = voxlFailureLine(log);
        throw new VoxlUnavailableError(`voxl exited while starting${code === null ? "" : ` (${code})`}${line ? `: ${line}` : "."}`);
      }
      if (!settled) {
        await this.stopProcess(desktop, null);
        throw new VoxlUnavailableError(`voxl did not start within ${Math.round(this.readyTimeoutMs / 1000)} s.`);
      }
      if (!(await this.healthy(machine, port))) {
        await this.stopProcess(desktop, null);
        throw new VoxlUnavailableError("voxl started but did not answer its health check.");
      }
      return { port, password, exitWatch: null, stopping: false };
    }
  }

  private async healthy(machine: DesktopHost, port: number): Promise<boolean> {
    try {
      return await voxlHealthz(await machine.connectTcp(port), port, HEALTHZ_TIMEOUT_MS);
    } catch {
      return false;
    }
  }

  /** Follow `voxl.exit`: an exit nobody asked for makes the stream unavailable (viewers use RFB). */
  private watchExit(entry: Entry, epoch: number, proc: VoxlProcess): void {
    const { machine, layout } = entry.desktop;
    const files = voxlFiles(layout.dir);
    let handled = false;
    const check = () => {
      if (handled || proc.stopping) return;
      void machine
        .exists(files.exit)
        .then(async (exited) => {
          if (!exited || handled || proc.stopping || !this.current(entry, epoch) || entry.proc !== proc) return;
          handled = true;
          proc.exitWatch?.close();
          proc.exitWatch = null;
          entry.proc = null;
          const code = parseCode(await machine.readText(files.exit).catch(() => null));
          const line = voxlFailureLine(await machine.readTail(files.log, LOG_TAIL_BYTES).catch(() => ""));
          if (!this.current(entry, epoch)) return;
          entry.state = { state: "unavailable", reason: `voxl exited${code === null ? "" : ` (${code})`}${line ? `: ${line}` : "."}` };
          this.options.changed(entry.desktop.id);
        })
        .catch(() => {});
    };
    try {
      proc.exitWatch = machine.watch(
        layout.dir,
        (name) => {
          if (name === null || name === "voxl.exit") check();
        },
        (error) => this.options.logger.warn(`Desktop ${entry.desktop.id}: voxl exit watch failed`, error)
      );
    } catch (error) {
      this.options.logger.warn(`Desktop ${entry.desktop.id}: could not watch voxl's exit`, error);
    }
    check();
  }

  /** After a daemon restart: take over a voxl that still answers, else stop what is left of one. */
  private async adoptOrClean(entry: Entry): Promise<void> {
    const { machine, layout, session } = entry.desktop;
    const files = voxlFiles(layout.dir);
    const windows = await machine.tmux.listServiceWindows(session);
    if (!windows.some((window) => window.name === VOXL_WINDOW)) return;
    const saved = parseVoxlEnvFile(await machine.readText(files.env));
    const alive = saved !== null && !(await machine.exists(files.exit)) && (await this.healthy(machine, saved.port));
    if (!alive || saved === null) {
      await this.stopProcess(entry.desktop, null);
      return;
    }
    const proc: VoxlProcess = { port: saved.port, password: saved.password, exitWatch: null, stopping: false };
    entry.proc = proc;
    this.watchExit(entry, entry.epoch, proc);
    // No viewer survives a daemon restart: it stops unless one comes back within the grace period.
    this.leave(entry, entry.epoch);
  }

  /**
   * Stop the desktop's voxl window(s): SIGTERM to the group (voxl restores the keymap and exits),
   * SIGKILL after the grace period. A desktop without one is left alone.
   */
  private async stopProcess(desktop: VoxlDesktop, proc: VoxlProcess | null): Promise<void> {
    if (proc) {
      proc.stopping = true;
      proc.exitWatch?.close();
      proc.exitWatch = null;
    }
    const { machine, layout, session } = desktop;
    if (!machine.connected) return;
    const windows = (await machine.tmux.listServiceWindows(session).catch(() => [])).filter((window) => window.name === VOXL_WINDOW);
    if (windows.length === 0) return;
    const files = voxlFiles(layout.dir);
    const owner = { argument: layout.dir };
    for (const window of windows) await machine.signalGroup(window.panePid, "SIGTERM", owner);
    await waitFor(machine, layout.dir, () => machine.exists(files.exit), this.stopGraceMs);
    for (const window of windows) await machine.signalGroup(window.panePid, "SIGKILL", owner);
  }
}

function parseCode(text: string | null): number | null {
  const trimmed = text?.trim() ?? "";
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
