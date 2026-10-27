/**
 * Callstack's `agent-device` CLI, run by the daemon for one leased device (devices spec §4, §9).
 *
 * Every call is `<command> <args…> --config <host config> --session orq-<hash> --platform …
 * --udid|--serial <device> --json <agent-device command> <its args>`:
 *
 * - the global flags come first, so a `--` before user text (`type -- "--x"`) cannot swallow them;
 * - `--config` is the host's file pinned to its agent-device daemon (`DeviceHost.agentDeviceConfigPath`,
 *   0600, its token inside): a token is never in argv, and only an allowlist of the daemon's
 *   environment is inherited ({@link agentDeviceEnv}): no daemon secret, no `AGENT_DEVICE_*` retarget;
 * - `--session` is stable per chat, host and device ({@link agentDeviceSession});
 * - no shell; a timeout, the caller's abort, and output caps bound every run.
 *
 * {@link agentDeviceData} turns a run's `--json` answer into its `data` or a `DeviceError` written
 * for the agent (no host paths).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StoredDeviceLease } from "@orquester/config";

import { DeviceError, type DeviceErrorCodeOrGeneric } from "./errors.ts";
import type { AgentDeviceCommand, DeviceHost } from "./host.ts";
import type { DeviceToolchain } from "./toolchain/index.ts";

interface AgentDeviceTarget {
  host: DeviceHost;
  /** A `ready` lease (its `deviceId` set). */
  lease: StoredDeviceLease;
}

export interface AgentDeviceResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The parsed `--json` output, when the command printed one. */
  json?: unknown;
  /** An output stream hit its cap (the rest was dropped). */
  truncated?: boolean;
}

interface AgentDeviceRunOptions {
  signal: AbortSignal;
  timeoutMs?: number;
  /** Written to the CLI's stdin (`fill --text-stdin`: text stays out of argv). */
  stdin?: string;
  /** Another session than the lease's (only to close a stale Orquester session holding the device). */
  session?: string;
}

export interface AgentDeviceClient {
  /** Run `agent-device <command> …args` for the target's device. Rejects only when it could not run (missing, timeout, abort). */
  run(target: AgentDeviceTarget, command: string, args: readonly string[], options: AgentDeviceRunOptions): Promise<AgentDeviceResult>;
  /** Warm up a freshly ready host (iOS: build the XCTest runner) so the first snapshot is fast. */
  prepare?(host: DeviceHost, signal: AbortSignal): Promise<void>;
}

interface AgentDeviceDeps {
  toolchain: DeviceToolchain;
  env: NodeJS.ProcessEnv;
}

const AGENT_DEVICE_DEFAULT_TIMEOUT_MS = 60_000;
const STDOUT_CAP = 8 * 1024 * 1024;
const STDERR_CAP = 256 * 1024;
const KILL_GRACE_MS = 3_000;

/** The agent-device session for one chat's lease of one device: `orq-<16 hex>`. */
export function agentDeviceSession(threadId: string, hostId: string, deviceId: string): string {
  return `orq-${createHash("sha256").update(JSON.stringify([threadId, hostId, deviceId])).digest("hex").slice(0, 16)}`;
}

/** The full argument list (after the executable): the command's prefix, the pinned global flags, then the command. */
function agentDeviceArgv(input: {
  prefix: readonly string[];
  configPath: string;
  session: string;
  platform: string;
  deviceId: string;
  command: string;
  args: readonly string[];
}): string[] {
  const platform = input.platform === "ios" ? "ios" : "android";
  return [
    ...input.prefix,
    "--config",
    input.configPath,
    "--session",
    input.session,
    "--platform",
    platform,
    platform === "ios" ? "--udid" : "--serial",
    input.deviceId,
    "--json",
    input.command,
    ...input.args
  ];
}

/**
 * The daemon variables a run inherits (as `android/env.ts`): the path, locale, time zone and the
 * user's home and temp dirs. Nothing else of the daemon's environment (its secrets, provider keys,
 * `AGENT_DEVICE_*` overrides) reaches the CLI.
 */
const AGENT_DEVICE_ENV_PASSTHROUGH = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "TERM", "SHELL", "XDG_RUNTIME_DIR"] as const;

/** The environment a run gets: the allowlisted daemon variables, then the host's additions (`AgentDeviceCommand.env`). */
function agentDeviceEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of AGENT_DEVICE_ENV_PASSTHROUGH) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  env.NO_COLOR = "1";
  env.ELECTRON_RUN_AS_NODE = "1";
  return { ...env, ...extra };
}

/** Parse a `--json` answer (the whole stdout, or its last JSON object). */
function parseAgentDeviceJson(stdout: string): unknown {
  const text = stdout.trim();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    const at = text.lastIndexOf("\n{");
    if (at < 0) return undefined;
    try {
      return JSON.parse(text.slice(at + 1));
    } catch {
      return undefined;
    }
  }
}

/** Absolute host paths in a message become `<path>` (URLs are left alone). */
function redactPaths(text: string): string {
  return text.replace(/(?<![:\w/.~-])\/(?:[\w.@~-]+\/)+[\w.@~-]*/g, "<path>");
}

/** agent-device refused: its code (`SESSION_NOT_FOUND`, …) and reason are kept for the caller's recovery. */
export class AgentDeviceError extends DeviceError {
  constructor(
    code: DeviceErrorCodeOrGeneric,
    message: string,
    readonly cliCode: string | null,
    readonly reason: string | null,
    /** agent-device's `details` (`DEVICE_IN_USE` names the holding `session`). */
    readonly details: Record<string, unknown> | null = null
  ) {
    super(code, message);
  }
}

const STALE_REF_REASONS = new Set(["plain_ref_requires_complete_frame", "ref_frame_expired", "ref_not_found", "stale_ref"]);

/** The `data` of a successful run, or the refusal as a `DeviceError` written for the agent. */
export function agentDeviceData(result: AgentDeviceResult, command: string): Record<string, unknown> {
  const json = result.json as { success?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown; hint?: unknown; details?: { reason?: unknown } } } | undefined;
  if (json && json.success === true) {
    const data = json.data && typeof json.data === "object" ? (json.data as Record<string, unknown>) : {};
    return command === "batch" ? batchStepData(data) : data;
  }
  if (json && json.success === false && json.error) {
    const cliCode = typeof json.error.code === "string" ? json.error.code : null;
    const reason = typeof json.error.details?.reason === "string" ? json.error.details.reason : null;
    let text = typeof json.error.message === "string" ? json.error.message : `${command} failed`;
    // A one-step batch (`type`/`wait` text through stdin) fails in the step's own words.
    if (command === "batch") text = text.replace(/^Batch failed at step \d+ \([\w-]+\): /, "");
    const message = clip(redactPaths(text));
    const hint = typeof json.error.hint === "string" ? clip(redactPaths(json.error.hint)) : null;
    const details = json.error.details && typeof json.error.details === "object" ? (json.error.details as Record<string, unknown>) : null;
    const error = classify(cliCode, reason, message, hint);
    throw new AgentDeviceError(error.code, error.message, cliCode, reason, details);
  }
  if (result.exitCode === 0) return {};
  const line = result.stderr.trim().split("\n").filter(Boolean).pop() ?? `exit code ${result.exitCode}`;
  throw new AgentDeviceError("UNAVAILABLE", `agent-device ${command} failed: ${clip(redactPaths(line))}`, null, null);
}

/** A one-step batch's answer: the step's own data (`results[0].data`, or the result itself). */
function batchStepData(data: Record<string, unknown>): Record<string, unknown> {
  const first = Array.isArray(data.results) ? (data.results[0] as unknown) : undefined;
  if (!first || typeof first !== "object") return {};
  const inner = (first as { data?: unknown }).data;
  return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : (first as Record<string, unknown>);
}

function classify(cliCode: string | null, reason: string | null, message: string, hint: string | null): AgentDeviceError {
  const withHint = hint ? `${message} (${hint})` : message;
  if ((reason !== null && STALE_REF_REASONS.has(reason)) || cliCode === "ELEMENT_NOT_FOUND" || /\bref @?e\d+\b.*(expired|needs a complete snapshot|not found)/i.test(message)) {
    return new AgentDeviceError("INVALID_ARGUMENT", `${message}. Take a new snapshot (device_action {action:"snapshot"}) and use its refs.`, cliCode, reason);
  }
  switch (cliCode) {
    case "SESSION_NOT_FOUND":
      return new AgentDeviceError("UNAVAILABLE", `${message} Open an app with device_action {action:"open_app"} first.`, cliCode, reason);
    case "INVALID_ARGS":
    case "UNSUPPORTED_OPERATION":
    case "UNSUPPORTED_PLATFORM":
      return new AgentDeviceError("INVALID_ARGUMENT", withHint, cliCode, reason);
    case "DEVICE_NOT_FOUND":
      return new AgentDeviceError("DEVICE_LOST", `The device is gone (${message}). Call open_device again.`, cliCode, reason);
    case "DEVICE_IN_USE":
      return new AgentDeviceError("DEVICE_BUSY", withHint, cliCode, reason);
    case "UNAUTHORIZED":
    case "ECONNREFUSED":
      return new AgentDeviceError("UNAVAILABLE", "The device host's automation service is not answering. Try again shortly, or ask the owner to check Settings → Devices.", cliCode, reason);
    default:
      return new AgentDeviceError("UNAVAILABLE", withHint, cliCode, reason);
  }
}

function clip(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** How to run the CLI for a host: its own command, else the toolchain's pinned install under this Node. */
function commandFor(host: DeviceHost, toolchain: DeviceToolchain): AgentDeviceCommand {
  const own = host.agentDeviceCommand?.();
  if (own) return own;
  const bin = toolchain.toolBin("agent-device");
  if (!bin) throw new DeviceError("UNAVAILABLE", "agent-device is not installed on this machine yet. Ask the owner to set devices up in Settings → Devices.");
  let entry = bin;
  try {
    entry = realpathSync(bin);
  } catch {
    // run the bin itself
  }
  return /\.(?:mjs|cjs|js)$/.test(entry) ? { command: process.execPath, args: [entry], env: {} } : { command: entry, args: [], env: {} };
}

export function createAgentDeviceClient(deps: AgentDeviceDeps): AgentDeviceClient {
  return {
    run(target, command, args, options) {
      const { host, lease } = target;
      if (lease.deviceId === null) return Promise.reject(new DeviceError("UNAVAILABLE", "The device is still starting. Call list_devices to see when it is ready."));
      const configPath = host.agentDeviceConfigPath();
      if (!configPath) return Promise.reject(new DeviceError("UNAVAILABLE", `${host.label} is not ready to drive devices yet. Try again shortly.`));
      let cli: AgentDeviceCommand;
      try {
        cli = commandFor(host, deps.toolchain);
      } catch (error) {
        return Promise.reject(error);
      }
      const argv = agentDeviceArgv({
        prefix: cli.args,
        configPath,
        session: options.session ?? agentDeviceSession(lease.threadId, lease.hostId, lease.deviceId),
        platform: lease.platform,
        deviceId: lease.deviceId,
        command,
        args
      });
      return runProcess(cli.command, argv, agentDeviceEnv(deps.env, cli.env), command, options);
    }
  };
}

/**
 * `stdin` as an unlinked 0600 file, open for reading. Not a pipe: Node's pipes are socketpairs, and
 * opening `/dev/stdin` on a socket fails (ENXIO) — `batch --steps-file /dev/stdin` reads it that way.
 */
function stdinFile(text: string): number {
  const dir = mkdtempSync(join(tmpdir(), "orq-agent-device-"));
  try {
    const path = join(dir, "stdin");
    writeFileSync(path, text, { mode: 0o600 });
    return openSync(path, "r");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Spawn without a shell, bounded by the timeout, the abort and the output caps. */
function runProcess(executable: string, argv: readonly string[], env: Record<string, string>, label: string, options: AgentDeviceRunOptions): Promise<AgentDeviceResult> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new DeviceError("CANCELLED", "The request was cancelled."));
      return;
    }
    let stdinFd: number | null = null;
    let child: ReturnType<typeof spawn>;
    try {
      stdinFd = options.stdin !== undefined ? stdinFile(options.stdin) : null;
      child = spawn(executable, [...argv], { env, shell: false, stdio: [stdinFd ?? "ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new DeviceError("UNAVAILABLE", `agent-device could not start (${(error as NodeJS.ErrnoException).code ?? "error"}).`));
      return;
    } finally {
      // The child holds its own copy.
      if (stdinFd !== null) closeSync(stdinFd);
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let settled = false;
    let failure: DeviceError | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: DeviceError) => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const timeoutMs = options.timeoutMs ?? AGENT_DEVICE_DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => stop(new DeviceError("UNAVAILABLE", `agent-device ${label} timed out after ${Math.round(timeoutMs / 1000)} s. Try again, or take a snapshot to see the device's state.`)), timeoutMs);
    timer.unref?.();
    const onAbort = () => stop(new DeviceError("CANCELLED", "The request was cancelled."));
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => {
      if (outBytes >= STDOUT_CAP) return void (truncated = true);
      out.push(chunk.subarray(0, STDOUT_CAP - outBytes));
      outBytes += Math.min(chunk.length, STDOUT_CAP - outBytes);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (errBytes >= STDERR_CAP) return void (truncated = true);
      err.push(chunk.subarray(0, STDERR_CAP - errBytes));
      errBytes += Math.min(chunk.length, STDERR_CAP - errBytes);
    });
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener("abort", onAbort);
      if (failure) return reject(failure);
      const stdout = Buffer.concat(out).toString("utf8");
      resolve({ exitCode, stdout, stderr: Buffer.concat(err).toString("utf8"), json: parseAgentDeviceJson(stdout), ...(truncated ? { truncated: true } : {}) });
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      reject(new DeviceError("UNAVAILABLE", error.code === "ENOENT" ? "agent-device is not installed on this machine. Ask the owner to set devices up in Settings → Devices." : `agent-device could not start (${error.code ?? "error"}).`));
    });
    child.once("close", (code, signal) => finish(code ?? (signal ? 1 : 0)));
  });
}
