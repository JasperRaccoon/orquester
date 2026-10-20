/**
 * Agent host — short commands in a box (spec 2026-10-19 §8.5): the box's login
 * PATH, resolving an agent CLI there (`command -v` / `where.exe`, never the
 * host's PATH), installing it on first use with the registry's own install
 * command, and the `--version` probe.
 *
 * Every command is bounded and killed at its deadline. Output is kept in
 * memory up to a cap; nothing here logs a command's output.
 */

import { REGISTRY, type RegistryEntryDef } from "@orquester/registry";
import type { AgentAdapterId } from "@orquester/api/agent-chat";

import type { BoxConnection } from "../../boxes/contracts.ts";
import { withDeadline } from "../support/deadline.ts";
import { boxPathSyntax, joinBoxPath } from "./launch-info.ts";
import { BoxLaunchError, describeBoxFailure } from "./errors.ts";
import { spawnBoxChild } from "./remote-child.ts";

export interface BoxCommandResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_CAP = 256 * 1024;
/** An install downloads a CLI: generous, still bounded. */
export const BOX_INSTALL_TIMEOUT_MS = 10 * 60_000;

/** Run one short command in the box and collect its output. Rejects only on a spawn failure or the deadline. */
export async function runInBox(
  connection: BoxConnection,
  input: {
    command: string;
    args?: readonly string[];
    env?: Record<string, string>;
    envUnset?: readonly string[];
    cwd?: string;
    stdin?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    label: string;
  }
): Promise<BoxCommandResult> {
  const cap = input.maxOutputBytes ?? DEFAULT_OUTPUT_CAP;
  const child = spawnBoxChild({
    connection,
    command: input.command,
    args: input.args ?? [],
    env: input.env ?? {},
    ...(input.envUnset !== undefined ? { envUnset: input.envUnset } : {}),
    cwd: input.cwd ?? connection.sys.home
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let outSize = 0;
  let errSize = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    if (outSize < cap) out.push(chunk.subarray(0, cap - outSize));
    outSize += chunk.length;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (errSize < cap) err.push(chunk.subarray(0, cap - errSize));
    errSize += chunk.length;
  });
  if (input.stdin !== undefined) child.stdin.end(input.stdin);
  else child.stdin.end();
  const reason = await withDeadline(child.exited, {
    label: input.label,
    timeoutMs: input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    onTimeout: () => void child.kill("SIGKILL")
  });
  if (reason.kind === "spawn-error") throw reason.error;
  return {
    code: reason.kind === "exit" ? reason.code : null,
    signal: reason.kind === "signal" ? reason.signal : null,
    stdout: Buffer.concat(out).toString("utf8"),
    stderr: Buffer.concat(err).toString("utf8")
  };
}

/** The directories a fresh box's installers put CLIs in, beside whatever the login shell says. */
function wellKnownBinDirs(connection: BoxConnection): string[] {
  const { os, home } = connection.sys;
  if (os === "win32") {
    return [joinBoxPath(os, home, "AppData", "Roaming", "npm"), joinBoxPath(os, home, ".local", "bin")];
  }
  return [
    joinBoxPath(os, home, ".local", "bin"),
    joinBoxPath(os, home, ".npm-global", "bin"),
    joinBoxPath(os, home, ".bun", "bin"),
    joinBoxPath(os, home, ".opencode", "bin"),
    joinBoxPath(os, home, ".cargo", "bin"),
    "/usr/local/bin",
    ...(os === "darwin" ? ["/opt/homebrew/bin"] : [])
  ];
}

const loginPaths = new WeakMap<BoxConnection, Promise<string>>();

/**
 * The PATH a login shell in the box has, plus the installers' usual bin
 * dirs — what a user's own terminal in the box resolves commands against.
 * Probed once per connection (and again after an install).
 */
export function boxLoginPath(connection: BoxConnection, options: { refresh?: boolean } = {}): Promise<string> {
  const cached = loginPaths.get(connection);
  if (cached !== undefined && options.refresh !== true) return cached;
  const probe = (async (): Promise<string> => {
    const { os } = connection.sys;
    const { delimiter } = boxPathSyntax(os);
    let reported = "";
    try {
      const result =
        os === "win32"
          ? await runInBox(connection, {
              command: "powershell.exe",
              args: ["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write($env:Path)"],
              label: "box login PATH"
            })
          : await runInBox(connection, {
              command: /(?:^|\/)(?:bash|zsh|sh|dash|ksh)$/.test(connection.sys.shell) ? connection.sys.shell : "/bin/sh",
              args: ["-lc", 'printf "%s" "$PATH"'],
              label: "box login PATH"
            });
      if (result.code === 0) reported = result.stdout.trim();
    } catch {
      // No login shell: the well-known dirs and the system defaults still resolve most installs.
    }
    const fallback = os === "win32" ? "C:\\Windows\\System32;C:\\Windows" : "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    const entries = [...(reported.length > 0 ? reported : fallback).split(delimiter), ...wellKnownBinDirs(connection)];
    const seen = new Set<string>();
    return entries.filter((entry) => entry.length > 0 && !seen.has(entry) && (seen.add(entry), true)).join(delimiter);
  })();
  loginPaths.set(connection, probe);
  probe.catch(() => loginPaths.delete(connection));
  return probe;
}

/** The absolute path `bin` resolves to in the box under `path`, or null. */
export async function resolveBoxCommand(connection: BoxConnection, bin: string, path: string): Promise<string | null> {
  const { os } = connection.sys;
  try {
    if (os === "win32") {
      const result = await runInBox(connection, {
        command: "where.exe",
        args: [bin],
        env: { Path: path },
        label: `box where ${bin}`
      });
      if (result.code !== 0) return null;
      const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
      return lines.find((line) => /\.(exe|cmd|bat)$/i.test(line)) ?? lines[0] ?? null;
    }
    const result = await runInBox(connection, {
      command: "/bin/sh",
      args: ["-c", 'command -v "$1"', "sh", bin],
      env: { PATH: path },
      label: `box command -v ${bin}`
    });
    const resolved = result.stdout.trim().split("\n")[0]?.trim() ?? "";
    return result.code === 0 && resolved.startsWith("/") ? resolved : null;
  } catch {
    return null;
  }
}

function registryEntry(adapter: AgentAdapterId): RegistryEntryDef | undefined {
  return (REGISTRY.agents as readonly RegistryEntryDef[]).find((entry) => entry.chat?.adapter === adapter);
}

const AGENT_LABELS: Record<AgentAdapterId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode"
};

/**
 * The agent CLI's absolute path in the box. A box without it gets it installed
 * now with the registry's own install command (the same one Settings → Agents
 * runs on the host), through the box's login PATH; a failed install is a
 * {@link BoxLaunchError} the chat shows.
 */
export async function ensureBoxAgentCli(
  connection: BoxConnection,
  adapter: AgentAdapterId,
  input: { path: string; env?: Record<string, string>; onProgress?: (message: string) => void }
): Promise<{ bin: string; path: string; installed: boolean }> {
  const entry = registryEntry(adapter);
  const label = AGENT_LABELS[adapter];
  const bins = entry ? [...entry.bin] : [adapter];
  for (const bin of bins) {
    const found = await resolveBoxCommand(connection, bin, input.path);
    if (found !== null) return { bin: found, path: input.path, installed: false };
  }
  const os = connection.sys.os;
  const command = os === "win32" ? (entry?.installCmdWin32 ?? entry?.installCmd) : entry?.installCmd;
  if (command === undefined) {
    throw new BoxLaunchError("BOX_CLI_INSTALL_FAILED", `${label} is not installed in the box, and Orquester has no installer for it.`);
  }
  input.onProgress?.(`Installing ${label} in the box…`);
  let result: BoxCommandResult;
  try {
    result = await runInBox(connection, {
      command: os === "win32" ? "powershell.exe" : "/bin/sh",
      args: os === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-lc", command],
      env: { ...(input.env ?? {}), [os === "win32" ? "Path" : "PATH"]: input.path },
      timeoutMs: BOX_INSTALL_TIMEOUT_MS,
      label: `install ${label} in the box`
    });
  } catch (error) {
    throw new BoxLaunchError("BOX_CLI_INSTALL_FAILED", `${label} is not installed in the box, and installing it failed: ${describeBoxFailure(error)}`);
  }
  if (result.code !== 0) {
    const tail = result.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
    throw new BoxLaunchError(
      "BOX_CLI_INSTALL_FAILED",
      `${label} is not installed in the box, and \`${command}\` failed there${tail.length > 0 ? `: ${tail}` : "."} Install it in the box's terminal, then send the message again.`
    );
  }
  // An installer may have added a bin dir (npm's global prefix): read the PATH again.
  const refreshed = await boxLoginPath(connection, { refresh: true });
  const prefixPath = await npmGlobalBin(connection, refreshed);
  const path = prefixPath !== null ? `${refreshed}${boxPathSyntax(os).delimiter}${prefixPath}` : refreshed;
  for (const bin of bins) {
    const found = await resolveBoxCommand(connection, bin, path);
    if (found !== null) return { bin: found, path, installed: true };
  }
  throw new BoxLaunchError(
    "BOX_CLI_INSTALL_FAILED",
    `${label} was installed in the box but \`${bins[0]}\` is still not on its PATH. Open the box's terminal to check the install, then send the message again.`
  );
}

/** `npm prefix -g`'s bin dir, when npm is there. */
async function npmGlobalBin(connection: BoxConnection, path: string): Promise<string | null> {
  const { os } = connection.sys;
  try {
    const result = await runInBox(connection, {
      command: os === "win32" ? "powershell.exe" : "/bin/sh",
      args: os === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", "npm prefix -g"] : ["-c", "npm prefix -g"],
      env: { [os === "win32" ? "Path" : "PATH"]: path },
      label: "box npm prefix"
    });
    const prefix = result.stdout.trim();
    if (result.code !== 0 || prefix.length === 0) return null;
    return os === "win32" ? prefix : joinBoxPath(os, prefix, "bin");
  } catch {
    return null;
  }
}

/** `<bin> --version` in the box: its first line, or null. */
export async function probeBoxVersion(
  connection: BoxConnection,
  input: { bin: string; env: Record<string, string>; envUnset?: readonly string[]; args?: readonly string[] }
): Promise<string | null> {
  try {
    const result = await runInBox(connection, {
      command: input.bin,
      args: input.args ?? ["--version"],
      env: input.env,
      ...(input.envUnset !== undefined ? { envUnset: input.envUnset } : {}),
      label: "box --version"
    });
    if (result.code !== 0) return null;
    const line = result.stdout.trim().split("\n")[0]?.trim() ?? "";
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}
