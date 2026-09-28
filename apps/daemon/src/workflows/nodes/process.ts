// Automated workflows — running one sandbox attempt for a code or shell block, resumable across a
// daemon restart through the `process` WaitingOn (spec §5.6, §5.8).

import type { NodeExecutionContext, SandboxExit, SandboxHandle, SandboxSpawnRequest } from "../contracts.ts";

export type ProcessOutcome =
  | { kind: "exit"; exit: SandboxExit & { interrupted?: boolean; cancelled?: boolean; error?: string } }
  /** The runner is gone and left no record of its end. */
  | { kind: "lost" }
  | { kind: "spawn-failed"; message: string };

type Spawnable = Omit<SandboxSpawnRequest, "attemptDir" | "runId" | "workflowId" | "timeoutMs">;

/**
 * Spawn (or, after a restart, re-attach to) the attempt's process and wait for its end. The
 * process's identity is persisted as the block's WaitingOn right after the spawn.
 */
export async function runSandboxAttempt<T extends "code" | "shell">(ctx: NodeExecutionContext<T>, spawn: Spawnable): Promise<ProcessOutcome> {
  const sandbox = ctx.services.sandbox;
  const resume = ctx.resumeFrom?.kind === "process" ? ctx.resumeFrom : undefined;
  let handle: SandboxHandle;
  let deadlineAt: Date;
  if (resume) {
    deadlineAt = new Date(resume.deadlineAt);
    if (resume.spawning) {
      // The restart came between the pre-spawn marker and the handle: adopt the runner the spawn
      // recorded in handle.json, else read its exit; never spawn a second one.
      const recorded = await sandbox.readHandle(resume.attemptDir);
      if (recorded === null) {
        const exit = await sandbox.readExit(resume.attemptDir);
        await ctx.setWaitingOn(undefined);
        return exit ? { kind: "exit", exit } : { kind: "lost" };
      }
      handle = recorded;
      await ctx.setWaitingOn({
        kind: "process",
        pid: handle.pid,
        starttime: handle.starttime,
        attemptDir: handle.attemptDir,
        deadlineAt: deadlineAt.toISOString()
      });
    } else {
      handle = { pid: resume.pid, starttime: resume.starttime, attemptDir: resume.attemptDir };
    }
    if (!sandbox.isAlive(handle)) {
      const exit = await sandbox.readExit(handle.attemptDir);
      await ctx.setWaitingOn(undefined);
      return exit ? { kind: "exit", exit } : { kind: "lost" };
    }
  } else {
    const attemptDir = await ctx.attemptDir();
    deadlineAt = new Date(ctx.services.clock.now().getTime() + ctx.timeoutMs);
    // On disk BEFORE the spawn: a restart in between finds the runner through handle.json.
    await ctx.setWaitingOn({ kind: "process", pid: 0, starttime: 0, attemptDir, deadlineAt: deadlineAt.toISOString(), spawning: true });
    try {
      handle = await sandbox.spawn({
        ...spawn,
        attemptDir,
        timeoutMs: ctx.timeoutMs,
        runId: ctx.runId,
        workflowId: ctx.workflow.id
      });
    } catch (error) {
      return { kind: "spawn-failed", message: error instanceof Error ? error.message : String(error) };
    }
    await ctx.setWaitingOn({
      kind: "process",
      pid: handle.pid,
      starttime: handle.starttime,
      attemptDir: handle.attemptDir,
      deadlineAt: deadlineAt.toISOString()
    });
  }
  const exit = await sandbox.wait(handle, {
    deadlineAt,
    signal: ctx.signal,
    onLogs: (bytes) => ctx.update({ logs: { stdoutBytes: bytes.stdout, stderrBytes: bytes.stderr } })
  });
  ctx.update({ logs: { stdoutBytes: exit.stdoutBytes, stderrBytes: exit.stderrBytes } });
  await ctx.setWaitingOn(undefined);
  return { kind: "exit", exit };
}

/** "30 minutes", "2 hours" — for a timeout message. */
export function describeDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))} seconds`;
  if (minutes % 60 === 0 && minutes >= 60) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
