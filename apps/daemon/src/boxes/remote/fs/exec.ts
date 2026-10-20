/**
 * Processes the file features run in a box (rg, git, archive and zip tools)
 * and the probe of which of those tools the box has.
 *
 * Every command is an argument array (no shell parsing of request data): the
 * only shell scripts are the fixed probe below.
 */

import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

import type { BoxConnection, BoxProcess } from "../../contracts.ts";
import type { SearchProcess, SearchSpawn } from "../../../search.ts";
import type { BoxProjectFs } from "./project-fs.ts";

/**
 * A `BoxProcess` shaped like the `ChildProcess` parts `search.ts` uses: `close`
 * fires once the process exited AND both its output streams ended (a box sends
 * `exit` after all output, but the stream ends can arrive a tick later).
 */
class SearchProcessAdapter extends EventEmitter implements SearchProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;
  private exitCode: number | null | undefined;
  private openStreams = 2;
  private closed = false;

  constructor(private readonly proc: BoxProcess) {
    super();
    this.stdout = proc.stdout;
    this.stderr = proc.stderr;
    const streamDone = (): void => {
      this.openStreams -= 1;
      this.maybeClose();
    };
    for (const stream of [proc.stdout, proc.stderr]) {
      let done = false;
      const once = (): void => {
        if (done) return;
        done = true;
        streamDone();
      };
      stream.once("end", once);
      stream.once("close", once);
      stream.once("error", once);
    }
    proc.once("exit", (code) => {
      this.exitCode = code;
      this.maybeClose();
    });
    proc.once("error", (error) => {
      // A process that never started (no such command) never exits.
      this.emit("error", error);
    });
    // Never detached: a link that drops ends the process with `exit` (null, SIGHUP).
  }

  kill(): boolean {
    return this.proc.kill();
  }

  private maybeClose(): void {
    if (this.closed || this.exitCode === undefined || this.openStreams > 0) return;
    this.closed = true;
    this.emit("close", this.exitCode);
  }
}

export function asSearchProcess(proc: BoxProcess): SearchProcess {
  return new SearchProcessAdapter(proc);
}

/** A `SearchSpawn` that runs in the box (`cwd` is a host path). Windows boxes print `/` separators too. */
export function boxSearchSpawn(fs: BoxProjectFs): SearchSpawn {
  const windows = fs.connection.sys.os === "win32" || fs.connection.paths.kind === "windows-prefix";
  return (command, args, cwd) => {
    const finalArgs = windows && command === "rg" ? ["--path-separator", "/", ...args] : args;
    const proc = fs.exec({ command, args: finalArgs, cwd });
    // Like the host's `stdio: "ignore"`: the listers and rg never read stdin.
    proc.stdin.end();
    return asSearchProcess(proc);
  };
}

export interface BoxCommandResult {
  code: number | null;
  signal: string | null;
  stdout: Buffer;
  /** At most 8 KiB. */
  stderr: string;
  /** Output went past `maxStdoutBytes` (the process was killed). */
  overflow: boolean;
  timedOut: boolean;
}

/**
 * Run one command in the box to completion, collecting stdout (bounded) and the
 * start of stderr. A spawn failure rejects; a non-zero exit resolves. `signal`
 * and `timeoutMs` kill the process (and resolve with `signal` set).
 */
export function runBoxCommand(
  fs: BoxProjectFs,
  options: {
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxStdoutBytes?: number;
    stdin?: string;
  }
): Promise<BoxCommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new Error("aborted"));
      return;
    }
    let proc: BoxProcess;
    try {
      proc = fs.exec({
        command: options.command,
        args: options.args,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {})
      });
    } catch (error) {
      reject(error);
      return;
    }
    const child = asSearchProcess(proc);
    const max = options.maxStdoutBytes ?? 32 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    let settled = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, options.timeoutMs)
      : null;
    const onAbort = (): void => {
      proc.kill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (overflow) return;
      size += chunk.length;
      if (size > max) {
        overflow = true;
        proc.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code,
        signal: proc.signalCode,
        stdout: Buffer.concat(chunks),
        stderr: stderr.slice(0, 8192),
        overflow,
        timedOut
      });
    });
    if (options.stdin !== undefined) proc.stdin.end(options.stdin);
    else proc.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Which tools the box has
// ---------------------------------------------------------------------------

export interface BoxTools {
  rg: boolean;
  git: boolean;
  /** libarchive's bsdtar (macOS and Windows ship it as `tar`), or null. */
  bsdtar: string | null;
  zip: boolean;
  /** `7z`, `7zz` or `7za`, or null. */
  sevenZip: string | null;
}

const PROBED = ["rg", "git", "bsdtar", "tar", "zip", "7z", "7zz", "7za"] as const;

const POSIX_PROBE = `for t in ${PROBED.join(" ")}; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done; exit 0`;
const WINDOWS_PROBE =
  `foreach ($t in @(${PROBED.map((tool) => `'${tool}'`).join(",")})) ` +
  `{ if (Get-Command $t -CommandType Application -ErrorAction SilentlyContinue) { $t } }`;

/** A box whose probe found everything is not asked again; a miss is trusted this long (a tool installed later is picked up). */
const NEGATIVE_TTL_MS = 30_000;

interface ProbeSlot {
  tools: BoxTools;
  at: number;
}

const probes = new WeakMap<BoxConnection, ProbeSlot | Promise<BoxTools>>();

function complete(tools: BoxTools): boolean {
  return tools.rg && tools.git && tools.bsdtar !== null && tools.sevenZip !== null;
}

/** The tools the box has, probed once per link (misses re-probed after 30 s). */
export async function boxTools(fs: BoxProjectFs): Promise<BoxTools> {
  const cached = probes.get(fs.connection);
  if (cached instanceof Promise) return cached;
  if (cached && (complete(cached.tools) || Date.now() - cached.at < NEGATIVE_TTL_MS)) return cached.tools;
  const probe = probeTools(fs).then(
    (tools) => {
      probes.set(fs.connection, { tools, at: Date.now() });
      return tools;
    },
    (error: unknown) => {
      probes.delete(fs.connection);
      throw error;
    }
  );
  probes.set(fs.connection, probe);
  return probe;
}

async function probeTools(fs: BoxProjectFs): Promise<BoxTools> {
  const os = fs.connection.sys.os;
  const result =
    os === "win32"
      ? await runBoxCommand(fs, {
          command: "powershell.exe",
          args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROBE],
          timeoutMs: 15_000,
          maxStdoutBytes: 64 * 1024
        })
      : await runBoxCommand(fs, { command: "/bin/sh", args: ["-c", POSIX_PROBE], timeoutMs: 15_000, maxStdoutBytes: 64 * 1024 });
  const found = new Set(
    result.stdout
      .toString("utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );
  // GNU tar (Linux) writes no zip; the `tar` of macOS and Windows is bsdtar.
  const bsdtar = found.has("bsdtar") ? "bsdtar" : os !== "linux" && found.has("tar") ? "tar" : null;
  const sevenZip = (["7z", "7zz", "7za"] as const).find((bin) => found.has(bin)) ?? null;
  return { rg: found.has("rg"), git: found.has("git"), bsdtar, zip: found.has("zip"), sevenZip };
}
