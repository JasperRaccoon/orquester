/**
 * `raw.ndjson` — the untranslated provider-frame log (spec §3.1).
 *
 * Ported in spirit from T3 Code (MIT):
 * `apps/server/src/provider/Layers/EventNdjsonLogger.ts`.
 *
 * Four properties this writer owes, all of them from §3.1:
 * - **one writer per thread.** Two writers rotating the same file race, so the
 *   store hands out exactly one and never a second.
 * - **best-effort, never blocking.** `write()` is synchronous bookkeeping into
 *   a bounded buffer; the flush is what touches the disk, and a writer that
 *   cannot open its file degrades to a no-op instead of failing host startup.
 * - **bounded.** 10 MiB per file, 10 files and 14 days per thread here, plus
 *   per-record caps on string length, field count and nesting depth. The
 *   total-bytes ceiling across the whole directory is host-wide and therefore
 *   lives in {@link pruneRawLogDirectory}, not in one thread's writer.
 * - **redacted.** `raw.ndjson` is as sensitive as the repository it watched
 *   (§10), and Grok's `_x.ai/mcp/servers_updated` carries the host's real MCP
 *   server credentials in an `env` map — so every record is scrubbed
 *   structurally (env-shaped maps) and then textually (`redactStderr`) before
 *   a byte reaches the file.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { redactStderr } from "../support/stderr.ts";

/** 10 MiB per file (§3.1). */
export const RAW_LOG_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** 10 files kept. */
export const RAW_LOG_MAX_FILES = 10;
/** 14 days. */
export const RAW_LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** The ceiling across every raw log in the directory, on top of rotation. */
export const RAW_LOG_TOTAL_BYTES_CEILING = 512 * 1024 * 1024;
/** Batch window: a flush happens at most this often. */
export const RAW_LOG_BATCH_MS = 1_000;
/** …or earlier, on either of these. */
export const RAW_LOG_FLUSH_BYTES = 1024 * 1024;
export const RAW_LOG_FLUSH_RECORDS = 512;
/** Per-record caps (§3.1). */
export const RAW_LOG_MAX_STRING_CHARS = 64 * 1024;
export const RAW_LOG_MAX_FIELDS = 1024;
export const RAW_LOG_MAX_DEPTH = 16;

/**
 * High-rate delta frames are DROPPED rather than written: the decoded frame
 * that follows carries the same information without a second copy of every
 * token (§3.1). Both the canonical runtime names and the per-provider raw
 * spellings the fixtures observed are listed, because an adapter logs the
 * provider's frame, not ours.
 */
export const RAW_LOG_DROPPED_FRAME_TYPES: ReadonlySet<string> = new Set([
  // Canonical (§4.2 `TRANSIENT_RUNTIME_EVENT_TYPES`).
  "content.delta",
  "item.updated",
  "tool.progress",
  "task.progress",
  "turn.proposed.delta",
  // Claude SDK.
  "content_block_delta",
  "input_json_delta",
  "system/status",
  "system/thinking_tokens",
  "stream_event",
  // Codex app-server.
  "item/updated",
  "turn/proposedResponse/delta",
  "thread/tokenUsage/updated",
  // OpenCode.
  "message.part.delta",
  "message.part.updated",
  "server.heartbeat",
  // ACP / Grok.
  "session/update",
  "_x.ai/session/update"
]);

/** Keys whose VALUE is an environment map full of credentials. */
const ENV_MAP_KEYS: ReadonlySet<string> = new Set(["env", "environment", "envVars"]);
/** Keys whose value is a credential outright, whatever the shape. */
const SECRET_KEY_RE = /^(?:.*_)?(?:api[-_]?key|secret|token|password|passwd|credential)s?$/i;

/**
 * Structural scrub, with the textual redaction applied **per string value**
 * rather than to the finished line. Both halves are load-bearing:
 * - a textual pass alone cannot save an MCP `env` map, whose values are
 *   arbitrary strings that match no token shape;
 * - and `redactStderr`'s credential-header rule masks to END OF LINE (a header
 *   value is the rest of the line, not one word), so running it over a whole
 *   NDJSON record would swallow the rest of the JSON and leave an unparseable
 *   line behind. Applied per value, the same rule stops at the value.
 */
function scrub(
  value: unknown,
  depth: number,
  budget: { fields: number },
  homeDirs: readonly string[] | undefined
): unknown {
  if (typeof value === "string") {
    const redacted = redactStderr(value, {
      ...(homeDirs !== undefined ? { homeDirs } : {})
    });
    return redacted.length > RAW_LOG_MAX_STRING_CHARS
      ? `${redacted.slice(0, RAW_LOG_MAX_STRING_CHARS)}…[truncated]`
      : redacted;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= RAW_LOG_MAX_DEPTH) {
    return "[depth]";
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value) {
      if (budget.fields <= 0) {
        out.push("[fields]");
        break;
      }
      budget.fields -= 1;
      out.push(scrub(entry, depth + 1, budget, homeDirs));
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (budget.fields <= 0) {
      out["[fields]"] = true;
      break;
    }
    budget.fields -= 1;
    if (SECRET_KEY_RE.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (ENV_MAP_KEYS.has(key) && entry !== null && typeof entry === "object") {
      // Every value of an env map is a credential until proven otherwise.
      const keys = Array.isArray(entry)
        ? entry.map((_, index) => String(index))
        : Object.keys(entry as Record<string, unknown>);
      out[key] = Object.fromEntries(keys.map((name) => [name, "[redacted]"]));
      continue;
    }
    out[key] = scrub(entry, depth + 1, budget, homeDirs);
  }
  return out;
}

/**
 * Every type name a frame could be filed under. A runtime-event envelope
 * carries its own `type` AND nests the provider frame under `raw`, so both are
 * offered to the drop list: an envelope around `message.part.delta` is just as
 * transient as the bare frame.
 */
function frameTypes(frame: unknown, depth = 0): string[] {
  if (frame === null || typeof frame !== "object" || depth > 2) {
    return [];
  }
  const record = frame as Record<string, unknown>;
  const names: string[] = [];
  for (const key of ["method", "messageType", "type", "eventType", "t"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      names.push(value);
    }
  }
  return [...names, ...frameTypes(record.raw, depth + 1)];
}

export interface RawLogOptions {
  /** Absolute path of the thread's `raw.ndjson`. */
  filePath: string;
  /** Home dirs collapsed to `~` in the textual redaction pass. */
  homeDirs?: readonly string[];
  /** Test seam: the clock the rotation and the age sweep read. */
  now?: () => number;
  /** Test seam: schedule the batch flush. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * One thread's raw log. The store owns exactly one per thread and closes it
 * when the thread is deleted or the host drains.
 */
export class RawFrameLog {
  private pending: string[] = [];
  private pendingBytes = 0;
  private timer: unknown = null;
  private disabled = false;
  private closed = false;

  /** Frames dropped because they are transient (§3.1), for a counter. */
  droppedTransient = 0;

  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: RawLogOptions) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** Append one frame. Never throws, never blocks, never awaits. */
  write(frame: unknown): void {
    if (this.closed || this.disabled) {
      return;
    }
    if (frameTypes(frame).some((name) => RAW_LOG_DROPPED_FRAME_TYPES.has(name))) {
      this.droppedTransient += 1;
      return;
    }

    let line: string;
    try {
      const scrubbed = scrub(frame, 0, { fields: RAW_LOG_MAX_FIELDS }, this.options.homeDirs);
      line = `${JSON.stringify(scrubbed) ?? "null"}\n`;
    } catch {
      // A cyclic or non-serialisable frame must not take the log down.
      return;
    }

    this.pending.push(line);
    this.pendingBytes += Buffer.byteLength(line);

    if (
      this.pending.length >= RAW_LOG_FLUSH_RECORDS ||
      this.pendingBytes >= RAW_LOG_FLUSH_BYTES
    ) {
      this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.flush();
      }, RAW_LOG_BATCH_MS);
    }
  }

  /** Write everything buffered. Synchronous by design — it runs off a timer. */
  flush(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0 || this.disabled) {
      this.pending = [];
      this.pendingBytes = 0;
      return;
    }
    const payload = this.pending.join("");
    this.pending = [];
    this.pendingBytes = 0;
    try {
      this.rotateIfNeeded(Buffer.byteLength(payload));
      fs.mkdirSync(path.dirname(this.options.filePath), { recursive: true });
      fs.appendFileSync(this.options.filePath, payload, { mode: 0o600 });
    } catch {
      // Degrade to a no-op: diagnostics never block a turn (§3.1).
      this.disabled = true;
    }
  }

  close(): void {
    this.flush();
    this.closed = true;
  }

  /** True once a write or rotation failed and the log stopped recording. */
  get isDisabled(): boolean {
    return this.disabled;
  }

  private rotateIfNeeded(incomingBytes: number): void {
    let size = 0;
    try {
      size = fs.statSync(this.options.filePath).size;
    } catch {
      return; // No file yet: nothing to rotate.
    }
    if (size + incomingBytes <= RAW_LOG_MAX_FILE_BYTES) {
      return;
    }
    // Shift `.9` off the end and every other suffix up by one.
    for (let index = RAW_LOG_MAX_FILES - 1; index >= 1; index -= 1) {
      const from = index === 1 ? this.options.filePath : `${this.options.filePath}.${index - 1}`;
      const to = `${this.options.filePath}.${index}`;
      try {
        if (index === RAW_LOG_MAX_FILES - 1) {
          fs.rmSync(to, { force: true });
        }
        fs.renameSync(from, to);
      } catch {
        // A missing rung is normal early on.
      }
    }
    this.pruneAgedRungs();
  }

  /**
   * The 14-day age bound, over THIS thread's rotated rungs.
   *
   * Only the age bound lives here: the total-bytes ceiling is host-wide and
   * cannot be enforced from inside one thread's writer — rotation already caps
   * a single thread at 9 rungs x 10 MiB, so a 512 MiB test against that set is
   * unconditionally true and the prune is unreachable. See
   * {@link pruneRawLogDirectory}.
   *
   * Called only from the rotation path: it does a synchronous `readdirSync` +
   * `statSync` per entry, and running that on every flush put a directory scan
   * on the host's event loop once a second per live thread.
   */
  private pruneAgedRungs(): void {
    const dir = path.dirname(this.options.filePath);
    const base = path.basename(this.options.filePath);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    const cutoff = this.now() - RAW_LOG_MAX_AGE_MS;
    for (const entry of entries) {
      if (!entry.startsWith(`${base}.`)) {
        continue;
      }
      const file = path.join(dir, entry);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) {
          fs.rmSync(file, { force: true });
        }
      } catch {
        continue;
      }
    }
  }
}

/**
 * §3.1's **total-bytes ceiling across the directory**, on top of the per-file
 * rotation. Rotation bounds one thread at ~100 MiB; without this a hundred
 * threads are 10 GiB in the one writable appdir.
 *
 * Deletes oldest-mtime first: every rotated rung across every thread, and only
 * then a live `raw.ndjson` whose thread has no open writer in this process
 * (`liveThreadIds`) — a file the host is appending to must not be unlinked out
 * from under it. Purely best-effort: any error stops the sweep rather than
 * raising, because diagnostics never block a turn.
 *
 * *T3: `apps/server/src/provider/Layers/EventNdjsonLogger.ts:25-34` — the
 * ceiling is over the whole log store, not one thread's rung set.*
 */
export function pruneRawLogDirectory(input: {
  /** `<rootDir>/threads` — the parent of every per-thread directory. */
  readonly threadsRoot: string;
  /** Threads with an open writer: their LIVE file is never unlinked. */
  readonly liveThreadIds?: ReadonlySet<string>;
  readonly ceilingBytes?: number;
  readonly now?: () => number;
}): { readonly deleted: number; readonly totalBytes: number } {
  const ceiling = input.ceilingBytes ?? RAW_LOG_TOTAL_BYTES_CEILING;
  const nowMs = input.now?.() ?? Date.now();
  const cutoff = nowMs - RAW_LOG_MAX_AGE_MS;

  let threadDirs: fs.Dirent[];
  try {
    threadDirs = fs.readdirSync(input.threadsRoot, { withFileTypes: true });
  } catch {
    return { deleted: 0, totalBytes: 0 };
  }

  type Entry = { file: string; mtimeMs: number; size: number; live: boolean };
  const files: Entry[] = [];
  let deleted = 0;
  let total = 0;

  for (const dirent of threadDirs) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const threadId = dirent.name;
    const dir = path.join(input.threadsRoot, threadId);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry !== "raw.ndjson" && !entry.startsWith("raw.ndjson.")) {
        continue;
      }
      const file = path.join(dir, entry);
      try {
        const stat = fs.statSync(file);
        const live = entry === "raw.ndjson";
        // The age bound applies host-wide too, and a rung old enough to drop
        // never counts towards the ceiling.
        if (!live && stat.mtimeMs < cutoff) {
          fs.rmSync(file, { force: true });
          deleted += 1;
          continue;
        }
        total += stat.size;
        files.push({
          file,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          live: live && input.liveThreadIds?.has(threadId) === true
        });
      } catch {
        continue;
      }
    }
  }

  if (total <= ceiling) {
    return { deleted, totalBytes: total };
  }

  // Rotated rungs first, then a live file of a thread nobody is writing to.
  files.sort(
    (left, right) =>
      Number(left.live) - Number(right.live) || left.mtimeMs - right.mtimeMs
  );
  for (const entry of files) {
    if (total <= ceiling) {
      break;
    }
    if (entry.live) {
      continue;
    }
    try {
      fs.rmSync(entry.file, { force: true });
      total -= entry.size;
      deleted += 1;
    } catch {
      break;
    }
  }
  return { deleted, totalBytes: total };
}
