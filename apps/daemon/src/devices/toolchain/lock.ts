/**
 * One install at a time per key: an in-process queue plus a lock directory (`<path>` holding the
 * owner's pid) so a second daemon on the same appdir waits too.
 *
 * The pid file is written atomically inside the dir (temp file + rename), so a reader never sees
 * half of it. A lock whose owner pid is gone is stale and taken over; a dir with no readable pid is
 * held while it is young (its owner may be between `mkdir` and the rename) and stale only after
 * {@link EMPTY_LOCK_STALE_MS}. A takeover renames the stale dir aside and removes it only if it is
 * still the same dir it judged (same inode), so it never removes a lock another daemon just took.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { delay, isProcessAlive } from "../android/procs.ts";

const queues = new Map<string, Promise<unknown>>();

/** A lock dir without a readable pid file is taken over only once it is this old. */
export const EMPTY_LOCK_STALE_MS = 30_000;
const POLL_MS = 500;

export type LockOwner = { state: "free" } | { state: "held" } | { state: "stale"; ino: number };

/** What the lock dir at `path` is now: free, held by a live owner (or too young to judge), or stale. */
export async function inspectLock(path: string, now = Date.now()): Promise<LockOwner> {
  const info = await stat(path).catch(() => null);
  if (!info) return { state: "free" };
  const owner = Number((await readFile(join(path, "pid"), "utf8").catch(() => "")).trim());
  if (Number.isInteger(owner) && owner > 0) {
    // Our own pid: a crashed earlier run of this pid (this process queues its own takers first).
    return owner !== process.pid && (await isProcessAlive(owner)) ? { state: "held" } : { state: "stale", ino: info.ino };
  }
  return now - info.mtimeMs > EMPTY_LOCK_STALE_MS ? { state: "stale", ino: info.ino } : { state: "held" };
}

/** Move a stale lock aside and remove it, unless it is no longer the dir that was judged. */
async function takeOver(path: string, ino: number): Promise<void> {
  const aside = `${path}.stale-${randomUUID().slice(0, 8)}`;
  try {
    await rename(path, aside);
  } catch {
    return; // gone already, or someone else moved it
  }
  const moved = await stat(aside).catch(() => null);
  if (moved && moved.ino !== ino) {
    // Another daemon took the lock in between: put its dir back.
    await rename(aside, path).catch(() => undefined);
    return;
  }
  await rm(aside, { recursive: true, force: true });
}

async function acquireDir(path: string, signal: AbortSignal): Promise<void> {
  while (true) {
    signal.throwIfAborted();
    try {
      await mkdir(path);
      const temporary = join(path, `.pid-${randomUUID().slice(0, 8)}`);
      await writeFile(temporary, String(process.pid));
      await rename(temporary, join(path, "pid"));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const owner = await inspectLock(path);
    if (owner.state === "stale") {
      await takeOver(path, owner.ino);
      continue;
    }
    if (owner.state === "free") continue;
    await delay(POLL_MS, signal);
  }
}

/** Run `fn` holding the lock `path` (a directory). */
export async function withLock<T>(path: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const chained = previous.then(() => mine);
  queues.set(path, chained);
  try {
    await previous.catch(() => undefined);
    await acquireDir(path, signal);
    try {
      return await fn();
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  } finally {
    release();
    if (queues.get(path) === chained) queues.delete(path);
  }
}
