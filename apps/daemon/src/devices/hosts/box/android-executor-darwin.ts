/**
 * The {@link DeviceExecutor} of an Apple Silicon Mac running Android emulators (tailnet machines
 * spec §4.4 item 2): the Linux box executor (`android-executor.ts`) for programs, files and signals,
 * with what macOS lacks replaced — there is no `/proc`, no `setsid` and no `sha256sum` before
 * macOS 26:
 *
 * - `spawnDetached` starts the program through Node (`detached: true` makes it lead its own
 *   session, as `setsid` does), output appended to a 0600 log file; its pid is its process group.
 *   Node is on every Mac Android host (the probe requires 22 or newer) and on the tools' PATH.
 * - Process reads are `ps` (stat, CPU time, start time, process group), `ps -E` for a process's
 *   environment (macOS shows it for the account's own processes, which every one we check is), and
 *   `netstat` for listening sockets; free memory is `vm_stat`.
 * - Downloads run `curl` and check the pinned SHA-256 with `shasum -a 256`.
 *
 * Start times are seconds since the epoch (`ps -o lstart` in UTC) where Linux records clock ticks
 * after boot: both are only ever compared with what the same host recorded. CPU time is in
 * hundredths of a second, the Linux tick the golden snapshot's settle check divides by.
 * Like the Linux executor, reads reject when the Mac cannot be reached, so an unreachable machine
 * never reads as "the process is gone".
 */

import { posix } from "node:path";

import type { BoxConnection } from "../../../boxes/contracts.ts";
import type { ExecResult } from "../../android/exec.ts";
import type { DeviceExecutor } from "../../android/executor.ts";
import type { ProcStat, TcpRow } from "../../android/procs.ts";
import type { DownloadFn } from "../../toolchain/download.ts";
import { boxExecutor } from "./android-executor.ts";

const PROC_READ_MS = 20_000;
/** Ports the hub may take on the Mac (as in a Linux box). */
const HUB_PORT_MIN = 20_000;
const HUB_PORT_SPAN = 10_000;

/**
 * Node starts `$2 $3…` in its own session (`detached: true`: setsid) with output appended to `$1`
 * (0600), prints its pid once it runs and exits; the child outlives the exec, the Mac's link and
 * this daemon. Constant text (the JavaScript holds no single quote).
 */
export const DARWIN_DETACH_SCRIPT = `log=$1; shift
umask 077
mkdir -p "$(dirname "$log")"
if ! command -v node > /dev/null 2>&1; then echo "node is not on PATH" >&2; exit 127; fi
exec node -e '
const { spawn } = require("node:child_process");
const { closeSync, openSync } = require("node:fs");
const [log, command, ...args] = process.argv.slice(1);
const fd = openSync(log, "a", 0o600);
const child = spawn(command, args, { detached: true, stdio: ["ignore", fd, fd] });
child.once("error", (error) => { process.stderr.write(String(error.message) + "\\n"); process.exit(1); });
child.once("spawn", () => { closeSync(fd); process.stdout.write(String(child.pid) + "\\n"); child.unref(); process.exit(0); });
' -- "$log" "$@"
`;

/** `curl` a pinned file to `$2` unless it is already there with SHA-256 `$3` (`shasum`, else `sha256sum`). Constant text. */
export const DARWIN_DOWNLOAD_SCRIPT = `set -eu
url=$1; dest=$2; sha=$3
digest() { if command -v shasum > /dev/null 2>&1; then shasum -a 256 "$1" | awk '{ print $1 }'; else sha256sum "$1" | awk '{ print $1 }'; fi; }
mkdir -p "$(dirname "$dest")"
if [ -f "$dest" ] && [ "$(digest "$dest")" = "$sha" ]; then exit 0; fi
curl -fsSL --retry 3 -o "$dest.part" "$url"
if [ "$(digest "$dest.part")" != "$sha" ]; then rm -f "$dest.part"; echo "the download of $url did not match its pinned checksum" >&2; exit 1; fi
mv "$dest.part" "$dest"
`;

/**
 * The `ps` columns {@link parseDarwinPs} reads (UTC and the C locale make `lstart` parseable).
 * `ucomm` is the executable's own name (16 characters at most: `qemu-system-aarc`), whatever the
 * process made of its argv[0] (`comm` prints that).
 */
export const DARWIN_PS_COLUMNS = "pid=,ppid=,pgid=,stat=,time=,lstart=,ucomm=";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `ps -o time` (`[[dd-]hh:]mm:ss.cc`) in hundredths of a second; null when unreadable. */
export function parsePsCpuTime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  const total = Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds);
  return Number.isFinite(total) ? Math.round(total * 100) : null;
}

/** `ps -o lstart` in UTC (`Sun Nov 22 06:15:23 2026`) as seconds since the epoch; null when unreadable. */
export function parsePsStart(tokens: readonly string[]): number | null {
  const [, month, day, time, year] = tokens;
  const index = MONTHS.indexOf(month ?? "");
  const clock = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(time ?? "");
  if (index < 0 || !clock || !/^\d{1,2}$/.test(day ?? "") || !/^\d{4}$/.test(year ?? "")) return null;
  return Date.UTC(Number(year), index, Number(day), Number(clock[1]), Number(clock[2]), Number(clock[3])) / 1000;
}

/**
 * `ps -o {@link DARWIN_PS_COLUMNS}` lines → stats: `comm` is the executable's name (as `ucomm`
 * gives it; a path's last part otherwise), `state` the first letter of `stat`, `cpuTicks`
 * hundredths of a second, `startTicks` the start in epoch seconds. Unreadable lines are skipped.
 */
export function parseDarwinPs(text: string): ProcStat[] {
  const stats: ProcStat[] = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 11) continue;
    const [pid, ppid, pgrp] = fields.slice(0, 3).map(Number);
    const cpu = parsePsCpuTime(fields[4]!);
    const start = parsePsStart(fields.slice(5, 10));
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgrp) || cpu === null) continue;
    stats.push({
      pid: pid!,
      comm: posix.basename(fields.slice(10).join(" ")),
      state: fields[3]!.charAt(0),
      ppid: ppid!,
      pgrp: pgrp!,
      cpuTicks: cpu,
      ...(start !== null ? { startTicks: start } : {})
    });
  }
  return stats;
}

const ENV_ENTRY = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * `ps -E -ww -o command= -p <pid>`: the command line, then the environment, space-separated. Every
 * `NAME=` token starts a variable (a later one wins, so the environment beats the arguments); words
 * that follow without one belong to the value before (values with spaces). Null for empty output.
 */
export function parseDarwinEnviron(text: string): Map<string, string> | null {
  const line = text.trim();
  if (!line) return null;
  const env = new Map<string, string>();
  let key: string | null = null;
  for (const token of line.split(" ")) {
    if (ENV_ENTRY.test(token)) {
      const at = token.indexOf("=");
      key = token.slice(0, at);
      env.set(key, token.slice(at + 1));
    } else if (key !== null) {
      env.set(key, `${env.get(key)} ${token}`);
    }
  }
  return env;
}

const TCP_STATES: Record<string, string> = { LISTEN: "0A", ESTABLISHED: "01" };

/** `netstat -an -p tcp` → rows in the Linux `/proc/net/tcp` shape (`0A` LISTEN, `01` ESTABLISHED; the port after an address's last `.`). */
export function parseNetstatTcp(text: string): TcpRow[] {
  const rows: TcpRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6 || !fields[0]!.startsWith("tcp")) continue;
    const local = splitAddress(fields[3]!);
    const remote = splitAddress(fields[4]!);
    if (!local || !remote) continue;
    rows.push({ localAddress: local.address, localPort: local.port, remoteAddress: remote.address, remotePort: remote.port, state: TCP_STATES[fields[5]!] ?? fields[5]! });
  }
  return rows;
}

function splitAddress(text: string): { address: string; port: number } | null {
  const at = text.lastIndexOf(".");
  if (at <= 0) return null;
  const port = text.slice(at + 1);
  return { address: text.slice(0, at), port: port === "*" ? 0 : Number(port) };
}

/** Free memory from `vm_stat`: free + inactive + speculative pages (what can be had without swapping), in bytes; null when unreadable. */
export function parseVmStat(text: string): number | null {
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!(size > 0)) return null;
  let pages = 0;
  let found = false;
  for (const name of ["free", "inactive", "speculative"]) {
    const match = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.?$`, "m").exec(text);
    if (!match) continue;
    pages += Number(match[1]);
    found = true;
  }
  return found ? pages * size : null;
}

/** The executor of the Mac behind `link` (the connection object stays valid across reconnects). */
export function boxDarwinExecutor(link: () => BoxConnection): DeviceExecutor {
  const base = boxExecutor(link);

  /** A small read-only command whose failure to run (the Mac unreachable) rejects. */
  const read = async (command: string, args: string[], env?: Record<string, string>): Promise<ExecResult> => {
    const connection = link();
    if (!connection.connected) throw new Error(`the box ${connection.boxId} is not connected`);
    const result = await base.exec(command, args, { timeoutMs: PROC_READ_MS, ...(env ? { env } : {}) });
    if (result.exitCode === -1 || result.timedOut) throw new Error(`reading the Mac failed: ${result.stderr.trim() || "no answer"}`);
    return result;
  };

  /** `ps` in UTC and the C locale (its `lstart`), on the system PATH. */
  const ps = (args: string[]) => read("/bin/ps", args, { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });

  const tcpRows = async (): Promise<TcpRow[]> => parseNetstatTcp((await read("/usr/sbin/netstat", ["-an", "-p", "tcp"])).stdout);
  const listening = async (): Promise<Set<number>> => new Set((await tcpRows()).filter((row) => row.state === "0A").map((row) => row.localPort));

  const download: DownloadFn = async (file, dest, options) => {
    const result = await base.exec("/bin/sh", ["-c", DARWIN_DOWNLOAD_SCRIPT, "orq-download", file.url, dest, file.sha256], { signal: options.signal, timeoutMs: 30 * 60_000 });
    options.signal.throwIfAborted();
    if (result.exitCode !== 0) throw new Error(`Downloading ${file.url} on the Mac failed: ${result.stderr.trim().split("\n").at(-1) || `exit ${result.exitCode}`}`);
    if (file.size) options.onProgress?.(file.size, file.size);
  };

  return {
    get where() {
      return base.where;
    },
    exec: base.exec,

    async spawnDetached(command, args, options) {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(options.env)) if (value !== undefined) env[key] = value;
      const cwd = options.cwd ?? env.HOME;
      const result = await base.exec("/bin/sh", ["-c", DARWIN_DETACH_SCRIPT, "orq-detach", options.logPath, command, ...args], { env, ...(cwd ? { cwd } : {}), timeoutMs: PROC_READ_MS });
      const pid = Number(result.stdout.trim().split("\n").at(-1));
      if (result.exitCode !== 0 || !Number.isInteger(pid) || pid <= 1) throw new Error(`${posix.basename(command)} did not start on the Mac: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
      return pid;
    },

    readText: base.readText,
    writeText: base.writeText,
    exists: base.exists,
    mkdir: base.mkdir,
    remove: base.remove,
    rename: base.rename,
    list: base.list,

    async procStat(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return null;
      const result = await ps(["-o", DARWIN_PS_COLUMNS, "-p", String(pid)]);
      return result.exitCode === 0 ? (parseDarwinPs(result.stdout).find((stat) => stat.pid === pid) ?? null) : null;
    },

    async procStats() {
      const result = await ps(["-A", "-o", DARWIN_PS_COLUMNS]);
      return parseDarwinPs(result.stdout).filter((stat) => stat.state !== "Z");
    },

    async environ(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return null;
      const result = await ps(["-E", "-ww", "-o", "command=", "-p", String(pid)]);
      return result.exitCode === 0 ? parseDarwinEnviron(result.stdout) : null;
    },

    async cmdline(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return [];
      const result = await ps(["-ww", "-o", "command=", "-p", String(pid)]);
      return result.exitCode === 0 ? result.stdout.trim().split(/\s+/).filter(Boolean) : [];
    },

    signal: base.signal,

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
      throw new Error("no free port on the Mac");
    },

    async memAvailable() {
      return parseVmStat((await read("/usr/bin/vm_stat", [])).stdout);
    },

    download
  };
}
