/**
 * Claude adapter — the `goal_status` rows of the CLI's own transcript
 * (goals §3.1, §6.1 items 4 and 5).
 *
 * A goal that is met, judged impossible, or cleared by an unrecoverable error
 * says NOTHING on stdout: only the transcript records it, as an `attachment`
 * row of type `goal_status` (`goal.ts`, {@link ClaudeGoalStatusRow}). So the
 * session reads that file — after every `result` while a goal is running, and
 * once when a resumed session starts, to apply the CLI's own restore rule.
 *
 * The file is `<CLAUDE_CONFIG_DIR>/projects/<cwd slug>/<session id>.jsonl`.
 * The adapter's history reader cannot serve this: it goes through the SDK's
 * `getSessionMessages`, which returns `user`/`assistant`/`system` rows only —
 * never an attachment — and spawns a worker for another account's home. A
 * managed account home symlinks `projects/` back at the shared one, so an
 * account switch finds the same file.
 *
 * Every read is incremental and bounded: at most
 * {@link GOAL_TRANSCRIPT_READ_BYTES} per `read()`, only whole lines, and a
 * line is JSON-parsed only when it holds the bytes `"goal_status"` — a real
 * transcript runs to tens of megabytes of tool output. A line still being
 * written is left for the next read; a line longer than one whole read is
 * skipped, because a `goal_status` row never is.
 *
 * Nothing here throws for a transcript that is not there: that answers
 * `undefined`, and the session's debug line says so. Other I/O errors do
 * throw, and the session logs them at debug level too (goals §6.1.4).
 */

import { promises as fs } from "node:fs";
import * as nodePath from "node:path";

import { parseGoalStatusRow, type ClaudeGoalStatusRow } from "./goal.ts";

/** At most this many bytes per `read()` (goals §6.1.4). */
export const GOAL_TRANSCRIPT_READ_BYTES = 1024 * 1024;

/**
 * The SDK's `sanitizePath` keeps a project dir name whole up to this length;
 * past it the name is cut here and a hash follows — a hash the Bun-compiled
 * CLI computes differently from the Node SDK, so it is matched by prefix.
 */
const CLAUDE_PROJECT_DIR_NAME_MAX = 200;

/** A transcript file name is `<session id>.jsonl`; anything else is not one. */
const SESSION_ID_RE = /^[\w.-]+$/;

const GOAL_STATUS_NEEDLE = Buffer.from('"goal_status"', "utf8");
const NEWLINE = 0x0a;

/** The CLI's name for a project's transcript dir: every UTF-16 unit outside [A-Za-z0-9] is `-`. */
export function claudeProjectDirName(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Where `sessionId`'s transcript is, or `undefined`. The cwd as given first,
 * then its real path (the CLI may have resolved a symlink); a name past the
 * SDK's length limit is matched on its prefix, and only a dir that actually
 * holds this session's file is taken.
 */
export async function locateClaudeTranscript(input: {
  configDir: string;
  cwd: string;
  sessionId: string;
}): Promise<string | undefined> {
  if (!SESSION_ID_RE.test(input.sessionId)) {
    return undefined;
  }
  const projectsDir = nodePath.join(input.configDir, "projects");
  const fileName = `${input.sessionId}.jsonl`;
  const names = [claudeProjectDirName(input.cwd)];
  const real = await fs.realpath(input.cwd).catch(() => undefined);
  if (real !== undefined && real !== input.cwd) {
    names.push(claudeProjectDirName(real));
  }
  let entries: string[] | undefined;
  for (const name of names) {
    if (name.length <= CLAUDE_PROJECT_DIR_NAME_MAX) {
      const candidate = nodePath.join(projectsDir, name, fileName);
      if (await isFile(candidate)) {
        return candidate;
      }
      continue;
    }
    entries ??= await fs.readdir(projectsDir).catch(() => []);
    const prefix = `${name.slice(0, CLAUDE_PROJECT_DIR_NAME_MAX)}-`;
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) {
        continue;
      }
      const candidate = nodePath.join(projectsDir, entry, fileName);
      if (await isFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

interface ReadPosition {
  /** The first byte not yet read — always the start of a line, unless `skipping`. */
  offset: number;
  /** Inside a line longer than one whole read: drop bytes up to the next newline. */
  skipping: boolean;
}

interface ReadTarget {
  sessionId: string;
  path: string;
  from: ReadPosition;
  generation: number;
}

export interface ClaudeGoalTranscriptOptions {
  configDir: string;
  cwd: string;
  /** Overridden in tests, so a row split across two reads is exercised. */
  maxReadBytes?: number;
}

/**
 * One session's read position in its transcript. The session serialises every
 * call; {@link abandonPending} is how a read that outlived its deadline is
 * kept from moving the position after the session has moved on.
 */
export class ClaudeGoalTranscript {
  private readonly configDir: string;
  private readonly cwd: string;
  private readonly maxReadBytes: number;
  private sessionId: string | undefined;
  private path: string | undefined;
  private position: ReadPosition = { offset: 0, skipping: false };
  /** True once a read or a set point has placed {@link position} in this file. */
  private positioned = false;
  private generation = 0;

  constructor(options: ClaudeGoalTranscriptOptions) {
    this.configDir = options.configDir;
    this.cwd = options.cwd;
    this.maxReadBytes = Math.max(1, options.maxReadBytes ?? GOAL_TRANSCRIPT_READ_BYTES);
  }

  /**
   * The `goal_status` rows of the next chunk written since the last read, in
   * file order — ONE read (at most {@link GOAL_TRANSCRIPT_READ_BYTES}), its
   * position committed at once, whole lines only. `more` says the transcript
   * holds further bytes to read now; the caller reads again. One chunk per
   * call is what makes a huge delta finish: a whole-delta read that ran out of
   * time would commit nothing and start over from the same offset every time.
   * `undefined` when the transcript does not exist (yet).
   */
  async readNew(
    sessionId: string
  ): Promise<{ rows: ClaudeGoalStatusRow[]; more: boolean } | undefined> {
    const target = await this.target(sessionId);
    if (target === undefined) {
      return undefined;
    }
    const rows: ClaudeGoalStatusRow[] = [];
    const scanned = await this.scan(target, target.from, 1, (row) => {
      rows.push(row);
    });
    if (scanned === undefined) {
      return undefined;
    }
    this.commit(target, scanned.position);
    return { rows, more: scanned.more };
  }

  /**
   * The whole transcript's LAST `goal_status` row — what `--resume`'s restore
   * rule reads (goals §6.1.5) — leaving the position at the end, so the next
   * {@link readNew} starts from the tail. `undefined` when there is no
   * transcript; `{row: undefined}` when it has no goal row.
   */
  async readLast(sessionId: string): Promise<{ row: ClaudeGoalStatusRow | undefined } | undefined> {
    const target = await this.target(sessionId);
    if (target === undefined) {
      return undefined;
    }
    let last: ClaudeGoalStatusRow | undefined;
    // All of it before anything is committed: a scan that stopped half-way
    // would leave the position inside rows older than this session, where an
    // earlier run of the same goal may have been met. A failed scan leaves the
    // position unplaced, and `anchorAtTail` then starts at the end instead.
    const scanned = await this.scan(target, { offset: 0, skipping: false }, Infinity, (row) => {
      last = row;
    });
    if (scanned === undefined) {
      return undefined;
    }
    this.commit(target, scanned.position);
    return { row: last };
  }

  /**
   * Jump to the end of the transcript: a goal set from here on is judged only
   * by rows written after this point, never by a previous run of the same
   * condition (goals §6.1.4, "start at the set point"). `false` when there is
   * no transcript yet — reading then starts from its first byte anyway.
   */
  async markSetPoint(sessionId: string): Promise<boolean> {
    const target = await this.target(sessionId);
    if (target === undefined) {
      return false;
    }
    try {
      const handle = await fs.open(target.path, "r");
      try {
        const size = (await handle.stat()).size;
        if (size > 0 && size !== target.from.offset) {
          // The CLI may be mid-way through writing a line: resume after it.
          const last = Buffer.alloc(1);
          await handle.read(last, 0, 1, size - 1);
          this.commit(target, { offset: size, skipping: last[0] !== NEWLINE });
        } else {
          this.commit(target, target.from);
        }
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if (isMissing(error)) {
        this.forgetPath(target);
        return false;
      }
      throw error;
    }
  }

  /**
   * "Else the tail" (goals §6.1.4): when nothing has placed the read position
   * in this session's file yet — the resume scan failed or ran out of time —
   * start from its end rather than its first byte, where an earlier run of
   * the same goal may have been met. A position already placed is kept, so a
   * row written after the scan is never skipped.
   */
  async anchorAtTail(sessionId: string): Promise<boolean> {
    if (sessionId === this.sessionId && this.positioned) {
      return true;
    }
    return this.markSetPoint(sessionId);
  }

  /** Whatever read is in flight will not move the position when it lands. */
  abandonPending(): void {
    this.generation += 1;
  }

  private async target(sessionId: string): Promise<ReadTarget | undefined> {
    if (sessionId !== this.sessionId) {
      // A new session id is a new file (a fork writes its own), read from its
      // first byte.
      this.sessionId = sessionId;
      this.path = undefined;
      this.position = { offset: 0, skipping: false };
      this.positioned = false;
    }
    const generation = this.generation;
    let path = this.path;
    if (path === undefined) {
      path = await locateClaudeTranscript({ configDir: this.configDir, cwd: this.cwd, sessionId });
      if (path === undefined) {
        return undefined;
      }
      if (this.sessionId === sessionId) {
        this.path = path;
      }
    }
    return { sessionId, path, from: { ...this.position }, generation };
  }

  private async scan(
    target: ReadTarget,
    from: ReadPosition,
    maxReads: number,
    onRow: (row: ClaudeGoalStatusRow) => void
  ): Promise<ScanResult | undefined> {
    try {
      return await scanGoalStatusRows(target.path, from, this.maxReadBytes, maxReads, onRow);
    } catch (error) {
      if (isMissing(error)) {
        this.forgetPath(target);
        return undefined;
      }
      throw error;
    }
  }

  private commit(target: ReadTarget, next: ReadPosition): void {
    if (target.generation !== this.generation || target.sessionId !== this.sessionId) {
      return;
    }
    this.position = next;
    this.positioned = true;
  }

  private forgetPath(target: ReadTarget): void {
    if (target.sessionId === this.sessionId && this.path === target.path) {
      this.path = undefined;
    }
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

interface ScanResult {
  /** Where the next read starts. */
  position: ReadPosition;
  /** The read budget ran out with bytes still to read; a line being written is not "more". */
  more: boolean;
}

/**
 * Walk `path` from `from` towards the size it had when opened, at most
 * `maxReads` reads of `maxReadBytes`, handing every `goal_status` row to
 * `onRow`, and answer where the next read starts.
 */
async function scanGoalStatusRows(
  path: string,
  from: ReadPosition,
  maxReadBytes: number,
  maxReads: number,
  onRow: (row: ClaudeGoalStatusRow) => void
): Promise<ScanResult> {
  const handle = await fs.open(path, "r");
  try {
    const size = (await handle.stat()).size;
    let { offset, skipping } = from;
    if (size < offset) {
      // Truncated or replaced under us: the old position means nothing now.
      offset = 0;
      skipping = false;
    }
    if (offset >= size) {
      return { position: { offset, skipping }, more: false };
    }
    const buffer = Buffer.allocUnsafe(Math.min(maxReadBytes, size - offset));
    let reads = 0;
    while (offset < size) {
      if (reads >= maxReads) {
        return { position: { offset, skipping }, more: true };
      }
      reads += 1;
      const want = Math.min(buffer.length, size - offset);
      const { bytesRead } = await handle.read(buffer, 0, want, offset);
      if (bytesRead <= 0) {
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      let start = 0;
      if (skipping) {
        const newline = chunk.indexOf(NEWLINE);
        if (newline < 0) {
          offset += bytesRead;
          continue;
        }
        start = newline + 1;
        skipping = false;
      }
      const end = chunk.lastIndexOf(NEWLINE);
      if (end < start) {
        // No whole line left in this read.
        if (start === 0 && bytesRead === maxReadBytes) {
          // One line longer than a whole read: never a goal row.
          skipping = true;
          offset += bytesRead;
          continue;
        }
        offset += start;
        if (bytesRead < want || offset + (bytesRead - start) >= size) {
          // The last line is still being written: read it whole next time.
          break;
        }
        continue;
      }
      scanLines(chunk, start, end, onRow);
      const readToEnd = offset + bytesRead >= size;
      offset += end + 1;
      if (readToEnd) {
        // Whatever is left past the last newline is a line still being
        // written: nothing more to read now.
        break;
      }
    }
    return { position: { offset, skipping }, more: false };
  } finally {
    await handle.close();
  }
}

/** The goal rows among the whole lines of `chunk[start..end]` (`end` is a newline). */
function scanLines(
  chunk: Buffer,
  start: number,
  end: number,
  onRow: (row: ClaudeGoalStatusRow) => void
): void {
  let from = start;
  while (from < end) {
    const hit = chunk.indexOf(GOAL_STATUS_NEEDLE, from);
    if (hit < 0 || hit >= end) {
      return;
    }
    const lineStart = Math.max(start, chunk.lastIndexOf(NEWLINE, hit) + 1);
    const lineEnd = chunk.indexOf(NEWLINE, hit);
    const row = parseLine(chunk.toString("utf8", lineStart, lineEnd));
    if (row !== undefined) {
      onRow(row);
    }
    from = lineEnd + 1;
  }
}

function parseLine(text: string): ClaudeGoalStatusRow | undefined {
  try {
    return parseGoalStatusRow(JSON.parse(text));
  } catch {
    return undefined;
  }
}
