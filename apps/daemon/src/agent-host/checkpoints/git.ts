/**
 * Checkpoints — the bounded `git` process runner (spec §5.4).
 *
 * Every git process runs under a shared permit pool (8 by default) with a 30 s
 * timeout and a 1 MB default output cap; capture commands additionally retry
 * twice, 75 ms apart, on a transient `.lock`/`ENOENT` exit, because a
 * concurrent user-run git command holds the same locks.
 *
 * The env is **explicit**, never a spread of `process.env` (§3.1): the host
 * hands one `gitEnv` to the factory and every child sees exactly that, plus the
 * per-call overrides (`GIT_INDEX_FILE` and the fixed identity) a capture needs.
 *
 * Ported from T3 Code (MIT): apps/server/src/vcs/VcsProcess.ts
 */

import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";

import { spawnProviderChild, type ProviderChild } from "../support/spawn.ts";

export const GIT_DEFAULT_TIMEOUT_MS = 30_000;
export const GIT_DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
export const GIT_DEFAULT_CONCURRENCY = 8;
export const GIT_TRANSIENT_RETRIES = 2;
export const GIT_TRANSIENT_RETRY_DELAY_MS = 75;
export const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";

export type GitOutputMode = "truncate" | "error";

export interface GitRunInput {
  /** Names the step in an error message. Never a path, never user text. */
  operation: string;
  cwd: string;
  args: readonly string[];
  /** Merged over the base git env; a key set to `undefined` is removed. */
  env?: Record<string, string | undefined>;
  stdin?: string;
  allowNonZeroExit?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** `truncate` keeps what fits; `error` fails rather than return a half answer. */
  outputMode?: GitOutputMode;
  appendTruncationMarker?: boolean;
  /**
   * Called with every stdout chunk **before** the output cap is applied, so a
   * caller can scan an arbitrarily long stream while retaining almost none of
   * it (the `ls-files -v` flag scan does exactly that).
   */
  onStdoutChunk?: (chunk: Buffer) => void;
  /** Capture-only: retry a transient lock/ENOENT failure (§5.4). */
  retryTransient?: boolean;
  /** Aborts the wait early — the recovery budget's outer deadline. */
  signal?: AbortSignal;
}

export interface GitRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** Base class so a caller can catch every git failure in one arm. */
export class GitError extends Error {
  readonly operation: string;

  constructor(operation: string, message: string) {
    super(message);
    this.name = "GitError";
    this.operation = operation;
  }
}

export class GitSpawnError extends GitError {
  constructor(operation: string, cause: Error) {
    super(operation, `git failed to start (${operation}): ${cause.message}`);
    this.name = "GitSpawnError";
  }
}

export class GitTimeoutError extends GitError {
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(operation, `git timed out after ${timeoutMs}ms (${operation})`);
    this.name = "GitTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** The caller's budget expired before (or while) this command ran. */
export class GitAbortedError extends GitError {
  constructor(operation: string) {
    super(operation, `git was aborted before it could finish (${operation})`);
    this.name = "GitAbortedError";
  }
}

export class GitOutputLimitError extends GitError {
  readonly maxBytes: number;

  constructor(operation: string, maxBytes: number) {
    super(operation, `git produced more than ${maxBytes} bytes (${operation})`);
    this.name = "GitOutputLimitError";
    this.maxBytes = maxBytes;
  }
}

export class GitExitError extends GitError {
  readonly exitCode: number;
  readonly stderr: string;
  /** A concurrent user-run git command held the same lock; worth retrying. */
  readonly retryable: boolean;

  constructor(operation: string, exitCode: number, stderr: string) {
    const detail = firstLine(stderr);
    super(operation, `git exited with ${exitCode} (${operation})${detail ? `: ${detail}` : ""}`);
    this.name = "GitExitError";
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.retryable = isTransientGitExit(stderr);
  }
}

function firstLine(text: string): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** Classify before discarding stderr; keep paths and process output out of errors. */
export function isTransientGitExit(stderr: string): boolean {
  return (
    /unable to create [^\n]*\.lock['"]?: file exists/i.test(stderr) ||
    /(?:unable to stat|lstat\(|error: open\()[^\n]+: no such file or directory/i.test(stderr)
  );
}

/**
 * A counting semaphore. The permit pool is per service instance, which is
 * host-wide in production because the host builds one checkpoint service.
 */
export class Semaphore {
  #available: number;
  readonly #waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.#available = Math.max(1, Math.floor(permits));
  }

  async acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return this.#release();
    }
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
    return this.#release();
  }

  #release(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.#waiters.shift();
      if (next) {
        next();
        return;
      }
      this.#available += 1;
    };
  }
}

export interface GitRunnerOptions {
  /** The complete environment for every git child (§3.1). */
  gitEnv: Record<string, string>;
  maxConcurrentGit?: number;
  /** Test seam: resolve the binary differently. */
  resolveGitBinary?: (env: Record<string, string>) => string;
}

export interface GitRunner {
  run(input: GitRunInput): Promise<GitRunResult>;
  /** The env every child starts from, after the runner's own defaults. */
  readonly env: Record<string, string>;
}

/**
 * Defaults the runner adds unless `gitEnv` already names them:
 * - `GIT_TERMINAL_PROMPT=0` so a misconfigured repo can never park a child on
 *   a credential prompt the host cannot answer;
 * - `LC_ALL=C` so the transient-failure classification above reads git's own
 *   English messages whatever the host locale is. Paths are unaffected —
 *   every command that names one uses `-z`.
 */
const GIT_ENV_DEFAULTS: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C"
};

export function createGitRunner(options: GitRunnerOptions): GitRunner {
  const env: Record<string, string> = { ...GIT_ENV_DEFAULTS, ...options.gitEnv };
  const permits = new Semaphore(options.maxConcurrentGit ?? GIT_DEFAULT_CONCURRENCY);
  const resolveBinary = options.resolveGitBinary ?? resolveGitBinary;
  let binary: string | null = null;

  const runOnce = async (input: GitRunInput): Promise<GitRunResult> => {
    // An abort that arrived while this call was queued must not spend a
    // process: the permit wait is unbounded by design (8 permits, 30 s each),
    // so a recovery budget that expired in the queue would otherwise still
    // spawn and run to its own timeout.
    throwIfAborted(input);
    const release = await permits.acquire();
    try {
      throwIfAborted(input);
      binary ??= resolveBinary(env);
      return await runGit(binary, env, input);
    } finally {
      release();
    }
  };

  const run = async (input: GitRunInput): Promise<GitRunResult> => {
    // A retry replays the command from the start, so it can never be combined
    // with a streaming scanner: attempt 2 would re-feed a stateful consumer
    // mid-record. T3 excludes the pair structurally for the same reason
    // (`VcsProcess.ts:205-227`), and so does this.
    if (input.retryTransient !== true || input.onStdoutChunk !== undefined) {
      return await runOnce(input);
    }
    let attempt = 0;
    for (;;) {
      try {
        return await runOnce(input);
      } catch (error) {
        const retryable = error instanceof GitExitError && error.retryable;
        if (!retryable || attempt >= GIT_TRANSIENT_RETRIES || input.signal?.aborted === true) {
          throw error;
        }
        attempt += 1;
        await delay(GIT_TRANSIENT_RETRY_DELAY_MS);
      }
    }
  };

  return { run, env };
}

/** An already-aborted signal never fires `abort` again, so it is checked, not listened for. */
function throwIfAborted(input: GitRunInput): void {
  if (input.signal?.aborted === true) {
    throw new GitAbortedError(input.operation);
  }
}

function delay(ms: number): Promise<void> {
  // Deliberately NOT unref'd: this is the gap between two attempts of a
  // command a caller is awaiting. An unref'd timer would let the loop drain
  // while the retry is still owed, and the caller's promise would never settle.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runGit(
  binary: string,
  baseEnv: Record<string, string>,
  input: GitRunInput
): Promise<GitRunResult> {
  const timeoutMs = input.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = input.maxOutputBytes ?? GIT_DEFAULT_MAX_OUTPUT_BYTES;
  const outputMode = input.outputMode ?? "truncate";

  const childEnv: Record<string, string> = { ...baseEnv };
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (value === undefined) {
      delete childEnv[key];
    } else {
      childEnv[key] = value;
    }
  }

  let child: ProviderChild;
  try {
    child = spawnProviderChild({
      command: binary,
      args: input.args,
      env: childEnv,
      cwd: input.cwd
    });
  } catch (error) {
    throw new GitSpawnError(input.operation, error as Error);
  }

  const stdout = new CappedBuffer(maxOutputBytes);
  const stderr = new CappedBuffer(64 * 1024);
  let limitExceeded = false;

  const settled = new Promise<GitRunResult>((resolve, reject) => {
    let pending = 3;
    const done = (): void => {
      pending -= 1;
      if (pending === 0) {
        finish();
      }
    };
    const finish = (): void => {
      const reason = child.exitReason();
      if (reason === null) {
        return;
      }
      if (reason.kind === "spawn-error") {
        reject(new GitSpawnError(input.operation, reason.error));
        return;
      }
      if (limitExceeded && outputMode === "error") {
        reject(new GitOutputLimitError(input.operation, maxOutputBytes));
        return;
      }
      const result: GitRunResult = {
        exitCode: reason.kind === "exit" ? reason.code : 128,
        stdout: stdout.text(input.appendTruncationMarker === true ? OUTPUT_TRUNCATED_MARKER : ""),
        stderr: stderr.text(""),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated
      };
      if (input.allowNonZeroExit !== true && result.exitCode !== 0) {
        reject(new GitExitError(input.operation, result.exitCode, result.stderr));
        return;
      }
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      input.onStdoutChunk?.(chunk);
      if (!stdout.push(chunk)) {
        limitExceeded = true;
        if (outputMode === "error") {
          void child.kill();
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    // `close` fires exactly once per stream, after either `end` or `error`,
    // so the three-way join below can never double-count.
    child.stdout.once("close", done);
    child.stderr.once("close", done);
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.exited.then(done, done);
  });

  child.stdin.on("error", () => {
    // EPIPE: git closed stdin because it had read all it wanted. Not an error
    // for us — the exit code is what decides the outcome.
  });
  if (input.stdin !== undefined) {
    child.stdin.end(input.stdin);
  } else {
    child.stdin.end();
  }

  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    void child.kill();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    timer = setTimeout(() => {
      timedOut = true;
      void child.kill();
    }, timeoutMs);
    const result = await settled;
    // A killed child can still exit 0-ish under `allowNonZeroExit`; the expiry
    // or the abort is the outcome that matters, never the corpse's exit code.
    if (timedOut) {
      throw new GitTimeoutError(input.operation, timeoutMs);
    }
    if (aborted) {
      throw new GitAbortedError(input.operation);
    }
    return result;
  } catch (error) {
    if (timedOut) {
      throw new GitTimeoutError(input.operation, timeoutMs);
    }
    if (aborted) {
      throw new GitAbortedError(input.operation);
    }
    throw error;
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
    input.signal?.removeEventListener("abort", onAbort);
  }
}

/** Retains at most `max` bytes and counts what it dropped. */
class CappedBuffer {
  readonly #chunks: Buffer[] = [];
  readonly #max: number;
  #size = 0;
  truncated = false;

  constructor(max: number) {
    this.#max = max;
  }

  /** Returns false once the cap has been exceeded. */
  push(chunk: Buffer): boolean {
    if (this.#size >= this.#max) {
      this.truncated = true;
      return false;
    }
    const room = this.#max - this.#size;
    if (chunk.length <= room) {
      this.#chunks.push(chunk);
      this.#size += chunk.length;
      return true;
    }
    this.#chunks.push(chunk.subarray(0, room));
    this.#size = this.#max;
    this.truncated = true;
    return false;
  }

  text(marker: string): string {
    const text = Buffer.concat(this.#chunks).toString("utf8");
    return this.truncated && marker.length > 0 ? `${text}${marker}` : text;
  }
}

/**
 * Resolve `git` against the env's own PATH. `spawnProviderChild` wants an
 * absolute path — a bare name would be resolved against the *daemon's* PATH by
 * the OS, which is not the PATH the host was configured with.
 */
export function resolveGitBinary(env: Record<string, string>): string {
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = path.join(dir, process.platform === "win32" ? "git.exe" : "git");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  // Last resort: let the OS resolve it and fail loudly if it cannot.
  return process.platform === "win32" ? "git.exe" : "git";
}
