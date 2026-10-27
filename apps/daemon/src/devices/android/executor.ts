/**
 * Where the Android tooling runs: this machine, or a box reached over `BoxConnection`
 * (`../hosts/box/android-executor.ts`). The emulator, golden-snapshot, hub, agent-device, SDK and
 * AVD modules take a {@link DeviceExecutor} (absent: {@link LOCAL_EXECUTOR}), so one code path
 * drives the local host and Linux box hosts alike.
 *
 * What it covers: programs run to completion (`exec`, never a shell), detached processes in their
 * own session with output appended to a log file (`spawnDetached`; the pid is the process group),
 * small text files (atomic writes), directory listings, and `/proc` reads for process liveness,
 * CPU time, listening sockets and free memory. Paths are the executor's own (box paths for a box).
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { downloadPinned, type DownloadFn } from "../toolchain/download.ts";
import { execFile, type ExecFn } from "./exec.ts";
import { listProcStats, readCmdline, readEnviron, readMemAvailable, readProcStat, signalGroup, type ProcStat, parseProcNetTcp, type TcpRow } from "./procs.ts";

export interface DetachedSpawn {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Output (stdout and stderr) is appended here (created 0600). */
  logPath: string;
}

export interface DeviceExecutor {
  /** `local`, or `box:<boxId>` (log lines). */
  readonly where: string;
  /** Run a program to completion (no shell). */
  exec: ExecFn;
  /** Start a program in its own session (survives this daemon and the box link); resolves its pid, which is also its process group. */
  spawnDetached(command: string, args: readonly string[], options: DetachedSpawn): Promise<number>;
  /** A small text file, or null when it cannot be read. */
  readText(path: string): Promise<string | null>;
  /** Write a file atomically (parent dirs made). */
  writeText(path: string, text: string, options?: { mode?: number }): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { mode?: number }): Promise<void>;
  /** `rm -rf`. */
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Entry names; empty when the dir is missing. */
  list(path: string): Promise<string[]>;
  procStat(pid: number): Promise<ProcStat | null>;
  /** Every live process's stat (one pass). */
  procStats(): Promise<ProcStat[]>;
  environ(pid: number): Promise<Map<string, string> | null>;
  cmdline(pid: number): Promise<string[]>;
  /** Signal a process group (falling back to the pid when it is > 1); false when nothing was signalled. */
  signal(pgid: number | null, pid: number, signal: NodeJS.Signals): Promise<boolean>;
  /** `/proc/net/tcp` and `tcp6` rows. */
  tcpRows(): Promise<TcpRow[]>;
  /** Whether nothing listens on `port` there now. */
  isPortFree(port: number): Promise<boolean>;
  /** A port nothing listens on there now (the hub's). */
  pickFreePort(): Promise<number>;
  /** `MemAvailable`, in bytes; null when unreadable. */
  memAvailable(): Promise<number | null>;
  /** A pinned, checksummed download to a path there. */
  download: DownloadFn;
}

/** Whether nothing listens on 127.0.0.1:`port` now (local). */
export function isLocalPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** A free port the OS picks (local). */
export function pickLocalFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/** This machine. */
export const LOCAL_EXECUTOR: DeviceExecutor = {
  where: "local",
  exec: execFile,
  async spawnDetached(command, args, options) {
    const log = openSync(options.logPath, "a", 0o600);
    try {
      const child = spawn(command, [...args], { env: options.env, cwd: options.cwd ?? options.env.HOME, detached: true, stdio: ["ignore", log, log] });
      if (child.pid === undefined) throw new Error(`${command} did not start`);
      child.on("error", () => undefined);
      child.unref();
      return child.pid;
    } finally {
      closeSync(log);
    }
  },
  async readText(path) {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
  async writeText(path, text, options = {}) {
    await mkdir(dirname(path), { recursive: true });
    const temp = join(dirname(path), `.${randomUUID().slice(0, 8)}.tmp`);
    try {
      await writeFile(temp, text, { mode: options.mode ?? 0o644 });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  },
  async exists(path) {
    return existsSync(path);
  },
  async mkdir(path, options = {}) {
    await mkdir(path, { recursive: true, ...(options.mode !== undefined ? { mode: options.mode } : {}) });
  },
  async remove(path) {
    await rm(path, { recursive: true, force: true });
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async list(path) {
    return readdir(path).catch(() => [] as string[]);
  },
  procStat: readProcStat,
  procStats: listProcStats,
  environ: readEnviron,
  cmdline: readCmdline,
  async signal(pgid, pid, signal) {
    // `pid` ≤ 1: the group only (never `kill(-1)` or `kill(0)`).
    return pid > 1 ? signalGroup(pgid, pid, signal) : pgid !== null && pgid > 1 && signalGroup(pgid, pgid, signal);
  },
  async tcpRows() {
    const rows: TcpRow[] = [];
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) rows.push(...parseProcNetTcp(await readFile(file, "utf8").catch(() => "")));
    return rows;
  },
  isPortFree: isLocalPortFree,
  pickFreePort: pickLocalFreePort,
  memAvailable: readMemAvailable,
  download: downloadPinned
};
