/**
 * Claude adapter — the Agent SDK's `spawnClaudeCodeProcess` hook for a local
 * session: the CLI the SDK would spawn, started through the host-death
 * lifeline (`support/lifeline.ts`) in a process group of its own.
 *
 * Without it the SDK spawns the CLI in the host's own process group, and a
 * CLI whose host died finishes its turn after its pipes close — beside the
 * turn the next host resumes.
 *
 * What the SDK's `ProcessTransport` needs is what Node's `ChildProcess`
 * already is (`stdin`, `stdout`, `killed`, `exitCode`, `signalCode`, `kill`,
 * `exit`): it is returned as is, as T3 does. Two things the SDK's own spawn
 * did are kept here:
 * - stderr: the SDK never reads it from a custom spawner, so it is handed to
 *   the session's `stderr` callback (the §3.1 capture);
 * - the abort `signal`, passed to `spawn` exactly as the SDK passes it.
 *
 * `kill()` signals the CLI alone, as before; the group is stopped by the
 * lifeline only when the host is gone. Windows has no lifeline: there the
 * option is not set and the SDK spawns as it always did.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import { lifelineLaunch, releaseLifeline } from "../../support/lifeline.ts";

/**
 * The hook for one session, or `undefined` where the lifeline does not apply.
 * `stderr` receives the CLI's stderr as text.
 */
export function claudeLifelineSpawner(
  stderr: (data: string) => void
): ((options: SpawnOptions) => SpawnedProcess) | undefined {
  if (lifelineLaunch("claude", [], {}) === null) return undefined;
  return (options: SpawnOptions): SpawnedProcess => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env)) {
      if (value !== undefined) env[key] = value;
    }
    const launch = lifelineLaunch(options.command, options.args, env)!;
    const child: ChildProcess = nodeSpawn(launch.command, launch.args, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      try {
        stderr(chunk);
      } catch {
        // The capture is best-effort; the CLI goes on.
      }
    });
    // Ended while the host lives: its watcher goes without signalling anything.
    child.once("exit", () => releaseLifeline(child.stdio[3]));
    // Node types stdin/stdout as nullable once stdio has a fourth entry; both are pipes.
    return child as unknown as SpawnedProcess;
  };
}
