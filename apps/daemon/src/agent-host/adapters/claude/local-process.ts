/**
 * Claude adapter — the Agent SDK's `spawnClaudeCodeProcess` hook for a local
 * session: the CLI the SDK would spawn, started through the host-death
 * lifeline (`support/lifeline.ts`) in a process group of its own.
 *
 * Without it the SDK spawns the CLI in the host's own process group, and a
 * CLI whose host died finishes its turn after its pipes close — beside the
 * turn the next host resumes.
 *
 * What the SDK's `ProcessTransport` needs is Node's `ChildProcess` (`stdin`,
 * `stdout`, `killed`, `exitCode`, `signalCode`, `kill`, `exit`, `error`),
 * read through {@link ClaudeLocalProcess}. Three things the SDK's own spawn
 * did are kept here:
 * - stderr: the SDK never reads it from a custom spawner, so it is handed to
 *   the session's `stderr` callback (the §3.1 capture);
 * - `exit` waits for stderr to close, at most {@link EXIT_AFTER_STDERR_MS}
 *   (the SDK's `sdk-exit-after-stderr-drained`), so the CLI's last fatal line
 *   reaches the capture before the session handles the end of its stream;
 * - the abort `signal`, passed to `spawn` exactly as the SDK passes it.
 *
 * `kill()` signals the CLI alone, as before; the group is stopped by the
 * lifeline only when the host is gone. Windows has no lifeline: there the
 * option is not set and the SDK spawns as it always did.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import { lifelineLaunch, releaseLifeline } from "../../support/lifeline.ts";

/** How long `exit` may wait for stderr to close — the SDK's own spawner's cap (0.3.278). */
const EXIT_AFTER_STDERR_MS = 200;

/**
 * A `SpawnedProcess` over the lifeline-wrapped CLI: `ChildProcess` read through, except that
 * `exit` is emitted once stderr has closed (or {@link EXIT_AFTER_STDERR_MS} after the exit).
 * `exitCode` / `signalCode` read the child's own, as the SDK's spawner does.
 */
class ClaudeLocalProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin: SpawnedProcess["stdin"];
  readonly stdout: SpawnedProcess["stdout"];

  constructor(private readonly child: ChildProcess) {
    super();
    // Both are pipes; Node types them nullable once stdio has a fourth entry.
    this.stdin = child.stdin!;
    this.stdout = child.stdout!;
    let exited: [number | null, NodeJS.Signals | null] | null = null;
    let stderrClosed = child.stderr === null;
    let emitted = false;
    let timer: NodeJS.Timeout | undefined;
    const emitExit = (): void => {
      if (emitted || exited === null) return;
      emitted = true;
      clearTimeout(timer);
      this.emit("exit", ...exited);
    };
    child.stderr?.once("close", () => {
      stderrClosed = true;
      emitExit();
    });
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      exited = [code, signal];
      if (stderrClosed) {
        emitExit();
        return;
      }
      // A grandchild may hold stderr open: the exit is reported anyway.
      timer = setTimeout(emitExit, EXIT_AFTER_STDERR_MS);
      timer.unref?.();
    });
    child.on("error", (error: Error) => {
      // Emitted only to a listener: an unhandled `error` would end the host.
      if (this.listenerCount("error") > 0) this.emit("error", error);
    });
  }

  get killed(): boolean {
    return this.child.killed;
  }

  get exitCode(): number | null {
    return this.child.exitCode;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.child.signalCode;
  }

  /** The CLI's pid (the lifeline wrapper exec'd into it). */
  get pid(): number | undefined {
    return this.child.pid;
  }

  kill(signal: NodeJS.Signals): boolean {
    return this.child.kill(signal);
  }
}

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
    return new ClaudeLocalProcess(child);
  };
}
