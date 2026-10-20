/**
 * Agent host — the Agent SDK's `spawnClaudeCodeProcess` hook for a box
 * (spec 2026-10-19 §8.5; `@anthropic-ai/claude-agent-sdk` 0.3.278,
 * `sdk.d.ts:2343`, `SpawnedProcess` / `SpawnOptions`).
 *
 * The SDK still builds the command, flags, cwd and env; this runs them in the
 * box as a detached process ({@link spawnBoxChild}) and answers the
 * `SpawnedProcess` the SDK's `ProcessTransport` drives. What that transport
 * relies on, read off the SDK's own code, and kept here exactly:
 *
 * - `exitCode` / `signalCode` are null while the process runs and are set
 *   BEFORE `exit` is emitted (its `close()` reads them to decide whether an
 *   exit was already delivered).
 * - `killed` turns true once a signal was sent, as `ChildProcess.killed`
 *   does (`waitForExit` returns early on `killed && exitEventDelivered`).
 * - `kill(signal)` sends that ONE signal now and answers false once the
 *   process has ended: `close()` escalates by itself (stdin EOF, SIGTERM after
 *   ~2 s, SIGKILL 5 s later while `exitCode === null` — which a signal death
 *   leaves null, so a late SIGKILL must be a harmless `false`).
 * - `exit` is emitted once with `(code, signal)`; a spawn failure is `error`
 *   with a `spawn …` syscall (the SDK reads that as "failed to spawn") and no
 *   `exit`, as Node's own child does.
 * - The SDK never reads stderr from a custom spawner, so the box's stderr is
 *   handed to the session's own `stderr` callback here — the capture and
 *   redaction of §3.1 still see every line.
 * - The forwarded `signal` aborts only after the SDK's graceful window, so an
 *   abort is a SIGTERM to the box process, like Node's `spawn({signal})`.
 */

import { EventEmitter } from "node:events";

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import type { BoxConnection } from "../../boxes/contracts.ts";
import { spawnBoxChild, type BoxProviderChild } from "./remote-child.ts";

export interface BoxClaudeSpawnOptions {
  connection: BoxConnection;
  /** One detached process id per launch (survives a dropped link). */
  procId: () => string;
  /** The session's stderr capture. */
  stderr?: (data: string) => void;
  /** Removed from `orq-agent`'s own environment (`box-env.ts`'s `unset`). */
  envUnset?: readonly string[];
  onNotice?: (message: string) => void;
  /** Overrides the reattach deadline (tests). */
  reattachTimeoutMs?: number;
}

/** A `SpawnedProcess` over a box process. */
export class BoxClaudeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin: SpawnedProcess["stdin"];
  readonly stdout: SpawnedProcess["stdout"];
  private killedFlag = false;
  private code: number | null = null;
  private signalValue: NodeJS.Signals | null = null;

  constructor(readonly child: BoxProviderChild, stderr: ((data: string) => void) | undefined) {
    super();
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      try {
        stderr?.(chunk);
      } catch {
        // The capture is best-effort; the process goes on.
      }
    });
    void child.exited.then((reason) => {
      if (reason.kind === "spawn-error") {
        const error = Object.assign(new Error(reason.error.message), {
          syscall: "spawn claude",
          code: (reason.error as NodeJS.ErrnoException).code ?? "ESPAWN"
        });
        // Emitted only to a listener: an unhandled `error` would end the host.
        if (this.listenerCount("error") > 0) this.emit("error", error);
        return;
      }
      this.code = reason.kind === "exit" ? reason.code : null;
      this.signalValue = reason.kind === "signal" ? reason.signal : null;
      this.emit("exit", this.code, this.signalValue);
    });
  }

  get killed(): boolean {
    return this.killedFlag;
  }

  get exitCode(): number | null {
    return this.code;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.signalValue;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.child.hasExited()) return false;
    const sent = this.child.signal(signal);
    if (sent) this.killedFlag = true;
    return sent;
  }
}

/**
 * The `spawnClaudeCodeProcess` option for one box launch. `command`, `args`,
 * `cwd` and `env` arrive already box-shaped: the adapter handed the SDK the
 * box's `claude`, the box cwd and the box env (`boxes/env.ts`).
 */
export function boxClaudeSpawner(options: BoxClaudeSpawnOptions): (spawn: SpawnOptions) => SpawnedProcess {
  return (spawn: SpawnOptions): SpawnedProcess => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(spawn.env)) {
      if (value !== undefined) env[key] = value;
    }
    const child = spawnBoxChild({
      connection: options.connection,
      command: spawn.command,
      args: spawn.args,
      env,
      ...(options.envUnset !== undefined ? { envUnset: options.envUnset.filter((name) => env[name] === undefined) } : {}),
      cwd: spawn.cwd ?? options.connection.sys.home,
      detach: { procId: options.procId() },
      ...(options.onNotice !== undefined ? { onNotice: options.onNotice } : {}),
      ...(options.reattachTimeoutMs !== undefined ? { reattachTimeoutMs: options.reattachTimeoutMs } : {})
    });
    const process = new BoxClaudeProcess(child, options.stderr);
    const onAbort = (): void => {
      process.kill("SIGTERM");
    };
    if (spawn.signal.aborted) {
      onAbort();
    } else {
      spawn.signal.addEventListener("abort", onAbort, { once: true });
      void child.exited.then(() => spawn.signal.removeEventListener("abort", onAbort));
    }
    return process;
  };
}
