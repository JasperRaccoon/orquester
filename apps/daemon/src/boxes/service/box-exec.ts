/**
 * Running a setup command in a box through `BoxConnection.exec`, with its output streamed line by
 * line to the setup log, and the setup log itself (`boxSetupLogPath`, plain text, no secrets).
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

import { boxSetupLogPath } from "@orquester/config";

import type { BoxConnection, BoxExecOptions } from "../contracts.ts";
import { redactUrlUserinfo } from "../../workflows/git-remote/index.ts";

export interface BoxCommandResult {
  code: number | null;
  signal: string | null;
  /** The last few KB of stdout+stderr, for the failure message. */
  tail: string;
  /** The whole stdout, for commands whose answer is read (bounded at 1 MiB). */
  stdout: string;
}

export interface BoxCommandSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  shell?: boolean;
}

const TAIL_BYTES = 4096;
const STDOUT_MAX = 1024 * 1024;

/** Run a command in the box to completion. Resolves with its exit status; rejects only when it could not start or was aborted. */
export async function runBoxCommand(
  connection: BoxConnection,
  spec: BoxCommandSpec,
  options: { signal: AbortSignal; onLine?: (line: string) => void }
): Promise<BoxCommandResult> {
  options.signal.throwIfAborted();
  const exec: BoxExecOptions = { command: spec.command, signal: options.signal };
  if (spec.args) exec.args = spec.args;
  if (spec.cwd) exec.cwd = spec.cwd;
  if (spec.env) exec.env = spec.env;
  if (spec.shell) exec.shell = true;
  const proc = connection.exec(exec);
  proc.stdin.end();
  let tail = "";
  let stdout = "";
  const keep = (text: string) => {
    tail = (tail + text).slice(-TAIL_BYTES);
  };
  const lines = (stream: Readable, sink?: (text: string) => void): Promise<void> =>
    new Promise((resolve) => {
      const decoder = new StringDecoder("utf8");
      let pending = "";
      const flush = (text: string, final: boolean) => {
        pending += text;
        const parts = pending.split(/\r?\n|\r/);
        pending = parts.pop() ?? "";
        if (final && pending.length > 0) {
          parts.push(pending);
          pending = "";
        }
        for (const line of parts) options.onLine?.(line);
      };
      stream.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
        keep(text);
        sink?.(text);
        flush(text, false);
      });
      const done = () => {
        flush(decoder.end(), true);
        resolve();
      };
      stream.once("end", done);
      stream.once("close", done);
      stream.once("error", done);
    });
  const outputs = Promise.all([
    lines(proc.stdout, (text) => {
      if (stdout.length < STDOUT_MAX) stdout += text;
    }),
    lines(proc.stderr)
  ]);
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    proc.once("exit", (code, signal) => resolve({ code, signal }));
    proc.once("error", reject);
    const onAbort = () => proc.kill("SIGTERM");
    options.signal.addEventListener("abort", onAbort, { once: true });
  });
  const status = await exit;
  await outputs;
  options.signal.throwIfAborted();
  return { ...status, tail: redactSetupText(tail), stdout };
}

/** One shell-safe single-quoted POSIX word. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** One PowerShell single-quoted string. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Strip what looks like a credential from text bound for the setup log: URL userinfo, bearer
 * tokens, and the token shapes of the services boxes touch (GitHub, Tailscale).
 */
export function redactSetupText(text: string): string {
  return redactUrlUserinfo(text)
    .replace(/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 ***")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|tskey-[A-Za-z0-9-]{10,})\b/g, "***");
}

/** Appends timestamped lines to each box's setup log, one write chain per box. */
export class BoxSetupLog {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly baseDir: string,
    private readonly logger: Pick<Console, "warn"> = console
  ) {}

  path(boxId: string): string {
    return boxSetupLogPath(this.baseDir, boxId);
  }

  append(boxId: string, line: string): Promise<void> {
    const text = `${new Date().toISOString()} ${redactSetupText(line).replace(/[\r\n]+/g, " ")}\n`;
    const previous = this.chains.get(boxId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const file = this.path(boxId);
      try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await appendFile(file, text, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        this.logger.warn(`Could not write the setup log of box ${boxId} (${(error as NodeJS.ErrnoException)?.code ?? "error"})`);
      }
    });
    this.chains.set(boxId, next);
    void next.finally(() => {
      if (this.chains.get(boxId) === next) this.chains.delete(boxId);
    });
    return next;
  }

  async read(boxId: string): Promise<string> {
    await this.chains.get(boxId);
    try {
      return await readFile(this.path(boxId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
      throw error;
    }
  }

  async flush(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }
}
