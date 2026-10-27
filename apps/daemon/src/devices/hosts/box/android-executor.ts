/**
 * The {@link DeviceExecutor} of a Linux box host: the Android tooling's programs, files and `/proc`
 * reads go over the box's `BoxConnection` (exec, `fs.*`, readFile/writeFile; never SSH).
 *
 * - `exec` runs a program to completion (no shell), with stdin input, line callbacks, a timeout and
 *   an abort (SIGTERM → SIGKILL); like the local runner it resolves `-1` when the program could not
 *   start (the box link down included).
 * - `spawnDetached` starts a program with `setsid` in its own session (it outlives the exec, the box
 *   link and this daemon), output appended to a 0600 log file in the box; its pid is its group.
 * - `/proc` reads, signals and port checks are small `cat`/`kill` execs. Unlike `exec`, they reject
 *   when the box cannot be reached, so an unreachable box never reads as "the process is gone".
 * - Downloads run `curl` in the box and check the pinned SHA-256 there (`sha256sum`).
 */

import { posix } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { BoxConnection } from "../../../boxes/contracts.ts";
import type { DownloadFn } from "../../toolchain/download.ts";
import { type ExecFn, type ExecOptions, type ExecResult, splitLines } from "../../android/exec.ts";
import type { DeviceExecutor } from "../../android/executor.ts";
import { parseMemAvailable, parseProcNetTcp, parseProcStat, type ProcStat, type TcpRow } from "../../android/procs.ts";

const OUTPUT_CAP = 1024 * 1024;
const KILL_GRACE_MS = 5_000;
const PROC_READ_MS = 20_000;
/** Ports the hub may take in a box. */
const HUB_PORT_MIN = 20_000;
const HUB_PORT_SPAN = 10_000;

/**
 * Start `$@` in its own session with output appended to `$1` (0600); prints its pid once the child
 * leads its session (≤ 2 s): until `setsid` ran it is in this exec's process group, which orq-agent
 * hangs up when the exec's channel closes or the link drops. Constant text.
 */
export const DETACH_SCRIPT = `log=$1; shift
umask 077
mkdir -p "$(dirname "$log")"
setsid "$@" >> "$log" 2>&1 < /dev/null &
pid=$!
i=0
while [ "$i" -lt 100 ] && kill -0 "$pid" 2> /dev/null && [ "$(awk '{ sub(/^.*\\) /, ""); print $4 }' "/proc/$pid/stat" 2> /dev/null)" != "$pid" ]; do
  sleep 0.02
  i=$((i + 1))
done
echo "$pid"
`;

/** `curl` a pinned file to `$2` unless it is already there with SHA-256 `$3`. Constant text. */
export const DOWNLOAD_SCRIPT = `set -eu
url=$1; dest=$2; sha=$3
mkdir -p "$(dirname "$dest")"
if [ -f "$dest" ] && printf '%s  %s\\n' "$sha" "$dest" | sha256sum -c --status - 2> /dev/null; then exit 0; fi
curl -fsSL --retry 3 -o "$dest.part" "$url"
if ! printf '%s  %s\\n' "$sha" "$dest.part" | sha256sum -c --status -; then rm -f "$dest.part"; echo "the download of $url did not match its pinned checksum" >&2; exit 1; fi
mv "$dest.part" "$dest"
`;

function cap(text: string): string {
  return text.length > OUTPUT_CAP ? text.slice(text.length - OUTPUT_CAP) : text;
}

function linkError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The executor of the box behind `link` (the connection object stays valid across reconnects). */
export function boxExecutor(link: () => BoxConnection): DeviceExecutor {
  const exec: ExecFn = (command, args, options = {}) => runInBox(link, command, args, options);

  /** A small read-only command whose failure to run (the box unreachable) rejects. */
  const read = async (command: string, args: string[]): Promise<ExecResult> => {
    const connection = link();
    if (!connection.connected) throw new Error(`the box ${connection.boxId} is not connected`);
    const result = await runInBox(link, command, args, { timeoutMs: PROC_READ_MS });
    if (result.exitCode === -1 || result.timedOut) throw new Error(`reading the box failed: ${result.stderr.trim() || "no answer"}`);
    return result;
  };

  const tcpRows = async (): Promise<TcpRow[]> => parseProcNetTcp((await read("/bin/sh", ["-c", "cat /proc/net/tcp /proc/net/tcp6 2> /dev/null; true"])).stdout);
  const listening = async (): Promise<Set<number>> => new Set((await tcpRows()).filter((row) => row.state === "0A").map((row) => row.localPort));

  const kill = async (target: string, signal: NodeJS.Signals): Promise<boolean> =>
    (await read("/bin/sh", ["-c", 'kill -s "$1" -- "$2" 2> /dev/null', "orq-kill", signal.replace(/^SIG/, ""), target])).exitCode === 0;

  const download: DownloadFn = async (file, dest, options) => {
    const result = await exec("/bin/sh", ["-c", DOWNLOAD_SCRIPT, "orq-download", file.url, dest, file.sha256], { signal: options.signal, timeoutMs: 30 * 60_000 });
    options.signal.throwIfAborted();
    if (result.exitCode !== 0) throw new Error(`Downloading ${file.url} in the box failed: ${result.stderr.trim().split("\n").at(-1) || `exit ${result.exitCode}`}`);
    if (file.size) options.onProgress?.(file.size, file.size);
  };

  return {
    get where() {
      return `box:${link().boxId}`;
    },
    exec,

    async spawnDetached(command, args, options) {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(options.env)) if (value !== undefined) env[key] = value;
      const result = await runInBox(link, "/bin/sh", ["-c", DETACH_SCRIPT, "orq-detach", options.logPath, command, ...args], {
        env,
        ...(options.cwd ?? env.HOME ? { cwd: options.cwd ?? env.HOME } : {}),
        timeoutMs: PROC_READ_MS
      });
      const pid = Number(result.stdout.trim().split("\n").at(-1));
      if (result.exitCode !== 0 || !Number.isInteger(pid) || pid <= 1) throw new Error(`${posix.basename(command)} did not start in the box: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
      return pid;
    },

    async readText(path) {
      try {
        const stream = await link().readFile(path, { length: 4 * 1024 * 1024 });
        let text = "";
        for await (const chunk of stream) text += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
        return text;
      } catch {
        return null;
      }
    },

    async writeText(path, text, options = {}) {
      await link().writeFile(path, text, { mkdirs: true, ...(options.mode !== undefined ? { mode: options.mode } : {}) });
    },

    async exists(path) {
      return (await link().request("fs.stat", { path })) !== null;
    },

    async mkdir(path, options = {}) {
      await link().request("fs.mkdir", { path, recursive: true, ...(options.mode !== undefined ? { mode: options.mode } : {}) });
    },

    async remove(path) {
      await link().request("fs.rm", { path, recursive: true, force: true });
    },

    async rename(from, to) {
      await link().request("fs.rename", { from, to });
    },

    async list(path) {
      try {
        return (await link().request("fs.readdir", { path })).map((entry) => entry.name);
      } catch (error) {
        if (!link().connected) throw new Error(linkError(error));
        return [];
      }
    },

    async procStat(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return null;
      const result = await read("cat", [`/proc/${pid}/stat`]);
      return result.exitCode === 0 ? parseProcStat(result.stdout.trim()) : null;
    },

    async procStats() {
      const result = await read("/bin/sh", ["-c", "cat /proc/[0-9]*/stat 2> /dev/null; true"]);
      return result.stdout
        .split("\n")
        .map((line) => parseProcStat(line.trim()))
        .filter((stat): stat is ProcStat => stat !== null && stat.state !== "Z");
    },

    async environ(pid) {
      const result = await read("cat", [`/proc/${pid}/environ`]);
      if (result.exitCode !== 0) return null;
      const env = new Map<string, string>();
      for (const entry of result.stdout.split("\0")) {
        const at = entry.indexOf("=");
        if (at > 0) env.set(entry.slice(0, at), entry.slice(at + 1));
      }
      return env;
    },

    async cmdline(pid) {
      const result = await read("cat", [`/proc/${pid}/cmdline`]);
      return result.exitCode === 0 ? result.stdout.split("\0").filter(Boolean) : [];
    },

    async signal(pgid, pid, signal) {
      if (pgid !== null && pgid > 1 && (await kill(`-${pgid}`, signal))) return true;
      return pid > 1 ? kill(String(pid), signal) : false;
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
      throw new Error("no free port in the box");
    },

    async memAvailable() {
      return parseMemAvailable((await read("cat", ["/proc/meminfo"])).stdout);
    },

    download
  };
}

/** Run one program in the box to completion; resolves like the local runner (`-1`: it did not start). */
function runInBox(link: () => BoxConnection, command: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ exitCode: -1, stdout: "", stderr: "aborted" });
      return;
    }
    let proc;
    try {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(options.env ?? {})) if (value !== undefined) env[key] = value;
      proc = link().exec({ command, args: [...args], ...(options.env ? { env } : {}), ...(options.cwd ? { cwd: options.cwd } : {}) });
    } catch (error) {
      resolve({ exitCode: -1, stdout: "", stderr: linkError(error) });
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

    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.onLine) for (const rest of [pendingOut, pendingErr]) if (rest.trim()) options.onLine(rest.trim());
      resolve(result);
    };
    const maybeDone = () => {
      if (open > 0 || !exit) return;
      const code = exit.code ?? (exit.signal ? 128 + (exit.signal === "SIGKILL" ? 9 : exit.signal === "SIGTERM" ? 15 : 0) : -1);
      finish({ exitCode: code, stdout, stderr, ...(timedOut ? { timedOut } : {}) });
    };
    const collect = (stream: NodeJS.ReadableStream, which: "out" | "err") => {
      const decoder = new StringDecoder("utf8");
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        open -= 1;
        maybeDone();
      };
      stream.once("end", end);
      stream.once("close", end);
      stream.once("error", end);
      stream.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
        if (which === "out") {
          stdout = cap(stdout + text);
          if (options.onLine) pendingOut = splitLines(pendingOut + text, options.onLine);
        } else {
          stderr = cap(stderr + text);
          if (options.onLine) pendingErr = splitLines(pendingErr + text, options.onLine);
        }
      });
    };
    collect(proc.stdout, "out");
    collect(proc.stderr, "err");
    proc.stdin.on("error", () => undefined);
    if (options.input !== undefined) proc.stdin.end(options.input);
    else proc.stdin.end();
    proc.once("error", (error) => {
      exit = { code: -1, signal: null };
      stderr = stderr || error.message;
      open = 0;
      maybeDone();
    });
    proc.once("exit", (code, signal) => {
      exit = { code, signal };
      maybeDone();
    });
  });
}
