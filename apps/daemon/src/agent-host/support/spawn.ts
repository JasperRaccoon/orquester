/**
 * Agent host — provider child processes (spec §3.1 "Supervision of provider
 * children").
 *
 * Every child is spawned with an EXPLICIT env (see `env.ts` — never a spread
 * of `process.env`), its exit code is watched, and killing is SIGTERM then
 * SIGKILL after a grace deadline. Where the child spawns its own server the
 * whole process **group** is signalled, not just the direct child (§4.5
 * OpenCode).
 *
 * There is **no restart backoff, by construction** (§3.1): a child that exits
 * is not respawned. The thread's session becomes `stopped`/`error` and the
 * next `sendTurn` starts a fresh one from the persisted cursor. A retry loop
 * would burn an account's rate limit against a problem — a missing binary, a
 * stale login — that only a user action fixes.
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** SIGTERM, then SIGKILL after this long (§3.1 "a short grace"). */
export const DEFAULT_KILL_GRACE_MS = 2_000;

export interface SpawnProviderChildOptions {
  /** Absolute path to the resolved binary. Never a bare name or an npm shim. */
  command: string;
  args: readonly string[];
  /** The complete environment. Build it with `buildProviderEnv`. */
  env: Record<string, string>;
  cwd: string;
  /**
   * Put the child in its own process group so a kill signals the whole tree.
   *
   * **Defaults to true on POSIX**, and that default is load-bearing: a
   * provider CLI starts MCP servers of its own, and signalling only the direct
   * child leaves them running and reparented to init — one orphaned server per
   * chat session, for the life of the box (E20). A group leader's `kill(-pid)`
   * takes them with it. Pass `false` only for a child that must outlive the
   * signal, and say why. Ignored on Windows, which has no process groups.
   */
  detached?: boolean;
  /** Overrides {@link DEFAULT_KILL_GRACE_MS} for this child. */
  killGraceMs?: number;
}

export type ChildExitReason =
  | { kind: "exit"; code: number; signal: null }
  | { kind: "signal"; code: null; signal: NodeJS.Signals }
  | { kind: "spawn-error"; code: null; signal: null; error: Error };

export interface ProviderChild {
  /** The recorded pid. `undefined` only when the spawn itself failed. */
  readonly pid: number | undefined;
  readonly stdin: ChildProcessWithoutNullStreams["stdin"];
  readonly stdout: ChildProcessWithoutNullStreams["stdout"];
  readonly stderr: ChildProcessWithoutNullStreams["stderr"];
  /** The underlying handle, for callers that need `once`/`ref`. */
  readonly process: ChildProcessWithoutNullStreams;
  /**
   * Resolves exactly once with how the child ended. Never rejects — a spawn
   * failure is an outcome, not an exception, because the caller has to settle
   * the turn either way (§3.1 "A dead child never leaves a running turn").
   */
  readonly exited: Promise<ChildExitReason>;
  /** True once {@link exited} has resolved. */
  readonly hasExited: () => boolean;
  /** The resolved exit reason, or null while the child is alive. */
  readonly exitReason: () => ChildExitReason | null;
  /**
   * SIGTERM, then SIGKILL after the grace deadline. Idempotent, and safe to
   * call after the child has already gone. Resolves once the child is really
   * gone.
   */
  readonly kill: (signal?: NodeJS.Signals) => Promise<ChildExitReason>;
}

/**
 * Spawn a provider child. `stdio` is always `pipe` on all three streams:
 * stderr is **captured, not discarded** (§3.1), and a stdio pipe for stdin is
 * what every one of the four protocols needs.
 */
export function spawnProviderChild(options: SpawnProviderChildOptions): ProviderChild {
  const { command, args, env, cwd, killGraceMs } = options;
  // Group-leading is the default; see `detached`'s note (E20).
  const detached = options.detached ?? true;
  const grace = killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  const child = nodeSpawn(command, [...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: detached && process.platform !== "win32",
    // Never a shell: an arg that happens to contain a metacharacter must reach
    // the binary verbatim, and there is nothing here that needs a shell.
    shell: false,
    windowsHide: true
  }) as ChildProcessWithoutNullStreams;

  const pid = child.pid;
  let reason: ChildExitReason | null = null;
  let settle!: (value: ChildExitReason) => void;
  const exited = new Promise<ChildExitReason>((resolve) => {
    settle = resolve;
  });

  const finish = (next: ChildExitReason): void => {
    if (reason !== null) {
      return;
    }
    reason = next;
    settle(next);
  };

  child.once("error", (error: Error) => {
    finish({ kind: "spawn-error", code: null, signal: null, error });
  });
  child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
    if (signal !== null) {
      finish({ kind: "signal", code: null, signal });
    } else {
      finish({ kind: "exit", code: code ?? 0, signal: null });
    }
  });
  // Deliberately NOT unref'd: the exit watcher above is what settles the
  // in-flight turn and closes every live task (§3.1), so the host must stay
  // awake long enough to observe the exit. Every child is owned by a session
  // scope, and stopping the host closes every scope — there is no path by
  // which a forgotten child keeps the process alive.

  let killing: Promise<ChildExitReason> | null = null;

  const signalTree = (signal: NodeJS.Signals): void => {
    if (pid === undefined) {
      return;
    }
    try {
      if (detached && process.platform !== "win32") {
        // Negative pid = the whole process group, which is what catches a
        // child that spawned its own server (§4.5 OpenCode).
        process.kill(-pid, signal);
        return;
      }
      child.kill(signal);
    } catch {
      // ESRCH: already gone. Any other failure is equally not actionable here
      // — the exit watcher is what decides the outcome.
    }
  };

  const kill = (signal: NodeJS.Signals = "SIGTERM"): Promise<ChildExitReason> => {
    if (reason !== null) {
      return Promise.resolve(reason);
    }
    if (killing !== null) {
      return killing;
    }
    signalTree(signal);
    const timer = setTimeout(() => {
      if (reason === null) {
        signalTree("SIGKILL");
      }
    }, grace);
    timer.unref?.();
    killing = exited.finally(() => {
      clearTimeout(timer);
    });
    return killing;
  };

  return {
    pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    process: child,
    exited,
    hasExited: () => reason !== null,
    exitReason: () => reason,
    kill
  };
}

/**
 * The §3.1 exit rule, in one place: a non-zero exit puts the session in
 * `error` and a zero exit in `stopped`; a host-initiated close is `graceful`
 * whatever the code.
 */
export function exitOutcome(
  reason: ChildExitReason,
  hostInitiated: boolean
): { status: "stopped" | "error"; exitKind: "graceful" | "error"; reason?: string } {
  if (hostInitiated) {
    return { status: "stopped", exitKind: "graceful", reason: describeExit(reason) };
  }
  if (reason.kind === "exit" && reason.code === 0) {
    return { status: "stopped", exitKind: "graceful", reason: describeExit(reason) };
  }
  return { status: "error", exitKind: "error", reason: describeExit(reason) };
}

export function describeExit(reason: ChildExitReason): string {
  switch (reason.kind) {
    case "exit":
      return `exited with code ${reason.code}`;
    case "signal":
      return `killed by ${reason.signal}`;
    case "spawn-error":
      return `failed to spawn: ${reason.error.message}`;
  }
}
