/**
 * The process seam of pairing over SSH: every `ssh` run goes through a {@link SshProcessRunner},
 * so tests drive the whole flow with a fake. The real one spawns the binary directly (never a
 * shell), feeds `input` on stdin and keeps bounded output.
 */

import { spawn } from "node:child_process";

export interface SshRunResult {
  /** Exit code; null when killed (timeout) or it could not start. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The run hit its deadline and was killed. */
  timedOut: boolean;
  /** It could not start (`ENOENT`: no `ssh` on the daemon's PATH). */
  spawnError?: string;
}

export interface SshRunOptions {
  /** Written to stdin, then stdin is closed (scripts and secrets travel only this way). */
  input?: string;
  timeoutMs: number;
}

export type SshProcessRunner = (file: string, args: readonly string[], options: SshRunOptions) => Promise<SshRunResult>;

/** Output kept per stream: the end is what matters for errors, and probes are a few lines. */
const MAX_OUTPUT_CHARS = 256 * 1024;

function keepTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_OUTPUT_CHARS ? next.slice(next.length - MAX_OUTPUT_CHARS) : next;
}

export const spawnSshRunner: SshProcessRunner = (file, args, options) =>
  new Promise((resolve) => {
    // C locale: classification reads OpenSSH's English messages.
    const child = spawn(file, [...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: SshRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout = keepTail(stdout, chunk)));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr = keepTail(stderr, chunk)));
    child.once("error", (error: NodeJS.ErrnoException) => finish({ code: null, stdout, stderr, timedOut, spawnError: error.code ?? error.message }));
    child.once("close", (code) => finish({ code, stdout, stderr, timedOut }));
    // The remote side may exit before reading everything (a refused login): not an error here.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
