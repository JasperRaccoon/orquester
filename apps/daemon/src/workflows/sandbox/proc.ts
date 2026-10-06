// Automated workflows — process identity for the sandbox (spec §5.6, §5.8).
//
// A sandbox attempt is identified by (pid, starttime): the pid alone is recycled, `/proc/<pid>/stat`
// field 22 is invariant for the life of a process — the kill guard's rule (`system-status.ts`).
// Linux-only by construction; elsewhere the starttime is 0 and liveness falls back to
// `process.kill(pid, 0)`, which cannot tell a recycled pid from ours.

import { readFileSync } from "node:fs";

import { parseStat } from "../../agent-host/support/leftover-processes.ts";

const HAS_PROC = process.platform === "linux";

/** State + starttime of a pid off `/proc/<pid>/stat`, or null when it is gone/unreadable. */
function readProcStat(pid: number): { state: string; starttime: number } | null {
  if (!HAS_PROC || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  let content: string;
  try {
    content = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const stat = parseStat(content);
  return stat === null ? null : { state: stat.state, starttime: stat.starttime };
}

/** Field 22 of `/proc/<pid>/stat`; 0 off Linux or when unreadable. */
export function readStarttime(pid: number): number {
  return readProcStat(pid)?.starttime ?? 0;
}

function gone(state: string): boolean {
  return state === "Z" || state === "X" || state === "x";
}

/** Is (pid, starttime) still the same, running process? A zombie is gone. */
export function isSameProcessAlive(pid: number, starttime: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (HAS_PROC && starttime > 0) {
    const stat = readProcStat(pid);
    return stat !== null && !gone(stat.state) && stat.starttime === starttime;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Signal the process GROUP led by `pgid`, but only while it can still be ours: the leader is the
 * recorded (pid, starttime), or the leader is gone — a pid that still names a live process group
 * is never handed to a new process, so an empty `/proc/<pgid>` means no other group can hold that
 * id. A leader whose starttime moved is somebody else's and is left alone. Returns whether a
 * signal was delivered.
 */
export function signalGroupIfOurs(pgid: number, starttime: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) {
    return false;
  }
  if (HAS_PROC && starttime > 0) {
    const stat = readProcStat(pgid);
    if (stat !== null && stat.starttime !== starttime) {
      return false;
    }
  }
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}
