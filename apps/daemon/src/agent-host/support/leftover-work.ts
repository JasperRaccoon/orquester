/**
 * Agent host — the user's work a provider's earlier launches of one thread
 * left running, remembered until the USER ends the thread's session
 * (AGENTS.md, "What a Grok CLI starts outlives it").
 *
 * A Grok session's end stops the work its agent started — its shells, the
 * dev servers they run — only when the user ends it: at a deploy, a restart or
 * a crash that work runs on, because a deploy must never kill running work.
 * So a LATER user end — the session stop command, a closed tab — must still
 * reach what those launches left: each launch's task sessions, recorded while
 * its CLI lived (the session's id and its leader's starttime) under the
 * launch's marker, are kept here, and that end sweeps every one of them with
 * the identity checks a live sweep makes ({@link stopLeftoverProcesses}: the
 * marker exactly, the recorded session, the leader that was recorded, a
 * starttime check before each signal).
 *
 * The file — `<thread dir>/leftover-work.json`, 0600, rewritten atomically,
 * and only while the thread's directory exists (a late record must not raise
 * a thread the store deleted) — is the adapter's own: never `binding.json`,
 * which has one writer. It is
 * bounded — the newest {@link LEFTOVER_WORK_LAUNCHES} launches,
 * {@link LEFTOVER_WORK_SESSIONS} sessions each — and read entry-wise
 * tolerantly: a file this host did not write reads as nothing. Losing it loses
 * only the later sweep, never correctness: Settings → System lists and kills
 * every marked orphan whatever this file says.
 */

import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { readFileOrNull } from "../store/files.ts";
import {
  stopLeftoverProcesses,
  type LeftoverSweepResult,
  type RecordedSession,
  type StopLeftoversOptions
} from "./leftover-processes.ts";

/** The launches a thread remembers: the last few, newest last. */
export const LEFTOVER_WORK_LAUNCHES = 8;

/** The sessions one launch keeps: the newest, a bound on a runaway fleet of shells. */
export const LEFTOVER_WORK_SESSIONS = 64;

const LEFTOVER_WORK_VERSION = 1;

/** One launch's recorded task sessions. */
export interface LeftoverLaunch {
  /** The value its launch env gave the marker (`ORQUESTER_AGENT_LAUNCH`). */
  readonly launchId: string;
  /** When it was last recorded (ISO): informational only. */
  readonly recordedAt: string;
  readonly sessions: readonly RecordedSession[];
}

/** A pid above 1 — a session id is its leader's pid, and init leads no session of ours. */
function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 1;
}

function parseSession(value: unknown): RecordedSession | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const { sid, leaderStarttime } = value as Record<string, unknown>;
  if (!isPid(sid) || typeof leaderStarttime !== "number" || !Number.isFinite(leaderStarttime)) {
    return null;
  }
  return { sid, leaderStarttime };
}

function parseLaunch(value: unknown): LeftoverLaunch | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const { launchId, recordedAt, sessions } = value as Record<string, unknown>;
  if (typeof launchId !== "string" || launchId.length === 0 || !Array.isArray(sessions)) {
    return null;
  }
  const kept = sessions.map(parseSession).filter((session): session is RecordedSession => session !== null);
  return { launchId, recordedAt: typeof recordedAt === "string" ? recordedAt : "", sessions: kept };
}

/** The launches a file holds, oldest first; nothing for a file this host did not write. */
export function parseLeftoverWork(text: string | null): LeftoverLaunch[] {
  if (text === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") {
    return [];
  }
  const { version, launches } = parsed as Record<string, unknown>;
  if (version !== LEFTOVER_WORK_VERSION || !Array.isArray(launches)) {
    return [];
  }
  return launches.map(parseLaunch).filter((launch): launch is LeftoverLaunch => launch !== null);
}

export async function readLeftoverWork(path: string): Promise<LeftoverLaunch[]> {
  try {
    return parseLeftoverWork(await readFileOrNull(path));
  } catch {
    return [];
  }
}

/**
 * Rewrite `path` atomically (a sibling temp, fsync, rename over, 0600) ONLY
 * while its directory — the thread's — exists: `false`, having written
 * nothing, once the store deleted the thread. `atomicWriteFile` creates the
 * directory it writes into, and a record landing after a closed tab's
 * deletion recreated the thread's directory: a ghost the store's
 * `listThreads` would list at the next boot.
 */
async function writeIntoExistingDir(path: string, contents: string): Promise<boolean> {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(tmp, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  return true;
}

/** One writer per file at a time: a record and a sweep of one thread never interleave. */
const chains = new Map<string, Promise<unknown>>();

async function serialised<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(path) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.then(
    () => undefined,
    () => undefined
  );
  chains.set(path, settled);
  try {
    return await next;
  } finally {
    if (chains.get(path) === settled) {
      chains.delete(path);
    }
  }
}

/**
 * Remember a launch's task sessions: merged with what the launch recorded
 * before (by session id), the launch moved to the newest place, the oldest
 * launches dropped past the bound. Atomic and 0600, and only into a thread
 * directory that still exists ({@link writeIntoExistingDir}).
 */
export async function recordLeftoverWork(path: string, launch: LeftoverLaunch): Promise<void> {
  await serialised(path, async () => {
    const launches = await readLeftoverWork(path);
    const previous = launches.find((entry) => entry.launchId === launch.launchId);
    const sessions = new Map<number, RecordedSession>();
    for (const session of [...(previous?.sessions ?? []), ...launch.sessions]) {
      sessions.delete(session.sid);
      sessions.set(session.sid, { sid: session.sid, leaderStarttime: session.leaderStarttime });
    }
    const merged: LeftoverLaunch = {
      launchId: launch.launchId,
      recordedAt: launch.recordedAt,
      sessions: [...sessions.values()].slice(-LEFTOVER_WORK_SESSIONS)
    };
    const next = [...launches.filter((entry) => entry.launchId !== launch.launchId), merged].slice(
      -LEFTOVER_WORK_LAUNCHES
    );
    await writeIntoExistingDir(path, `${JSON.stringify({ version: LEFTOVER_WORK_VERSION, launches: next })}\n`);
  });
}

/**
 * The user ended the thread's session: stop everything its remembered
 * launches left running, each by its own marker in its own sessions — all
 * launches at once, so a close waits one grace window, not one per launch —
 * then forget them. Never rejects; what could not be read or signalled is
 * still in Settings → System.
 */
export async function sweepLeftoverWork(
  path: string,
  options: Omit<StopLeftoversOptions, "launchId" | "sessions"> = {}
): Promise<LeftoverSweepResult> {
  return await serialised(path, async () => {
    // Every launch at once: each sweep may wait out a SIGTERM grace and then a
    // SIGKILL's, and one after another eight launches kept a closing tab
    // waiting eight times as long. Their processes are disjoint — each sweep
    // takes only its own launch's marker — so nothing is signalled twice.
    const results = await Promise.all(
      (await readLeftoverWork(path)).map(async (launch) => {
        try {
          return await stopLeftoverProcesses({ ...options, launchId: launch.launchId, sessions: launch.sessions });
        } catch {
          // One launch that cannot be swept never keeps the others running.
          return { found: 0, terminated: 0, killed: 0 };
        }
      })
    );
    await rm(path, { force: true }).catch(() => undefined);
    return results.reduce(
      (totals, result) => ({
        found: totals.found + result.found,
        terminated: totals.terminated + result.terminated,
        killed: totals.killed + result.killed
      }),
      { found: 0, terminated: 0, killed: 0 }
    );
  });
}
