/**
 * The file primitives the thread store is built on (spec §5.1).
 *
 * Nothing clever, but two rules matter enough to live in one place:
 * - a whole-file rewrite is **tmp + rename**, so a crash mid-write leaves the
 *   previous version intact rather than a half-written `meta.json`;
 * - a torn trailing line in an append-only log is **truncated, never fatal** —
 *   the process can die between `write()` and the newline.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/** Rewrite a file atomically: write a sibling temp, fsync, rename over. */
export async function atomicWriteFile(
  filePath: string,
  contents: string,
  mode = 0o600
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  // `pid + Date.now()` collides for two writes in the same millisecond — the
  // second `rename` then throws ENOENT out of `saveHead`.
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fs.open(tmp, "w", mode);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/** Read a UTF-8 file, or null when it does not exist. */
export async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export interface SplitLines {
  /** Every complete line, in order, without its newline. */
  lines: string[];
  /**
   * True when the file did not end with a newline, so its last line was torn
   * by a crash mid-write and has been dropped.
   */
  torn: boolean;
}

/**
 * Split an append-only log into complete lines. A trailing fragment with no
 * newline is DROPPED and reported: a half-written record is not a record.
 */
export function splitCompleteLines(contents: string): SplitLines {
  if (contents.length === 0) {
    return { lines: [], torn: false };
  }
  const torn = !contents.endsWith("\n");
  const body = torn ? contents.slice(0, contents.lastIndexOf("\n") + 1) : contents;
  const lines = body.length === 0 ? [] : body.slice(0, -1).split("\n");
  return { lines: lines.filter((line) => line.length > 0), torn };
}

/**
 * Read the last complete line of a file without reading the whole thing.
 * Returns null for an empty file, a file of one torn line, or a read error.
 */
export async function readLastCompleteLine(
  filePath: string,
  windowBytes = 64 * 1024
): Promise<string | null> {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) {
      return null;
    }
    let end = size;
    // Walk backwards a window at a time until a complete line is in hand.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const start = Math.max(0, end - windowBytes * (attempt + 1));
      const length = end - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const { lines } = splitCompleteLines(buffer.toString("utf8"));
      const last = lines[lines.length - 1];
      // With start > 0 the first line of the window may itself be a fragment,
      // but the LAST complete line of a window that contains a newline is
      // whole, because it is terminated inside the window.
      if (last !== undefined && (lines.length > 1 || start === 0)) {
        return last;
      }
      if (start === 0) {
        return last ?? null;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
