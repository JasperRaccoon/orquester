/**
 * One install at a time per key: an in-process queue plus a lock directory (`<path>` holding the
 * owner's pid) so a second daemon on the same appdir waits too. A lock whose owner pid is gone is
 * stale and taken over.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { delay, isProcessAlive } from "../android/procs.ts";

const queues = new Map<string, Promise<unknown>>();

async function acquireDir(path: string, signal: AbortSignal): Promise<void> {
  while (true) {
    signal.throwIfAborted();
    try {
      await mkdir(path);
      await writeFile(join(path, "pid"), String(process.pid));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const owner = Number((await readFile(join(path, "pid"), "utf8").catch(() => "")).trim());
    if (owner === process.pid || !owner || !(await isProcessAlive(owner))) {
      // Ours from a crashed run, half-written, or its owner died: take it over.
      await rm(path, { recursive: true, force: true });
      continue;
    }
    await delay(500, signal);
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
