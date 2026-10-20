/**
 * Run one command in a box and collect its output — the box twin of a
 * promisified `execFile` (spec §8.7, §8.8). Callers that today shell out on the
 * host (GitService's runner, the workflow project helpers) get the same
 * contract back, so their parsing and error handling stay unchanged:
 *
 * - resolves `{ stdout, stderr }` on exit 0;
 * - a non-zero exit rejects with an error carrying `.code` (the exit code),
 *   `.stdout` and `.stderr`;
 * - `timeout` kills the process (SIGTERM) and rejects with `.killed: true`;
 * - `maxBuffer` (bytes, per stream, like execFile) kills the process once a
 *   stream passes it and rejects with `.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"`,
 *   carrying the output cut at the cap;
 * - a link drop ends a non-detached process with `SIGHUP` and rejects the same
 *   way as a signal death.
 *
 * Paths: `cwd` is a HOST path (the box mirrors host paths, spec §8.6) and is
 * mapped with `hostToBoxPath` here. Arguments are passed through unchanged.
 * Nothing about the command's env or output is logged.
 */

import { hostToBoxPath } from "@orquester/api";

import type { BoxConnection, BoxProcess } from "../../contracts.ts";

export interface BoxRunOptions {
  /** Host path of the working directory; mapped to the box path. */
  cwd?: string;
  /** Merged over `orq-agent`'s own environment. */
  env?: Record<string, string>;
  envUnset?: string[];
  /** Kill the process after this many ms (SIGTERM), like execFile's `timeout`. */
  timeout?: number;
  /** Per-stream output cap in bytes (default 64 MiB). */
  maxBuffer?: number;
  /** Written to stdin, which is then closed. Without it stdin is closed at once. */
  input?: string | Uint8Array;
  signal?: AbortSignal;
}

export interface BoxRunResult {
  stdout: string;
  stderr: string;
}

/** The rejection shape of {@link runInBox}: what `execFile` rejects with. */
export class BoxRunError extends Error {
  code: number | string | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  stdout: string;
  stderr: string;

  constructor(message: string, fields: { code: number | string | null; signal: NodeJS.Signals | null; killed: boolean; stdout: string; stderr: string }) {
    super(message);
    this.name = "BoxRunError";
    this.code = fields.code;
    this.signal = fields.signal;
    this.killed = fields.killed;
    this.stdout = fields.stdout;
    this.stderr = fields.stderr;
  }
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/** Resolves once a box process is running; rejects with its spawn error (or an exit before it ran). */
export function waitSpawned(proc: BoxProcess): Promise<void> {
  if (proc.pid !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      proc.off("spawn", onSpawn);
      proc.off("error", onError);
      proc.off("exit", onExit);
    };
    const onSpawn = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`The process ended before it started (${code !== null ? `exit ${code}` : signal ?? "no status"}).`));
    };
    proc.on("spawn", onSpawn);
    proc.on("error", onError);
    proc.on("exit", onExit);
  });
}

/** Collects one stream up to `cap` bytes; reports when it passed the cap. */
class CappedCollector {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  overflowed = false;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): boolean {
    if (this.overflowed) return false;
    const room = this.cap - this.bytes;
    if (chunk.length > room) {
      if (room > 0) this.chunks.push(chunk.subarray(0, room));
      this.bytes = this.cap;
      this.overflowed = true;
      return false;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    return true;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/** Run `file args…` in the box and collect stdout/stderr (see the module doc). */
export function runInBox(connection: BoxConnection, file: string, args: readonly string[], options: BoxRunOptions = {}): Promise<BoxRunResult> {
  return new Promise<BoxRunResult>((resolve, reject) => {
    const cap = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const stdout = new CappedCollector(cap);
    const stderr = new CappedCollector(cap);
    let killedBy: "timeout" | "maxBuffer" | null = null;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    let child: BoxProcess;
    try {
      child = connection.exec({
        command: file,
        args: [...args],
        ...(options.cwd !== undefined ? { cwd: hostToBoxPath(connection.paths, options.cwd) } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.envUnset?.length ? { envUnset: options.envUnset } : {}),
        ...(options.signal ? { signal: options.signal } : {})
      });
    } catch (error) {
      reject(error);
      return;
    }

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };

    const stop = (reason: "timeout" | "maxBuffer"): void => {
      if (killedBy !== null) return;
      killedBy = reason;
      child.kill("SIGTERM");
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (!stdout.push(Buffer.from(chunk))) stop("maxBuffer");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (!stderr.push(Buffer.from(chunk))) stop("maxBuffer");
    });
    child.on("error", (error: Error) => {
      const e = error as Error & { code?: unknown };
      fail(
        new BoxRunError(error.message, {
          code: typeof e.code === "string" || typeof e.code === "number" ? e.code : null,
          signal: null,
          killed: false,
          stdout: stdout.text(),
          stderr: stderr.text()
        })
      );
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const out = stdout.text();
      const err = stderr.text();
      if (killedBy === "maxBuffer") {
        reject(new BoxRunError(`${file}: stdout maxBuffer length exceeded`, { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", signal, killed: true, stdout: out, stderr: err }));
        return;
      }
      if (killedBy === "timeout") {
        reject(new BoxRunError(`${file} timed out after ${options.timeout} ms`, { code: null, signal: signal ?? "SIGTERM", killed: true, stdout: out, stderr: err }));
        return;
      }
      if (code === 0) {
        resolve({ stdout: out, stderr: err });
        return;
      }
      const what = code !== null ? `exited with code ${code}` : `was killed by ${signal ?? "a signal"}`;
      reject(new BoxRunError(`Command failed in the box: ${file} ${what}`, { code, signal, killed: false, stdout: out, stderr: err }));
    });

    if (options.timeout !== undefined && options.timeout > 0) {
      timer = setTimeout(() => stop("timeout"), options.timeout);
      timer.unref?.();
    }

    child.stdin.on("error", () => {
      // The process may exit before reading its input; the exit tells the story.
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}
