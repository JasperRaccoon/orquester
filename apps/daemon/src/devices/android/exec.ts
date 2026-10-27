/**
 * Run one host program without a shell (the device toolchain and the local Android host): output
 * collected (capped), an optional line callback for progress, a timeout and an abort signal that
 * end it SIGTERM → SIGKILL. {@link ExecFn} is the seam tests replace with a fake.
 */

import { spawn } from "node:child_process";

export interface ExecOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Written to stdin, which is then closed (`yes | sdkmanager --licenses`). */
  input?: string;
  /** Every output line (stdout and stderr; `\r`-separated progress counts as lines). */
  onLine?: (line: string) => void;
}

export interface ExecResult {
  /** The exit code; 128 + the signal number when a signal ended it; -1 when it did not start. */
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type ExecFn = (command: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

/** Kept output per stream; the tail wins. */
const OUTPUT_CAP = 1024 * 1024;
const KILL_GRACE_MS = 5_000;
const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

function cap(text: string): string {
  return text.length > OUTPUT_CAP ? text.slice(text.length - OUTPUT_CAP) : text;
}

/** Split a growing buffer into complete lines (`\n` or `\r`); returns the unfinished rest. */
export function splitLines(buffer: string, onLine: (line: string) => void): string {
  let start = 0;
  for (let index = 0; index < buffer.length; index++) {
    const char = buffer[index];
    if (char === "\n" || char === "\r") {
      const line = buffer.slice(start, index).trim();
      if (line) onLine(line);
      start = index + 1;
    }
  }
  return buffer.slice(start);
}

export const execFile: ExecFn = (command, args, options = {}) =>
  new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ exitCode: -1, stdout: "", stderr: "aborted" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let pending = { out: "", err: "" };
    let timedOut = false;
    let settled = false;
    const child = spawn(command, [...args], {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: [options.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      shell: false
    });
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            terminate();
          }, options.timeoutMs)
        : null;
    timer?.unref?.();
    const onAbort = () => terminate();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.onLine) {
        for (const rest of [pending.out, pending.err]) if (rest.trim()) options.onLine(rest.trim());
      }
      resolve(result);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = cap(stdout + chunk);
      if (options.onLine) pending = { ...pending, out: splitLines(pending.out + chunk, options.onLine) };
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = cap(stderr + chunk);
      if (options.onLine) pending = { ...pending, err: splitLines(pending.err + chunk, options.onLine) };
    });
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    }
    child.on("error", (error) => finish({ exitCode: -1, stdout, stderr: stderr || error.message }));
    child.on("close", (code, signal) => {
      const exitCode = code ?? (signal ? 128 + (SIGNAL_NUMBERS[signal] ?? 0) : -1);
      finish({ exitCode, stdout, stderr, ...(timedOut ? { timedOut } : {}) });
    });
  });

/** The last non-empty line of a result's output, for an error message (no secrets are printed by these tools). */
export function lastLine(result: Pick<ExecResult, "stdout" | "stderr">): string {
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}
