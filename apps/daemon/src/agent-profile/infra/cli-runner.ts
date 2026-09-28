/**
 * Agent profile — running an agent's own CLI (`claude plugin …`, `grok mcp …`,
 * spec §4.1 `cli-runner.ts`).
 *
 * - argv only, never a shell: names and URLs in `args` come from the client.
 * - An environment built explicitly, NEVER a spread of the daemon's
 *   `process.env` (the `sessionEnvBase` rule: the daemon's env holds
 *   `ORQUESTER_*` secrets). The child gets {@link buildAgentCliEnv}: the
 *   terminal sessions' PATH, the daemon user's HOME, and a short allowlist —
 *   no `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GROK_HOME` / `OPENCODE_CONFIG_DIR`,
 *   so the CLI works on the daemon user's own home unless the caller passes
 *   one on purpose.
 * - A deadline: SIGTERM to the child's process group, SIGKILL 2 s later.
 * - stdout and stderr capped at 4 MiB each.
 * - stderr handed back to a client only through {@link redactCliOutput}.
 */

import { spawn } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { basename, delimiter, dirname, isAbsolute } from "node:path";
import { redactStderr, stripAnsi } from "../../agent-host/support/stderr.ts";
import { sessionPath } from "../../tmux.ts";
import { redactUrlUserinfo } from "../../workflows/git-remote/remote-url.ts";
import { profileErrors } from "../errors.ts";

/** Per-stream output cap. */
export const CLI_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
/** Grace between SIGTERM and SIGKILL after a deadline. */
export const CLI_KILL_GRACE_MS = 2000;
/** Longest redacted detail an `AGENT_CLI_FAILED` carries. */
export const CLI_ERROR_DETAIL_MAX = 2000;

/** Inherited from the daemon when set: locale, temp dir, and what a CLI needs to reach the network. */
const PASSTHROUGH_ENV = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "SSH_AUTH_SOCK"
] as const;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface AgentCliRun {
  /** The CLI, as the registry resolved it (absolute) or a bare name looked up on the session PATH. */
  bin: string;
  args: readonly string[];
  /** Deadline for the whole run. */
  timeoutMs: number;
  cwd?: string;
  /** Written to stdin, which is then closed; without it stdin is `/dev/null`. */
  input?: string;
  /**
   * Added to the built environment last. May deliberately set an agent home
   * (`CODEX_HOME=<homes.codexHome>`); `ORQUESTER_*` names are refused.
   */
  env?: Readonly<Record<string, string>>;
  /** Test seams. */
  killGraceMs?: number;
  maxOutputBytes?: number;
}

export interface AgentCliResult {
  /** The exit code; `null` when the child ended on a signal. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** The deadline passed and the child was killed. */
  timedOut: boolean;
}

/**
 * The child's environment (see the module header). `bin`'s own directory is
 * appended to PATH when it is absolute, so a CLI installed under an npm or
 * nvm prefix finds its `node` beside it. Throws on an `extra` name that is not
 * an identifier, an `ORQUESTER_*` name, or a value holding NUL.
 */
export function buildAgentCliEnv(
  options: { bin?: string; extra?: Readonly<Record<string, string>> } = {},
  processEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const home = processEnv.HOME && processEnv.HOME.length > 0 ? processEnv.HOME : homedir();
  const pathDirs = sessionPath().split(delimiter).filter(Boolean);
  if (options.bin !== undefined && isAbsolute(options.bin) && !pathDirs.includes(dirname(options.bin))) {
    pathDirs.push(dirname(options.bin));
  }
  const env: Record<string, string> = {
    PATH: pathDirs.join(delimiter),
    HOME: home,
    LANG: "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1"
  };
  for (const name of PASSTHROUGH_ENV) {
    const value = processEnv[name];
    if (value !== undefined && value.length > 0) {
      env[name] = value;
    }
  }
  const user = currentUser(processEnv);
  if (user !== undefined) {
    env.USER = user;
    env.LOGNAME = user;
  }
  for (const [name, value] of Object.entries(options.extra ?? {})) {
    if (!ENV_NAME.test(name) || name.startsWith("ORQUESTER_")) {
      throw profileErrors.invalid(`${JSON.stringify(name)} cannot be passed to an agent CLI.`);
    }
    if (typeof value !== "string" || value.includes("\0")) {
      throw profileErrors.invalid(`The environment variable ${name} holds a value that cannot be passed to a process.`);
    }
    env[name] = value;
  }
  return env;
}

function currentUser(processEnv: NodeJS.ProcessEnv): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return processEnv.USER ?? processEnv.LOGNAME;
  }
}

/** Collects one stream up to `max` bytes, then keeps draining (so the child never blocks) and marks the cut. */
class CappedOutput {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private truncated = false;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    const room = this.max - this.bytes;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (kept.length < chunk.length) {
      this.truncated = true;
    }
    this.chunks.push(kept);
    this.bytes += kept.length;
  }

  text(): string {
    const text = Buffer.concat(this.chunks).toString("utf8");
    return this.truncated ? `${text}\n[output truncated at ${this.max} bytes]` : text;
  }
}

/**
 * Runs the CLI and resolves when it has exited and its output is drained —
 * whatever the exit code. Rejects only when it could not be started (a
 * missing binary, a bad cwd, a refused env name).
 */
export function runAgentCli(run: AgentCliRun): Promise<AgentCliResult> {
  const env = buildAgentCliEnv({ bin: run.bin, extra: run.env });
  const maxBytes = run.maxOutputBytes ?? CLI_OUTPUT_MAX_BYTES;
  const graceMs = run.killGraceMs ?? CLI_KILL_GRACE_MS;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(run.bin, [...run.args], {
      cwd: run.cwd,
      env,
      shell: false,
      // Its own process group, so a deadline also reaches the helpers it spawned.
      detached: true,
      stdio: [run.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout = new CappedOutput(maxBytes);
    const stderr = new CappedOutput(maxBytes);
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    const deadline = setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), graceMs);
    }, run.timeoutMs);

    const finish = (): void => {
      clearTimeout(deadline);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      finish();
      rejectPromise(error);
    });
    child.once("exit", () => {
      if (timedOut) {
        // A helper that escaped the group could hold the pipes open forever; the CLI itself is gone.
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      finish();
      resolvePromise({ code, signal, stdout: stdout.text(), stderr: stderr.text(), timedOut });
    });

    if (child.stdin) {
      // A child that exits without reading its input must not crash the daemon with EPIPE.
      child.stdin.on("error", () => undefined);
      child.stdin.end(run.input);
    }
  });
}

export interface RedactCliOutputOptions {
  /** Home paths collapsed to `~`; defaults to the daemon user's home. */
  homeDirs?: readonly string[];
  /** Exact values to mask (a secret the caller knows it passed in). */
  literals?: readonly string[];
}

/** `API_KEY=…`, `"client_secret": "…"`, `password: …` — a value named like a secret. */
const NAMED_SECRET_RE =
  /\b([A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_-]*)("?\s*[:=]\s*"?)([^\s"',;]+)/gi;

/**
 * CLI output made safe to show or log: ANSI stripped; credential shapes
 * (`Authorization:`, `Bearer`, `sk-…`, GitHub and Slack tokens, pairing URLs
 * — the agent host's `redactStderr`), URL userinfo, and values of keys named
 * like secrets masked; the home directory collapsed to `~`. Does not cap.
 */
export function redactCliOutput(text: string, options: RedactCliOutputOptions = {}): string {
  const redacted = redactStderr(stripAnsi(text), {
    homeDirs: options.homeDirs ?? [homedir()],
    literals: options.literals
  });
  return redactUrlUserinfo(redacted).replace(
    NAMED_SECRET_RE,
    (_match, key: string, separator: string) => `${key}${separator}[redacted]`
  );
}

function capDetail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > CLI_ERROR_DETAIL_MAX ? `${trimmed.slice(0, CLI_ERROR_DETAIL_MAX - 1)}…` : trimmed;
}

/**
 * {@link runAgentCli}, but a start failure, a deadline or a non-zero exit
 * throws 502 `AGENT_CLI_FAILED` with the redacted stderr (stdout when stderr
 * is empty), capped at {@link CLI_ERROR_DETAIL_MAX} characters. `label` names
 * the command in the message; it defaults to the binary's name and the first
 * two arguments (`claude plugin install`).
 */
export async function runAgentCliOrThrow(
  run: AgentCliRun & { label?: string; redact?: RedactCliOutputOptions }
): Promise<AgentCliResult> {
  const label = run.label ?? [basename(run.bin), ...run.args.slice(0, 2)].join(" ");
  let result: AgentCliResult;
  try {
    result = await runAgentCli(run);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw profileErrors.cliFailed(label, capDetail(redactCliOutput(detail, run.redact)));
  }
  if (!result.timedOut && result.code === 0) {
    return result;
  }
  const status = result.timedOut
    ? `timed out after ${Math.round(run.timeoutMs / 100) / 10} s`
    : result.code === null
      ? `killed by ${result.signal ?? "a signal"}`
      : `exit code ${result.code}`;
  const output = redactCliOutput(result.stderr.trim().length > 0 ? result.stderr : result.stdout, run.redact);
  throw profileErrors.cliFailed(label, capDetail(output.trim().length > 0 ? `${status}: ${output}` : status));
}
