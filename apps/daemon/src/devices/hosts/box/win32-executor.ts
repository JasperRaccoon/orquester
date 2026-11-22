/**
 * The {@link DeviceExecutor} of a Windows machine paired for Android emulators: the shared Android
 * modules (emulator launch and stop, golden snapshots, hub, agent-device, AVDs) run there over the
 * box's `BoxConnection`, with what Linux reads from `/proc` and does with `setsid`/`kill` done the
 * Windows way:
 *
 * - **exec:** programs run directly (orq-agent resolves `PATHEXT`, so `adb` is `adb.exe` and
 *   `avdmanager` is `avdmanager.bat`); arguments, `cwd` and environment values that are drive paths
 *   get `\` separators ({@link toWindowsPath}).
 * - **Detached processes:** `Start-Process` from a PowerShell script ({@link WIN_DETACH_SCRIPT}); the
 *   process outlives the exec, orq-agent and the link (orq-agent lifts its job's kill-on-close once
 *   the script exited). A command line with `-gpu host` runs in the signed-in user's desktop
 *   session through orq-agent's desktop-session helper (`session: "desktop"`), only while the box
 *   advertises `desktop-session`; otherwise it fails with {@link NoDesktopSessionError}.
 * - **Processes:** CIM `Win32_Process` rows as {@link ProcStat}s: `comm` is the image name without
 *   `.exe`, `pgrp` the pid itself (Windows has no process groups; a launcher's children are found
 *   by parent pid), `cpuTicks` in 1/100 s, `startTicks` the creation time in 1/100 s. Reads within
 *   {@link PROCESS_CACHE_MS} share one query.
 * - **Ownership:** a process's environment cannot be read on Windows, so `environ` answers this
 *   host's marker (`ANDROID_AVD_HOME`, `env.ts` `appdirMarker`) for a process whose executable lives
 *   under the device root (Node, the SDK's emulator, adb) and nothing for any other; `cmdline` is
 *   the command line as one entry with `/` separators (how this host's paths are spelled).
 * - **Signals:** `taskkill /T /F` on the process tree (the graceful stop is `adb emu kill`).
 * - **Sockets, memory, downloads:** `Get-NetTCPConnection`, CIM free memory, a pinned download
 *   checked with `Get-FileHash` there.
 *
 * Reads reject when the box cannot be reached, so an unreachable box never reads as "the process is
 * gone".
 */

import { posix } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { BoxConnection } from "../../../boxes/contracts.ts";
import { androidLayoutAt, appdirMarker } from "../../android/env.ts";
import { type ExecFn, type ExecOptions, type ExecResult, splitLines } from "../../android/exec.ts";
import type { DeviceExecutor } from "../../android/executor.ts";
import type { ProcStat, TcpRow } from "../../android/procs.ts";
import type { DownloadFn } from "../../toolchain/download.ts";
import { boxExecutor } from "./android-executor.ts";
import {
  fromWindowsPath,
  NoDesktopSessionError,
  parsePowerShellJson,
  powershellCommand,
  toWindowsPath,
  WIN_DETACH_SCRIPT,
  WIN_DOWNLOAD_SCRIPT,
  WIN_MEMORY_SCRIPT,
  WIN_PROCESSES_SCRIPT,
  WIN_TCP_SCRIPT,
  windowsCommandLine,
  windowsLaunchSession,
  type WindowsSession
} from "./win32-remote.ts";

const OUTPUT_CAP = 1024 * 1024;
const KILL_GRACE_MS = 5_000;
/** A read (process list, sockets, memory): PowerShell starts in about a second on a small machine. */
const READ_MS = 60_000;
/** Process reads this close together share one query (a boot wait reads stat, then ownership). */
export const PROCESS_CACHE_MS = 750;
const HUB_PORT_MIN = 20_000;
const HUB_PORT_SPAN = 10_000;

export interface WindowsRunOptions extends ExecOptions {
  /** Run in the signed-in user's desktop session (the box must advertise `desktop-session`). */
  session?: WindowsSession;
}

export interface WindowsExecutorOptions {
  /** The device root (`/` separators), once the probe found it: processes under it are this host's. */
  root(): string | null;
}

/** A program run to completion on the box; resolves like the local runner (`-1`: it did not start). `errorCode`: the box's refusal code. */
export function runOnWindows(link: () => BoxConnection, command: string, args: readonly string[], options: WindowsRunOptions = {}): Promise<ExecResult & { errorCode?: string }> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ exitCode: -1, stdout: "", stderr: "aborted" });
      return;
    }
    let proc;
    try {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(options.env ?? {})) if (value !== undefined) env[key] = toWindowsPath(value);
      proc = link().exec({
        command: toWindowsPath(command),
        args: args.map(toWindowsPath),
        ...(options.env ? { env } : {}),
        ...(options.cwd ? { cwd: toWindowsPath(options.cwd) } : {}),
        ...(options.session === "desktop" ? { session: "desktop" as const } : {})
      });
    } catch (error) {
      resolve({ exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let pendingOut = "";
    let pendingErr = "";
    let timedOut = false;
    let settled = false;
    let open = 2;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let errorCode: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const terminate = () => {
      if (exit) return;
      proc.kill("SIGTERM");
      killTimer ??= setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const timer = options.timeoutMs !== undefined ? setTimeout(() => ((timedOut = true), terminate()), options.timeoutMs) : null;
    timer?.unref?.();
    const onAbort = () => terminate();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = () => {
      if (settled || open > 0 || !exit) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.onLine) for (const rest of [pendingOut, pendingErr]) if (rest.trim()) options.onLine(rest.trim());
      const code = exit.code ?? (exit.signal ? 128 + (exit.signal === "SIGKILL" ? 9 : 15) : -1);
      resolve({ exitCode: code, stdout, stderr, ...(timedOut ? { timedOut } : {}), ...(errorCode ? { errorCode } : {}) });
    };
    const collect = (stream: NodeJS.ReadableStream, which: "out" | "err") => {
      const decoder = new StringDecoder("utf8");
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        open -= 1;
        finish();
      };
      stream.once("end", end);
      stream.once("close", end);
      stream.once("error", end);
      stream.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
        if (which === "out") {
          stdout = (stdout + text).slice(-OUTPUT_CAP);
          if (options.onLine) pendingOut = splitLines(pendingOut + text, options.onLine);
        } else {
          stderr = (stderr + text).slice(-OUTPUT_CAP);
          if (options.onLine) pendingErr = splitLines(pendingErr + text, options.onLine);
        }
      });
    };
    collect(proc.stdout, "out");
    collect(proc.stderr, "err");
    proc.stdin.on("error", () => undefined);
    if (options.input !== undefined) proc.stdin.end(options.input);
    else proc.stdin.end();
    proc.once("error", (error: Error & { code?: string }) => {
      exit = { code: -1, signal: null };
      if (typeof error.code === "string") errorCode = error.code;
      stderr = stderr || error.message;
      open = 0;
      finish();
    });
    proc.once("exit", (code, signal) => {
      exit = { code, signal };
      finish();
    });
  });
}

/** A PowerShell script's JSON line; `env` carries its values (`ORQ_*`). Rejects when it did not run or printed none. */
export async function runPowerShell(
  link: () => BoxConnection,
  script: string,
  options: { env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; session?: WindowsSession } = {}
): Promise<Record<string, unknown>> {
  const { command, args } = powershellCommand(script);
  const result = await runOnWindows(link, command, args, { timeoutMs: options.timeoutMs ?? READ_MS, ...(options.env ? { env: options.env } : {}), ...(options.signal ? { signal: options.signal } : {}), ...(options.session ? { session: options.session } : {}) });
  if (result.errorCode === "NO_DESKTOP_SESSION") throw new NoDesktopSessionError(result.stderr || undefined);
  const value = parsePowerShellJson(result.stdout);
  if (!value) {
    const why = result.timedOut ? "it timed out" : result.exitCode === -1 ? result.stderr.trim() || "the box did not answer" : result.stderr.trim().split(/\r?\n/).filter((line) => !line.startsWith("#< CLIXML")).at(-1) || `exit ${result.exitCode}`;
    throw new Error(`PowerShell on the box failed: ${why}`);
  }
  return value;
}

/** One `WIN_PROCESSES_SCRIPT` row. */
interface ProcessRow {
  pid: number;
  ppid: number;
  name: string;
  startedMs: number;
  cpu100ns: number;
  path: string | null;
  commandLine: string | null;
}

function processRow(value: unknown): ProcessRow | null {
  if (!Array.isArray(value) || value.length < 6) return null;
  const [pid, ppid, name, startedMs, cpu100ns, path, commandLine] = value as unknown[];
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || typeof name !== "string") return null;
  return {
    pid,
    ppid: typeof ppid === "number" ? ppid : 0,
    name,
    startedMs: typeof startedMs === "number" ? startedMs : 0,
    cpu100ns: typeof cpu100ns === "number" ? cpu100ns : 0,
    path: typeof path === "string" && path ? path : null,
    commandLine: typeof commandLine === "string" && commandLine ? commandLine : null
  };
}

/** A process row as the shared modules read `/proc/<pid>/stat`. */
export function procStatOfRow(row: { pid: number; ppid: number; name: string; startedMs: number; cpu100ns: number }): ProcStat {
  return {
    pid: row.pid,
    comm: row.name.replace(/\.exe$/i, ""),
    state: "R",
    ppid: row.ppid,
    pgrp: row.pid,
    cpuTicks: Math.floor(row.cpu100ns / 100_000),
    ...(row.startedMs > 0 ? { startTicks: Math.floor(row.startedMs / 10) } : {})
  };
}

/** `Get-NetTCPConnection` states as `/proc/net/tcp` hex states. */
function tcpState(state: string): string {
  return state === "Listen" ? "0A" : state === "Established" ? "01" : "00";
}

export function windowsBoxExecutor(link: () => BoxConnection, options: WindowsExecutorOptions): DeviceExecutor {
  const files = boxExecutor(link);
  const cache = new Map<number, { at: number; row: ProcessRow | null }>();

  const connected = (): void => {
    const connection = link();
    if (!connection.connected) throw new Error(`the box ${connection.boxId} is not connected`);
  };

  const processes = async (pid?: number): Promise<ProcessRow[]> => {
    connected();
    const value = await runPowerShell(link, WIN_PROCESSES_SCRIPT, pid !== undefined ? { env: { ORQ_PID: String(pid) } } : {});
    return (Array.isArray(value.processes) ? value.processes : []).map(processRow).filter((row): row is ProcessRow => row !== null);
  };

  const processOf = async (pid: number): Promise<ProcessRow | null> => {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const hit = cache.get(pid);
    if (hit && Date.now() - hit.at < PROCESS_CACHE_MS) return hit.row;
    const row = (await processes(pid)).find((entry) => entry.pid === pid) ?? null;
    cache.set(pid, { at: Date.now(), row });
    return row;
  };

  const owned = (row: ProcessRow): boolean => {
    const root = options.root();
    if (!root || !row.path) return false;
    return fromWindowsPath(row.path).toLowerCase().startsWith(`${root.replace(/\/+$/, "").toLowerCase()}/`);
  };

  const tcpRows = async (): Promise<TcpRow[]> => {
    connected();
    const value = await runPowerShell(link, WIN_TCP_SCRIPT);
    const rows: TcpRow[] = [];
    for (const entry of Array.isArray(value.sockets) ? value.sockets : []) {
      if (!Array.isArray(entry) || entry.length < 5) continue;
      const [localAddress, localPort, remoteAddress, remotePort, state] = entry as unknown[];
      if (typeof localPort !== "number") continue;
      rows.push({ localAddress: String(localAddress), localPort, remoteAddress: String(remoteAddress), remotePort: typeof remotePort === "number" ? remotePort : 0, state: tcpState(String(state)) });
    }
    return rows;
  };
  const listening = async (): Promise<Set<number>> => new Set((await tcpRows()).filter((row) => row.state === "0A").map((row) => row.localPort));

  const kill = async (pid: number): Promise<boolean> => {
    connected();
    cache.delete(pid);
    const result = await runOnWindows(link, "taskkill.exe", ["/T", "/F", "/PID", String(pid)], { timeoutMs: READ_MS });
    if (result.exitCode === -1) throw new Error(`stopping process ${pid} failed: ${result.stderr.trim() || "the box did not answer"}`);
    return result.exitCode === 0;
  };

  const exec: ExecFn = (command, args, execOptions = {}) => runOnWindows(link, command, args, execOptions);

  const download: DownloadFn = async (file, dest, downloadOptions) => {
    const value = await runPowerShell(link, WIN_DOWNLOAD_SCRIPT, { env: { ORQ_URL: file.url, ORQ_SHA256: file.sha256, ORQ_DEST: dest }, timeoutMs: 30 * 60_000, signal: downloadOptions.signal });
    downloadOptions.signal.throwIfAborted();
    if (value.ok !== true) throw new Error(`Downloading ${file.url} on the box failed: ${typeof value.error === "string" ? value.error : "no reason given"}`);
    if (file.size) downloadOptions.onProgress?.(file.size, file.size);
  };

  return {
    get where() {
      return `box:${link().boxId}`;
    },
    exec,

    async spawnDetached(command, args, spawnOptions) {
      const session = windowsLaunchSession(args);
      if (session === "desktop" && !link().capabilities?.includes("desktop-session")) throw new NoDesktopSessionError();
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(spawnOptions.env)) if (value !== undefined) env[key] = value;
      // Start-Process needs the file itself: `…/emulator/emulator` is `emulator.exe`.
      const exe = posix.extname(command) ? command : `${command}.exe`;
      const value = await runPowerShell(link, WIN_DETACH_SCRIPT, {
        env: { ...env, ORQ_EXE: exe, ORQ_ARGS: windowsCommandLine(args.map(toWindowsPath)), ORQ_LOG: spawnOptions.logPath, ...(spawnOptions.cwd ? { ORQ_CWD: spawnOptions.cwd } : {}) },
        session
      });
      const pid = value.pid;
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) throw new Error(`${posix.basename(command)} did not start on the box`);
      return pid;
    },

    readText: files.readText,
    writeText: files.writeText,
    exists: files.exists,
    mkdir: files.mkdir,
    remove: files.remove,
    rename: files.rename,
    list: files.list,

    async procStat(pid) {
      const row = await processOf(pid);
      return row ? procStatOfRow(row) : null;
    },

    async procStats() {
      return (await processes()).map(procStatOfRow);
    },

    async environ(pid) {
      const row = await processOf(pid);
      if (!row) return null;
      const root = options.root();
      if (!root || !owned(row)) return new Map();
      const marker = appdirMarker(androidLayoutAt(root));
      return new Map([[marker.key, marker.value]]);
    },

    async cmdline(pid) {
      const row = await processOf(pid);
      return row?.commandLine ? [fromWindowsPath(row.commandLine)] : [];
    },

    async signal(pgid, pid) {
      if (pgid !== null && pgid > 1 && (await kill(pgid))) return true;
      return pid > 1 && pid !== pgid ? kill(pid) : false;
    },

    tcpRows,

    async isPortFree(port) {
      return !(await listening()).has(port);
    },

    async pickFreePort() {
      const taken = await listening();
      for (let tries = 0; tries < 200; tries++) {
        const port = HUB_PORT_MIN + Math.floor(Math.random() * HUB_PORT_SPAN);
        if (!taken.has(port)) return port;
      }
      throw new Error("no free port on the box");
    },

    async memAvailable() {
      connected();
      const value = await runPowerShell(link, WIN_MEMORY_SCRIPT);
      return typeof value.freeMemBytes === "number" ? value.freeMemBytes : null;
    },

    download
  };
}
