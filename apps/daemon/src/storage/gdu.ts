import { execFile, spawn } from "node:child_process";
import { accessSync, constants, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { appBinDir } from "@orquester/config";

import { resolveTool } from "../desktops/host-status.ts";
import { sessionPath } from "../tmux.ts";

/**
 * The pinned gdu binary (deploy/install-gdu.sh) and one export run of it.
 *
 * A run is `setpriv --pdeathsig KILL -- nice -n 19 ionice -c 3 gdu -n -x -p -o
 * <file> <dir>` in its own process group: idle I/O class and lowest CPU priority
 * so chats and terminals stay responsive, at most half the cores. The parent-death
 * signal (kept across the nice/ionice execs) kills gdu when the daemon dies,
 * however it dies; the pidfile lets the next start kill one that outlived it
 * anyway (no setpriv on the host). gdu prints no progress while it exports.
 * Its config file is pinned to /dev/null so a `~/.gdu.yaml` in the
 * service user's home cannot change what is scanned. `-i` replaces gdu's
 * default ignore list, so the kernel trees are always passed with the rest.
 */

/** install-gdu.sh's link, found even where /usr/local/bin is not on the sessions' PATH. */
const DEPLOY_LINK = "/usr/local/bin/gdu";
/** Where nice / ionice live; the daemon's own PATH under systemd may be narrow. */
const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";
const VERSION_TIMEOUT_MS = 10_000;
/** Between SIGTERM and SIGKILL on cancel. */
const KILL_GRACE_MS = 3_000;
const STDERR_TAIL = 2_000;

/** gdu's default `-i` list, which any explicit `-i` replaces. */
export const KERNEL_TREES = ["/proc", "/dev", "/sys", "/run"];

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `<appdir>/bin/gdu`, then the sessions' PATH, then `/usr/local/bin/gdu` — as voxl is found. */
export function resolveGduBinary(options: { baseDir: string; path?: string }): string | null {
  const inAppdir = join(appBinDir(options.baseDir), "gdu");
  if (executable(inAppdir)) return inAppdir;
  const onPath = resolveTool("gdu", options.path ?? sessionPath());
  if (onPath && executable(onPath)) return onPath;
  return executable(DEPLOY_LINK) ? DEPLOY_LINK : null;
}

/** `Version:\t v5.39.0` → `v5.39.0`; null for anything else. */
export function parseGduVersion(stdout: string): string | null {
  const match = /^Version:\s*(\S+)\s*$/m.exec(stdout);
  return match ? match[1]! : null;
}

function gduVersionOf(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      bin,
      ["--version"],
      { timeout: VERSION_TIMEOUT_MS, maxBuffer: 64 * 1024, env: { PATH: SYSTEM_PATH, LC_ALL: "C" } },
      (error, stdout) => resolve(error ? null : parseGduVersion(String(stdout ?? "")))
    );
  });
}

export interface GduScanner {
  path: string;
  /** null when `--version` did not answer (the scanner then counts as not installed). */
  version: string | null;
}

/** Resolved on every call (installing gdu lights the view up without a restart); `--version` once per path + mtime. */
export class GduProbe {
  private cached: { key: string; version: Promise<string | null> } | null = null;

  constructor(private readonly options: { baseDir: string; path?: () => string }) {}

  async locate(): Promise<GduScanner | null> {
    const path = resolveGduBinary({ baseDir: this.options.baseDir, path: this.options.path?.() });
    if (!path) return null;
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      /* raced with a removal: --version fails and says so */
    }
    const key = `${path}\0${mtime}`;
    if (this.cached?.key !== key) {
      const entry = { key, version: gduVersionOf(path) };
      this.cached = entry;
      // A --version that failed (a timeout, a spawn error) is asked again next time.
      void entry.version.then((version) => {
        if (version === null && this.cached === entry) this.cached = null;
      });
    }
    return { path, version: await this.cached.version };
  }
}

/** pflag reads each `-i` value as CSV: quote a path that a comma or quote would split. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export interface GduExportRun {
  bin: string;
  /** Directory to scan (a volume's mount point). */
  root: string;
  /** Absolute directories to skip, on top of {@link KERNEL_TREES}. */
  ignore: string[];
  outFile: string;
  /** Working directory for gdu (must exist). */
  cwd: string;
  signal?: AbortSignal;
  /** Defaults to half the cores. */
  cores?: number;
  /** Written while gdu runs (see {@link killLeftoverScan}), removed when it exits. */
  pidFile?: string;
}

/** The command line for a run (exported for the scan service's log line). */
export function gduExportCommand(run: GduExportRun): { command: string; args: string[] } {
  const ignore = [...new Set([...KERNEL_TREES, ...run.ignore])];
  const cores = run.cores ?? Math.max(1, Math.floor(availableParallelism() / 2));
  const gduArgs = [
    "--config-file",
    "/dev/null",
    "-n",
    "-p",
    "-x",
    "-m",
    String(cores),
    "--output-attrs",
    "name,asize,dsize,ino",
    "-i",
    ignore.map(csvField).join(","),
    "-o",
    run.outFile,
    run.root
  ];
  const setpriv = resolveTool("setpriv", SYSTEM_PATH);
  const nice = resolveTool("nice", SYSTEM_PATH);
  const ionice = resolveTool("ionice", SYSTEM_PATH);
  const prefix = [
    ...(setpriv ? [setpriv, "--pdeathsig", "KILL", "--"] : []),
    ...(nice ? [nice, "-n", "19"] : []),
    ...(ionice ? [ionice, "-c", "3"] : [])
  ];
  const [command, ...rest] = [...prefix, run.bin, ...gduArgs];
  return { command: command!, args: rest };
}

interface ScanPidRecord {
  pgid: number;
  /** Field 22 of /proc/<pid>/stat: with the boot id, tells a reused pid apart. */
  startTime: string;
  bootId: string;
}

/** Process group and start time of `pid`, from /proc; null when it is gone. */
function processIdentity(pid: number): { pgid: number; startTime: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) is parenthesised and may hold spaces; fields 3… follow the last ")".
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const pgid = Number(fields[2]);
    const startTime = fields[19];
    return Number.isInteger(pgid) && startTime ? { pgid, startTime } : null;
  } catch {
    return null;
  }
}

function bootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return "";
  }
}

function writePidFile(file: string, pid: number): void {
  const identity = processIdentity(pid);
  if (!identity) return;
  const record: ScanPidRecord = { pgid: pid, startTime: identity.startTime, bootId: bootId() };
  try {
    writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  } catch {
    /* a full disk: the parent-death signal still covers a daemon crash */
  }
}

/**
 * Kill the gdu process group a previous daemon recorded in `pidFile` if it is
 * still that same process (same boot, start time and group), then remove the
 * file. Run before a stale export is cleaned up or a new scan can start.
 */
export async function killLeftoverScan(pidFile: string): Promise<boolean> {
  const text = await readFile(pidFile, "utf8").catch(() => null);
  if (text === null) return false;
  let killed = false;
  try {
    const record = JSON.parse(text) as Partial<ScanPidRecord>;
    const pgid = record.pgid;
    if (typeof pgid === "number" && Number.isInteger(pgid) && pgid > 1 && record.bootId === bootId()) {
      const identity = processIdentity(pgid);
      if (identity && identity.pgid === pgid && identity.startTime === record.startTime) {
        process.kill(-pgid, "SIGKILL");
        killed = true;
      }
    }
  } catch {
    /* a torn file or a group already gone */
  }
  await rm(pidFile, { force: true }).catch(() => undefined);
  return killed;
}

export class ScanCancelledError extends Error {
  constructor() {
    super("The scan was cancelled.");
    this.name = "ScanCancelledError";
  }
}

/**
 * Run gdu to export `run.root` into `run.outFile`. Resolves when gdu exited 0;
 * rejects with gdu's last stderr line otherwise, or {@link ScanCancelledError}
 * when `signal` aborted (the whole process group is killed: TERM, then KILL).
 */
export function runGduExport(run: GduExportRun): Promise<void> {
  return new Promise((resolve, reject) => {
    if (run.signal?.aborted) {
      reject(new ScanCancelledError());
      return;
    }
    const { command, args } = gduExportCommand(run);
    const child = spawn(command, args, {
      cwd: run.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      // GOGC=25: gdu holds the whole tree in memory; on a 12.5M-entry disk this takes its peak
      // RSS from 7.4 to 5.4 GiB at the same scan time.
      env: { PATH: SYSTEM_PATH, LC_ALL: "C", HOME: run.cwd, GOGC: "25" }
    });
    // spawn() returns once the child has called setsid() and exec'd: its pid is its group.
    if (run.pidFile && child.pid !== undefined) writePidFile(run.pidFile, child.pid);
    const removePidFile = () => {
      if (!run.pidFile) return;
      try {
        rmSync(run.pidFile, { force: true });
      } catch {
        /* left for the next start, which checks it is still this process */
      }
    };
    let stderr = "";
    child.stdout.resume();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => {
      stderr = (stderr + text).slice(-STDERR_TAIL);
    });
    let killTimer: NodeJS.Timeout | null = null;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* already gone */
      }
    };
    const onAbort = () => {
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    run.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      run.signal?.removeEventListener("abort", onAbort);
      removePidFile();
      reject(new Error(`gdu could not start: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      run.signal?.removeEventListener("abort", onAbort);
      removePidFile();
      if (killTimer) clearTimeout(killTimer);
      if (run.signal?.aborted) {
        reject(new ScanCancelledError());
      } else if (code === 0) {
        resolve();
      } else {
        const detail = stderr.trim().split("\n").at(-1)?.trim();
        reject(new Error(`gdu ${signal ? `was killed by ${signal}` : `exited with code ${code}`}${detail ? `: ${detail}` : ""}`));
      }
    });
  });
}
