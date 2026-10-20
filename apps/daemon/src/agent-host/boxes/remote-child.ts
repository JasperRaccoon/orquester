/**
 * Agent host — a provider child that runs in a box (spec 2026-10-19 §8.5):
 * the remote variant of `spawnProviderChild` (`support/spawn.ts`), with the
 * same {@link ProviderChild} shape, so a session drives it exactly as it
 * drives a local child.
 *
 * - The process is `orq-agent`'s (`BoxConnection.exec`). Its stdio are the
 *   channel's streams, re-exposed through pass-throughs that outlive any one
 *   channel.
 * - `kill()` is SIGTERM then SIGKILL on the grace deadline, sent to the box
 *   (`BoxProcess.kill`, or `proc.signal` while no channel is open). There is
 *   no local pid: `pid` is `undefined` and `box` names the process instead, so
 *   nothing on this machine ever signals it or reads its `/proc`, and no nice
 *   wrapper is applied.
 * - **Detached** (`detach`, every agent CLI): a dropped link — a daemon
 *   restart, a network blip — does not end the process. The box emits
 *   `detached`; this child waits for the link to come back and reattaches with
 *   `attach(procId, offset)`, where `offset` counts every stdout and stderr
 *   byte already received (the protocol's own offset, emission order).
 *   Input written meanwhile is held and delivered after the reattach. A link
 *   that does not come back within the reattach deadline ends the child as
 *   `SIGHUP`, as a dropped local terminal would.
 * - `exited` never rejects and resolves exactly once; a finished detached
 *   process is released (`proc.release`) so the box frees its buffer.
 */

import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import type { BoxDetachedProcInfo } from "@orquester/api";

import type { BoxConnection, BoxExecOptions, BoxProcess } from "../../boxes/contracts.ts";
import { DEFAULT_KILL_GRACE_MS, type ChildExitReason, type ProviderChild } from "../support/spawn.ts";

/** How long a detached child waits for its box link to come back (spec §9.2 decides the box's fate). */
export const BOX_REATTACH_DEADLINE_MS = 15 * 60_000;

/**
 * After the box reports the exit, how long the output streams may still take
 * to end. The protocol sends `exit` after all output, so this only bounds a
 * channel that never closes — a deadline, not a timing guess.
 */
const EXIT_DRAIN_GRACE_MS = 1_000;

export interface SpawnBoxChildOptions {
  connection: BoxConnection;
  /** The BOX path (or bare name resolved by the box's own PATH) of the executable. */
  command: string;
  args: readonly string[];
  /** Merged over `orq-agent`'s own environment (box-shaped: `boxes/env.ts`). */
  env: Record<string, string>;
  /** Removed from `orq-agent`'s environment first. */
  envUnset?: readonly string[];
  /** BOX path. */
  cwd: string;
  /** Overrides {@link DEFAULT_KILL_GRACE_MS}. */
  killGraceMs?: number;
  /** Keep running across disconnects under this id (agent CLIs). Omitted: a short command. */
  detach?: { procId: string; bufferBytes?: number };
  /** Overrides {@link BOX_REATTACH_DEADLINE_MS}. */
  reattachTimeoutMs?: number;
  /** One line for the session's log: a detach, a reattach, a lost process. Never output bytes. */
  onNotice?: (message: string) => void;
}

/** A {@link ProviderChild} running in a box. */
export interface BoxProviderChild extends ProviderChild {
  readonly box: { readonly boxId: string; readonly procId: string };
  /** Send one signal now, without the escalation `kill()` arms. False once the child has ended. */
  signal(signal: NodeJS.Signals): boolean;
}

function exitOf(code: number | null, signal: NodeJS.Signals | string | null): ChildExitReason {
  if (signal !== null && signal !== undefined) {
    return { kind: "signal", code: null, signal: signal as NodeJS.Signals };
  }
  return { kind: "exit", code: code ?? 0, signal: null };
}

/** Spawn `command` in the box. Never throws: a refused spawn is a `spawn-error` outcome. */
export function spawnBoxChild(options: SpawnBoxChildOptions): BoxProviderChild {
  const { connection } = options;
  const grace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const procId = options.detach?.procId ?? `exec-${randomUUID()}`;
  const notice = (message: string): void => {
    try {
      options.onNotice?.(message);
    } catch {
      // A failing logger must not change the child's outcome.
    }
  };

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  // Nothing flows until a process is attached; a write meanwhile is held.
  stdin.pause();

  let reason: ChildExitReason | null = null;
  let settle!: (value: ChildExitReason) => void;
  const exited = new Promise<ChildExitReason>((resolve) => {
    settle = resolve;
  });

  /** The process the streams are wired to now; null while detached. */
  let current: BoxProcess | null = null;
  let unhookCurrent: (() => void) | null = null;
  /** stdout + stderr bytes received, the reattach offset. */
  let received = 0;
  let stdinEnded = false;
  /** A signal asked for while no channel could carry it. */
  let pendingSignal: NodeJS.Signals | null = null;
  let stopWaiting: (() => void) | null = null;

  const finish = (next: ChildExitReason): void => {
    if (reason !== null) return;
    reason = next;
    unhookCurrent?.();
    unhookCurrent = null;
    current = null;
    stopWaiting?.();
    stopWaiting = null;
    stdout.end();
    stderr.end();
    stdin.resume();
    settle(next);
    if (options.detach !== undefined) {
      void connection.request("proc.release", { procId }).catch(() => undefined);
    }
  };

  stdin.on("data", (chunk: Buffer) => {
    const target = current;
    if (target === null) return;
    if (!target.stdin.write(chunk)) {
      stdin.pause();
      target.stdin.once("drain", () => {
        if (current === target) stdin.resume();
      });
    }
  });
  stdin.on("end", () => {
    stdinEnded = true;
    current?.stdin.end();
  });
  stdin.on("error", () => undefined);

  /** Settle a detached process the box no longer streams: from its last known state. */
  const settleFromBox = async (why: string): Promise<void> => {
    const listed = (await connection.request("proc.list", {}).catch(() => null)) as BoxDetachedProcInfo[] | null;
    const entry = listed?.find((proc) => proc.procId === procId);
    if (entry !== undefined && !entry.running) {
      finish(exitOf(entry.exitCode, entry.signal));
      return;
    }
    notice(`box process ${procId}: ${why}`);
    finish({ kind: "signal", code: null, signal: "SIGHUP" });
  };

  const hook = (proc: BoxProcess, mode: "spawn" | "attach"): void => {
    let opened = false;
    let outEnded = false;
    let errEnded = false;
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;

    const maybeFinish = (): void => {
      if (exitInfo !== null && outEnded && errEnded) finish(exitOf(exitInfo.code, exitInfo.signal));
    };
    const onOut = (chunk: Buffer): void => {
      opened = true;
      received += chunk.length;
      stdout.write(chunk);
    };
    const onErr = (chunk: Buffer): void => {
      opened = true;
      received += chunk.length;
      stderr.write(chunk);
    };
    const onOutEnd = (): void => {
      outEnded = true;
      maybeFinish();
    };
    const onErrEnd = (): void => {
      errEnded = true;
      maybeFinish();
    };
    const onSpawn = (): void => {
      opened = true;
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      exitInfo = { code, signal };
      maybeFinish();
      if (reason === null) {
        drainTimer = setTimeout(() => finish(exitOf(code, signal)), EXIT_DRAIN_GRACE_MS);
      }
    };
    const onError = (error: Error): void => {
      if (reason !== null) return;
      if (!opened) {
        if (mode === "spawn") {
          finish({ kind: "spawn-error", code: null, signal: null, error });
        } else {
          // The box refused the reattach: the process is gone, or another channel holds it.
          unhook();
          void settleFromBox(`the box refused the reattach (${error.message})`);
        }
        return;
      }
      notice(`box process ${procId}: ${error.message}`);
    };
    const onDetached = (): void => {
      unhook();
      waitForLink();
    };
    const unhook = (): void => {
      proc.stdout.off("data", onOut);
      proc.stderr.off("data", onErr);
      proc.stdout.off("end", onOutEnd);
      proc.stderr.off("end", onErrEnd);
      proc.off("spawn", onSpawn);
      proc.off("exit", onExit);
      proc.off("error", onError);
      proc.off("detached", onDetached);
      if (drainTimer !== null) clearTimeout(drainTimer);
      if (current === proc) {
        current = null;
        unhookCurrent = null;
        stdin.pause();
      }
    };

    proc.stdout.on("data", onOut);
    proc.stderr.on("data", onErr);
    proc.stdout.once("end", onOutEnd);
    proc.stderr.once("end", onErrEnd);
    proc.stdin.on("error", () => undefined);
    proc.on("spawn", onSpawn);
    proc.on("exit", onExit);
    proc.on("error", onError);
    proc.on("detached", onDetached);
    current = proc;
    unhookCurrent = unhook;
    if (stdinEnded) proc.stdin.end();
    stdin.resume();
    if (pendingSignal !== null) {
      const signal = pendingSignal;
      pendingSignal = null;
      proc.kill(signal);
    }
  };

  /** The link dropped under a detached process: reattach when it is back, within the deadline. */
  const waitForLink = (): void => {
    if (reason !== null) return;
    notice(`box process ${procId}: the box link dropped; waiting to reattach`);
    let attaching = false;
    const attachNow = (): void => {
      if (attaching || reason !== null || !connection.connected) return;
      attaching = true;
      let next: BoxProcess;
      try {
        next = connection.attach(procId, received);
      } catch (error) {
        attaching = false;
        void settleFromBox(`the reattach failed (${error instanceof Error ? error.message : String(error)})`);
        return;
      }
      stopWaiting?.();
      stopWaiting = null;
      notice(`box process ${procId}: reattached at offset ${received}`);
      hook(next, "attach");
    };
    const unsubscribe = connection.onStatus((connected) => {
      if (connected) attachNow();
    });
    const deadline = setTimeout(() => {
      stopWaiting?.();
      stopWaiting = null;
      notice(`box process ${procId}: the box did not come back in time`);
      finish({ kind: "signal", code: null, signal: "SIGHUP" });
    }, options.reattachTimeoutMs ?? BOX_REATTACH_DEADLINE_MS);
    stopWaiting = () => {
      unsubscribe();
      clearTimeout(deadline);
    };
    attachNow();
  };

  const exec: BoxExecOptions = {
    command: options.command,
    args: [...options.args],
    cwd: options.cwd,
    env: options.env,
    ...(options.envUnset !== undefined && options.envUnset.length > 0 ? { envUnset: [...options.envUnset] } : {}),
    ...(options.detach !== undefined ? { detach: { ...options.detach } } : {})
  };
  try {
    hook(connection.exec(exec), "spawn");
  } catch (error) {
    finish({
      kind: "spawn-error",
      code: null,
      signal: null,
      error: error instanceof Error ? error : new Error(String(error))
    });
  }

  const sendSignal = (signal: NodeJS.Signals): boolean => {
    if (reason !== null) return false;
    const proc = current;
    if (proc !== null && connection.connected) {
      return proc.kill(signal);
    }
    if (options.detach !== undefined && connection.connected) {
      void connection.request("proc.signal", { procId, signal }).catch(() => {
        pendingSignal = signal;
      });
      return true;
    }
    // Delivered as soon as a channel carries the process again.
    pendingSignal = signal;
    return true;
  };

  let killing: Promise<ChildExitReason> | null = null;
  const kill = (signal: NodeJS.Signals = "SIGTERM"): Promise<ChildExitReason> => {
    if (reason !== null) return Promise.resolve(reason);
    if (killing !== null) return killing;
    sendSignal(signal);
    const timer = setTimeout(() => {
      if (reason === null) sendSignal("SIGKILL");
    }, grace);
    timer.unref?.();
    killing = exited.finally(() => {
      clearTimeout(timer);
    });
    return killing;
  };

  return {
    pid: undefined,
    stdin,
    stdout,
    stderr,
    process: null,
    exited,
    hasExited: () => reason !== null,
    exitReason: () => reason,
    kill,
    signal: sendSignal,
    box: { boxId: connection.boxId, procId }
  };
}
