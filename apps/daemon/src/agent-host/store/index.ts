/**
 * The thread store — `<appdir>/daemon/agent/` (spec §5.1).
 *
 * ```
 * <rootDir>/
 *   threads/<threadId>/
 *     meta.json          the head, rewritten atomically every 50 events and on turn end
 *     events.ndjson      append-only domain events, per-thread monotonic `seq`
 *     state.json         the fold snapshot: a cache of the fold as of one seq (A2)
 *     raw.ndjson         provider frames, rotated + redacted (§3.1)
 *     attachments/<id>.<ext>
 *   pending-attachments/ uploads made before their thread existed, swept after 24 h
 *   receipts.json        commandId -> {seq, status}, a ring of 500
 * ```
 *
 * Invariants:
 * - **`seq` is per thread and monotonic.** There is no global ordering to wait
 *   on, because subscriptions are per thread anyway. Every append for one
 *   thread runs on that thread's own promise chain, so two concurrent callers
 *   can never mint the same sequence.
 * - **The receipt is written in the same step that appends the events**, and
 *   strictly AFTER them: a receipt must never exist for events that did not
 *   land. The opposite ordering would make a crash between the two look like a
 *   completed command with no record of it.
 * - **A thread directory that fails to parse marks THAT thread `error`** with
 *   the parse message. It never affects other threads or host startup, which
 *   is why every read path is per-thread and try/caught, and why
 *   `parseAgentThreadHead` returns null rather than throwing.
 * - **A malformed line truncates the fold at that point** rather than
 *   discarding the file: `readAll`/`readTail` stop at the first line that does
 *   not decode and answer `truncated: true`, and §6.3 turns that into a
 *   snapshot rather than a replay.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import {
  AGENT_RECEIPTS_RING_SIZE,
  createDefaultAgentReceiptsFile,
  parseAgentDomainEvent,
  parseAgentProviderSessionBinding,
  parseAgentReceiptsFile,
  parseAgentThreadHead
} from "@orquester/config";
import type {
  AgentAdapterId,
  AttachmentRef,
  CommandReceipt,
  DomainEvent,
  FoldSnapshotFile,
  ProviderSessionBinding,
  ProviderSessionBindingPatch,
  ThreadFoldState,
  ThreadHead,
  ThreadItem
} from "@orquester/api/agent-chat";
import {
  FOLD_SNAPSHOT_VERSION,
  MAX_TURN_FILE_BYTES,
  MAX_TURN_IMAGE_BYTES,
  SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES,
  applyDomainEvent,
  createEmptyThreadState,
  deserializeFoldState,
  parseFoldSnapshotFile,
  serializeFoldState
} from "@orquester/api/agent-chat";

import type {
  AppendResult,
  AppendableDomainEvent,
  AttachmentPutInput,
  Clock,
  EventPosition,
  EventsFromResult,
  IdGen,
  ThreadStore,
  ThreadTail
} from "../services.ts";
import {
  PARTIAL_UPLOAD_MAX_AGE_MS,
  PENDING_ATTACHMENT_MAX_AGE_MS,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  attachmentFileExtension,
  attachmentFileNameCandidates,
  createAttachmentId,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment
} from "./attachments.ts";
import { BINDING_FILE_NAME, mergeSessionBinding } from "./binding.ts";
import {
  atomicWriteFile,
  fileSizeOrZero,
  readFileOrNull,
  readFileWindow,
  readLastCompleteLine,
  splitCompleteLineSpans,
  splitCompleteLines,
  truncateTornTail
} from "./files.ts";
import { applyEventToHead } from "./head.ts";
import { RawFrameLog, pruneRawLogDirectory } from "./raw-log.ts";

/** `meta.json` is rewritten after this many appended events (§5.1). */
export const HEAD_CHECKPOINT_EVENTS = 50;

/**
 * A fold the store runs itself (the attachment sweep's) yields to the event
 * loop every this many events, like the host's cold load: a big log must not
 * starve the health probe (thread-index design, invariant 7).
 */
const FOLD_YIELD_EVENTS = 500;

/**
 * Decoding a log yields to the event loop after this many milliseconds of
 * synchronous work. A historical thread can be hundreds of MB, and parsing it
 * in one go froze health, /providers and /stop long enough for the supervisor
 * to kill an otherwise healthy host; one large thread may load slowly, but it
 * cannot take down every agent tab while it does.
 */
const DECODE_SLICE_MS = 8;

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// The layout, relative to `rootDir`. `@orquester/config`'s `agentChat*Path`
// helpers take the APPDIR and compute `<appdir>/daemon/agent/…`; `rootDir` is
// already that directory, so the store spells the tail of the same layout here
// rather than re-deriving an appdir it was never given.
const threadsDir = (rootDir: string): string => path.join(rootDir, "threads");
const threadDir = (rootDir: string, threadId: string): string =>
  path.join(threadsDir(rootDir), threadId);
const threadMetaPath = (rootDir: string, threadId: string): string =>
  path.join(threadDir(rootDir, threadId), "meta.json");
const threadEventsPath = (rootDir: string, threadId: string): string =>
  path.join(threadDir(rootDir, threadId), "events.ndjson");
// `agentChatThreadStatePath(appdir, id)` in @orquester/config names the same file.
const threadStatePath = (rootDir: string, threadId: string): string =>
  path.join(threadDir(rootDir, threadId), "state.json");
const threadBindingPath = (rootDir: string, threadId: string): string =>
  path.join(threadDir(rootDir, threadId), BINDING_FILE_NAME);
const threadRawPath = (rootDir: string, threadId: string): string =>
  path.join(threadDir(rootDir, threadId), "raw.ndjson");
const threadAttachmentsDir = (rootDir: string, threadId: string): string =>
  path.join(threadDir(rootDir, threadId), "attachments");
const receiptsPath = (rootDir: string): string => path.join(rootDir, "receipts.json");

/** The stored extensions that make a file an image for the §4.1 size bound. */
const IMAGE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".gif",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp"
]);

/**
 * A thread id may name a directory the store creates, reads and recursively
 * deletes, so it is shape-checked here rather than trusted from the caller.
 * The daemon mints UUIDs and gates every per-session route, but the host is a
 * separate process with its own trust boundary: one wrong caller would turn a
 * `DELETE` into an arbitrary recursive delete. `store/attachments.ts` does the
 * same for attachment ids.
 */
const SAFE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeThreadId(threadId: string): boolean {
  return SAFE_THREAD_ID.test(threadId) && !threadId.includes("..");
}

function assertSafeThreadId(threadId: string): void {
  if (!isSafeThreadId(threadId)) {
    throw new Error(`agent-chat: unusable thread id ${JSON.stringify(threadId)}`);
  }
}

/** A byte offset or a sequence as a cursor may carry one: a whole number, never negative. */
function isCursorCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * An unreferenced attachment younger than this is never swept: it is a file
 * uploaded for a turn that has not dispatched yet (§6.3).
 */
export const UNREFERENCED_ATTACHMENT_GRACE_MS = PENDING_ATTACHMENT_MAX_AGE_MS;

export interface ThreadStoreOptions {
  /** `<appdir>/daemon/agent` — the directory that holds `threads/` and `receipts.json`. */
  rootDir: string;
  clock?: Clock;
  idGen?: IdGen;
  /** Home dirs collapsed to `~` in `raw.ndjson`'s redaction pass (§3.1). */
  homeDirs?: readonly string[];
  /**
   * `CheckpointService.deleteThreadRefs`, wired by W1. `deleteThread` calls it
   * before it removes the directory, so a thread can never be deleted and
   * leave its checkpoint refs behind (§5.4). The store deliberately owns no
   * git; the `cwd` the service needs is read off the thread's head.
   */
  deleteThreadRefs?: (input: { threadId: string; cwd: string }) => Promise<void>;
  /**
   * How often the store sweeps host-wide (§3.1's raw-log ceiling, §5.1's
   * pending/`.part` attachment TTLs). `0` disables it.
   *
   * The store schedules this ITSELF rather than waiting for a caller: every
   * bound it enforces is a background one, and the only other `pruneAttachments`
   * caller in the host passes a `threadId` (the revert path), which skips the
   * host-wide branch entirely — so without this the ceiling was correct code
   * that nothing ever ran.
   */
  sweepIntervalMs?: number;
  /** Test seams so the sweep can be driven without sleeping (§9). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * Where the store says what it could not make right: today only an append
   * whose rollback failed too. Silent by default (tests); the host wires its
   * own logger.
   */
  logger?: { warn(message: string, detail?: unknown): void };
}

/** Default cadence for the background sweep. */
export const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const defaultClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString()
};

const defaultIdGen: IdGen = {
  eventId: () => randomUUID(),
  messageId: (prefix: string) => `${prefix}:${randomUUID()}`,
  uuid: () => randomUUID()
};

interface ThreadRuntime {
  /** Highest sequence known to be on disk. */
  seq: number;
  /**
   * Byte length of `events.ndjson`: one `stat` when the thread is first
   * loaded, then advanced by every append's own arithmetic — never re-`stat`ed
   * per event. The next appended line starts here, which is what makes
   * {@link AppendResult.positions} exact.
   */
  logBytes: number;
  head: ThreadHead | null;
  /**
   * `binding.json`, cached after the first read. `undefined` means "not read
   * yet"; `null` means "read, and this thread has none".
   */
  binding: ProviderSessionBinding | null | undefined;
  eventsSinceHeadSave: number;
  /** The per-thread write queue: every mutation chains onto it. */
  queue: Promise<unknown>;
  raw: RawFrameLog | null;
  /** Set when this thread's own directory failed to parse (§5.1). */
  error: string | null;
  /**
   * The log may still end in a torn fragment the store could not cut — a load
   * whose repair failed, or an append whose rollback failed. The next append
   * cuts it first, or fails without writing: a batch glued onto a fragment is
   * one malformed line `readAll` stops at forever.
   */
  tornTail: boolean;
}

/**
 * The store, plus two members beyond {@link ThreadStore} that the host reads:
 * {@link AgentThreadStore.threadError} (which thread is `error`, and why) and
 * {@link AgentThreadStore.pendingAttachmentsDir} (where a pre-thread upload
 * lands).
 */
export interface AgentThreadStore extends ThreadStore {
  /** The parse message for a thread marked `error`, or null (§5.1). */
  threadError(threadId: string): string | null;
  /** Where an upload made before its thread exists is written. */
  pendingAttachmentsDir(): string;
  /**
   * `GET /api/sessions/:id/items/:itemId` (§6.3): one item with its FULL,
   * unslimmed payload, or null.
   *
   * Reads the log backwards rather than folding it, for two reasons: the
   * newest write for an id is the authoritative one, and an item that aged
   * out of the fold's 500-row activity window (§5.1) is exactly the kind of
   * row a "load full output" click asks for — it must still be servable.
   */
  readItem(threadId: string, itemId: string): Promise<ThreadItem | null>;
  /**
   * Run the host-wide sweep now: the raw-log ceiling plus every attachment
   * TTL. Equivalent to `pruneAttachments()` with no arguments; exposed so the
   * host can sweep once at boot (what accumulated while it was down) and so a
   * test can drive it without waiting for the interval.
   */
  sweepNow(): Promise<void>;
  /**
   * Cheap boot cleanup: prune pending/partial uploads and rotated raw logs
   * without reading or folding any conversation history.
   */
  sweepStartup(): Promise<void>;
  /**
   * Stop the background sweep. The timer is `unref`'d, so forgetting this
   * never holds the process open; it exists so a host stop is deterministic.
   */
  close(): void;
}

export function createThreadStore(options: ThreadStoreOptions): AgentThreadStore {
  const { rootDir } = options;
  const clock = options.clock ?? defaultClock;
  const ids = options.idGen ?? defaultIdGen;
  const homeDirs = options.homeDirs;
  const deleteThreadRefs = options.deleteThreadRefs;

  const threads = new Map<string, ThreadRuntime>();
  const pendingDir = path.join(rootDir, "pending-attachments");

  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => {
      const handle = setInterval(fn, ms);
      handle.unref?.();
      return handle;
    });
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));
  let sweepTimer: unknown = null;

  // --- receipts ------------------------------------------------------------

  let receipts: CommandReceipt[] | null = null;
  const receiptIndex = new Map<string, CommandReceipt>();
  let receiptQueue: Promise<unknown> = Promise.resolve();

  async function loadReceipts(): Promise<CommandReceipt[]> {
    if (receipts !== null) {
      return receipts;
    }
    const raw = await readFileOrNull(receiptsPath(rootDir));
    let parsed = createDefaultAgentReceiptsFile();
    if (raw !== null) {
      try {
        parsed = parseAgentReceiptsFile(JSON.parse(raw));
      } catch {
        // A receipt ring is a de-duplication cache: losing it costs at most
        // one replayed command, never a thread.
        parsed = createDefaultAgentReceiptsFile();
      }
    }
    receipts = parsed.receipts as CommandReceipt[];
    receiptIndex.clear();
    for (const receipt of receipts) {
      receiptIndex.set(receipt.commandId, receipt);
    }
    return receipts;
  }

  /** Runs on the shared receipt queue so two commands cannot race the file. */
  function enqueueReceipt<T>(task: () => Promise<T>): Promise<T> {
    const next = receiptQueue.then(task, task);
    receiptQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async function writeReceipt(receipt: CommandReceipt): Promise<void> {
    const ring = await loadReceipts();
    const existing = ring.findIndex((entry) => entry.commandId === receipt.commandId);
    if (existing !== -1) {
      ring.splice(existing, 1);
    }
    ring.push(receipt);
    if (ring.length > AGENT_RECEIPTS_RING_SIZE) {
      for (const evicted of ring.splice(0, ring.length - AGENT_RECEIPTS_RING_SIZE)) {
        receiptIndex.delete(evicted.commandId);
      }
    }
    receiptIndex.set(receipt.commandId, receipt);
    // Compact, not pretty-printed: this file is rewritten once per command and
    // the indentation roughly doubled the bytes fsynced each time. It is a
    // de-duplication cache, never something a human reads in place.
    await atomicWriteFile(receiptsPath(rootDir), `${JSON.stringify({ version: 1, receipts: ring })}\n`);
  }

  // --- per-thread runtime --------------------------------------------------

  function runtime(threadId: string): ThreadRuntime {
    assertSafeThreadId(threadId);
    let entry = threads.get(threadId);
    if (entry === undefined) {
      entry = {
        seq: 0,
        logBytes: 0,
        head: null,
        binding: undefined,
        eventsSinceHeadSave: 0,
        queue: Promise.resolve(),
        raw: null,
        error: null,
        tornTail: false
      };
      threads.set(threadId, entry);
    }
    return entry;
  }

  const loaded = new Set<string>();
  /**
   * In-flight first loads, keyed by thread. Inserted **synchronously** before
   * the first await, which is the whole point: `ensureLoaded` used to mark a
   * thread loaded and only then read the log, so a caller arriving in that
   * window got `seq: 0` and the next append stamped 1 over sequences already
   * on disk — and `readLog` then treats the duplicate as corruption and
   * truncates that thread permanently. Every caller now awaits the same
   * promise, so the seed happens exactly once and nobody sees a half-seeded
   * runtime.
   */
  const loading = new Map<string, Promise<ThreadRuntime>>();

  /**
   * Seed a thread's sequence and head from disk, once. A failure here marks
   * THIS thread `error` and returns — it never propagates.
   */
  function ensureLoaded(threadId: string): Promise<ThreadRuntime> {
    const entry = runtime(threadId);
    if (loaded.has(threadId)) {
      return Promise.resolve(entry);
    }
    const inFlight = loading.get(threadId);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const promise = loadRuntime(threadId, entry).finally(() => {
      loading.delete(threadId);
    });
    loading.set(threadId, promise);
    return promise;
  }

  async function loadRuntime(threadId: string, entry: ThreadRuntime): Promise<ThreadRuntime> {
    try {
      const headRaw = await readFileOrNull(threadMetaPath(rootDir, threadId));
      if (headRaw !== null) {
        let decoded: unknown = null;
        try {
          decoded = JSON.parse(headRaw);
        } catch (error) {
          entry.error = `meta.json is not JSON: ${(error as Error).message}`;
        }
        const head = decoded === null ? null : parseAgentThreadHead(decoded);
        if (head === null && entry.error === null) {
          entry.error = "meta.json does not match the thread head schema";
        }
        entry.head = head as ThreadHead | null;
      }
    } catch (error) {
      entry.error = `meta.json is unreadable: ${(error as Error).message}`;
    }

    // A torn trailing fragment is a batch that never completed: `append`
    // writes a whole batch and fsyncs before it answers, so nobody was told
    // about it. Cut it BEFORE anything appends — the next batch would
    // otherwise be written onto it, one glued, malformed line that `readAll`
    // stops at forever while position-based reads (a snapshot's tail, the
    // index) step over it. A complete line that does not decode ends with its
    // newline and is left alone: that stays §5.1's truncated read. The size
    // this answers is the one `stat` behind every position this store
    // reports; appends advance it themselves from here on.
    const eventsPath = threadEventsPath(rootDir, threadId);
    try {
      entry.logBytes = await truncateTornTail(eventsPath);
    } catch (error) {
      entry.error ??= `events.ndjson could not be read or repaired: ${(error as Error).message}`;
      entry.logBytes = await fileSizeOrZero(eventsPath).catch(() => 0);
      entry.tornTail = true;
    }

    // The log is authoritative for the sequence, even when `meta.json` is
    // stale or gone: reading the last complete line is what makes boot cheap.
    try {
      const lastLine = await readLastCompleteLine(eventsPath);
      if (lastLine !== null) {
        const parsed = decodeLine(lastLine);
        if (parsed !== null) {
          entry.seq = parsed.seq;
        } else {
          // The last line is genuinely corrupt (an unknown TYPE decodes fine).
          // Fall back to a full scan, and then take the highest sequence the
          // file mentions rather than the scan's: the scan stops AT the bad
          // line, so trusting it would let the next append re-use a sequence
          // that is already on disk (R1-8).
          const tail = await readLog(threadId);
          entry.seq = Math.max(tail.seq, await highestSeqOnDisk(threadId));
          entry.error ??= "events.ndjson has a line that does not decode";
        }
      }
    } catch (error) {
      entry.error ??= `events.ndjson is unreadable: ${(error as Error).message}`;
    }

    if (entry.head !== null && entry.head.seq > entry.seq) {
      // A head ahead of the log means the log lost its tail. The log wins for
      // ordering; the head keeps its fields.
      entry.head = { ...entry.head, seq: entry.seq };
    }
    // Marked loaded only now, with `seq` seeded: anything earlier is the race.
    loaded.add(threadId);
    return entry;
  }

  /**
   * Re-seed a loaded entry's `seq` and `logBytes` from the file, exactly as
   * {@link loadRuntime} seeds them, after a write the store could not undo.
   * The torn-tail cut is attempted again (a fragment the next batch would be
   * glued onto), the length is what the file says, and the sequence is the
   * last complete line's — with the load's own corrupt-last-line fallback.
   * Never throws: this runs inside a failure path that is about to rethrow.
   */
  async function resyncFromDisk(threadId: string, entry: ThreadRuntime): Promise<void> {
    const eventsPath = threadEventsPath(rootDir, threadId);
    try {
      entry.logBytes = await truncateTornTail(eventsPath);
      entry.tornTail = false;
    } catch {
      entry.logBytes = await fileSizeOrZero(eventsPath).catch(() => entry.logBytes);
      entry.tornTail = true;
    }
    try {
      const lastLine = await readLastCompleteLine(eventsPath);
      if (lastLine === null) {
        entry.seq = 0;
        return;
      }
      const parsed = decodeLine(lastLine);
      if (parsed !== null) {
        entry.seq = parsed.seq;
        return;
      }
      const tail = await readLog(threadId);
      entry.seq = Math.max(tail.seq, await highestSeqOnDisk(threadId));
    } catch {
      // Unreadable: keep the advanced counter — above anything on disk is the
      // one place a sequence can never collide.
    }
  }

  /** Chain one mutation onto a thread's write queue. */
  function enqueue<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const entry = runtime(threadId);
    const next = entry.queue.then(task, task);
    entry.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  /**
   * The highest `seq` any line of the log mentions, ignoring whether the line
   * folds. A corrupt line still occupied a sequence; re-using it would corrupt
   * the ordering the fold and `/events?after=` depend on, which is worse than
   * skipping one.
   */
  async function highestSeqOnDisk(threadId: string): Promise<number> {
    const contents = await readFileOrNull(threadEventsPath(rootDir, threadId));
    if (contents === null) {
      return 0;
    }
    let highest = 0;
    for (const line of splitCompleteLines(contents).lines) {
      try {
        const seq = (JSON.parse(line) as { seq?: unknown }).seq;
        if (typeof seq === "number" && Number.isInteger(seq) && seq > highest) {
          highest = seq;
        }
      } catch {
        continue;
      }
    }
    return highest;
  }

  function decodeLine(line: string): DomainEvent | null {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return null;
    }
    const parsed = parseAgentDomainEvent(value);
    return parsed === null ? null : (parsed as unknown as DomainEvent);
  }

  /**
   * Read the whole log, truncating at the first line that does not decode.
   *
   * An event type this build does not know is **not** such a line (§8): it
   * decodes, it advances `seq`, and the fold ignores it. Only corrupt JSON, a
   * broken envelope or a sequence that goes backwards truncates.
   */
  async function readLog(threadId: string): Promise<ThreadTail> {
    const contents = await readFileOrNull(threadEventsPath(rootDir, threadId));
    if (contents === null) {
      return { events: [], seq: 0, truncated: false };
    }
    const events: DomainEvent[] = [];
    const torn = contents.length > 0 && !contents.endsWith("\n");
    let truncated = torn;
    let seq = 0;
    const completeEnd = torn ? contents.lastIndexOf("\n") + 1 : contents.length;
    let offset = 0;
    let sliceStartedAt = Date.now();
    while (offset < completeEnd) {
      const newline = contents.indexOf("\n", offset);
      if (newline < 0 || newline >= completeEnd) break;
      const line = contents.slice(offset, newline);
      offset = newline + 1;
      if (line.length === 0) continue;
      const event = decodeLine(line);
      if (event === null) {
        truncated = true;
        break;
      }
      // A log whose sequences go backwards is corrupt from that point on.
      if (event.seq <= seq) {
        truncated = true;
        break;
      }
      seq = event.seq;
      events.push(event);
      if (Date.now() - sliceStartedAt >= DECODE_SLICE_MS) {
        await yieldToLoop();
        sliceStartedAt = Date.now();
      }
    }
    return { events, seq, truncated };
  }

  /**
   * Decode the complete lines of a byte window that starts at `baseOffset` in
   * the log, with each event's absolute position. Stops at the first line
   * that does not decode or whose sequence does not climb — {@link readLog}'s
   * rule — and reports it, like a torn trailing fragment, as `truncated`.
   * Yields like {@link readLog}: a cold load reads the whole log through here.
   */
  async function decodeWindow(
    bytes: Buffer,
    baseOffset: number
  ): Promise<{ events: DomainEvent[]; positions: EventPosition[]; lines: number; truncated: boolean }> {
    const { spans, torn } = splitCompleteLineSpans(bytes);
    const events: DomainEvent[] = [];
    const positions: EventPosition[] = [];
    let truncated = torn;
    let previous = 0;
    let sliceStartedAt = Date.now();
    for (const span of spans) {
      const event = decodeLine(bytes.toString("utf8", span.start, span.newline));
      if (event === null || event.seq <= previous) {
        truncated = true;
        break;
      }
      previous = event.seq;
      events.push(event);
      positions.push({
        seq: event.seq,
        byteOffset: baseOffset + span.start,
        byteLength: span.newline - span.start + 1
      });
      if (Date.now() - sliceStartedAt >= DECODE_SLICE_MS) {
        await yieldToLoop();
        sliceStartedAt = Date.now();
      }
    }
    return { events, positions, lines: spans.length, truncated };
  }

  async function writeHead(head: ThreadHead): Promise<void> {
    await atomicWriteFile(
      threadMetaPath(rootDir, head.id),
      `${JSON.stringify(head, null, 2)}\n`
    );
  }

  // --- provider session binding (§3.3, §4.1) -------------------------------

  /**
   * Read `binding.json` once per thread and cache it. An unreadable or
   * undecodable file is `null` — "this thread has no binding", which the
   * orchestrator reads as "fall back to the head's cursor" (§8). It never
   * marks the thread `error`: a lost binding costs one resume, a lost thread
   * costs the conversation.
   */
  async function readBinding(threadId: string): Promise<ProviderSessionBinding | null> {
    const entry = runtime(threadId);
    if (entry.binding !== undefined) {
      return entry.binding;
    }
    let binding: ProviderSessionBinding | null = null;
    try {
      const raw = await readFileOrNull(threadBindingPath(rootDir, threadId));
      if (raw !== null) {
        const parsed = parseAgentProviderSessionBinding(JSON.parse(raw));
        binding =
          parsed === null
            ? null
            : ({
                threadId: parsed.threadId,
                adapter: parsed.adapter,
                adapterKey: parsed.adapterKey,
                runtimeMode: parsed.runtimeMode,
                providerInstanceId: parsed.providerInstanceId,
                status: parsed.status,
                resumeCursor: parsed.resumeCursor ?? null,
                providerThreadId: parsed.providerThreadId,
                lastSeenAt: parsed.lastSeenAt
              } satisfies ProviderSessionBinding);
      }
    } catch {
      binding = null;
    }
    entry.binding = binding;
    return binding;
  }

  async function writeBinding(binding: ProviderSessionBinding): Promise<void> {
    await fsp.mkdir(threadDir(rootDir, binding.threadId), { recursive: true });
    await atomicWriteFile(
      threadBindingPath(rootDir, binding.threadId),
      `${JSON.stringify({ version: 1, ...binding }, null, 2)}\n`
    );
  }

  // --- attachments ---------------------------------------------------------

  function attachmentsDirFor(threadId: string): string {
    return threadAttachmentsDir(rootDir, threadId);
  }

  /**
   * The directory an id's bytes live in: the owning thread's, or the shared
   * pending dir for the reserved `pending` segment. Null when the id does not
   * belong to `threadId` at all — an id NAMES its thread, so a mismatch is a
   * refusal, never a lookup somewhere else.
   */
  function dirForAttachment(threadId: string, attachmentId: string): string | null {
    const segment = parseThreadSegmentFromAttachmentId(attachmentId);
    if (segment === null) {
      return null;
    }
    if (segment === PENDING_ATTACHMENT_THREAD_SEGMENT) {
      return pendingDir;
    }
    return segment === toSafeThreadAttachmentSegment(threadId)
      ? attachmentsDirFor(threadId)
      : null;
  }

  async function findAttachmentFile(dir: string, attachmentId: string): Promise<string | null> {
    for (const candidate of attachmentFileNameCandidates(attachmentId)) {
      const filePath = path.join(dir, candidate);
      try {
        await fsp.access(filePath);
        return filePath;
      } catch {
        continue;
      }
    }
    return null;
  }

  /** `applyDomainEvent` over `events`, yielding to the loop every {@link FOLD_YIELD_EVENTS}. */
  async function foldForward(
    state: ThreadFoldState,
    events: readonly DomainEvent[]
  ): Promise<ThreadFoldState> {
    let folded = state;
    for (let index = 0; index < events.length; index += 1) {
      folded = applyDomainEvent(folded, events[index]!);
      if ((index + 1) % FOLD_YIELD_EVENTS === 0) {
        await yieldToLoop();
      }
    }
    return folded;
  }

  /**
   * The thread's fold as the host itself would load it: the snapshot folded
   * forward through the log's tail when one is usable, the whole log only
   * when not — no snapshot, or a cursor the log does not honour. Folding
   * snapshot + tail is folding the whole log (the snapshot's own invariant),
   * so both answer the same items. The sweep runs this for every thread right
   * after the gate; a whole-log fold per thread there is the boot cost the
   * lazy reconcile removed.
   */
  async function foldForSweep(threadId: string): Promise<ThreadFoldState> {
    const snapshot = await store.loadFoldSnapshot(threadId);
    const base = snapshot === null ? null : deserializeFoldState(snapshot.state);
    if (snapshot !== null && base !== null) {
      const tail = await store.readEventsFrom(threadId, {
        byteOffset: snapshot.logBytes,
        afterSeq: snapshot.seq
      });
      if (!tail.mismatch) {
        return foldForward(base, tail.events);
      }
    }
    return foldForward(createEmptyThreadState(), (await readLog(threadId)).events);
  }

  /** Every attachment id a thread's SURVIVING items still reference (§5.5). */
  function referencedAttachmentIds(state: ThreadFoldState): Set<string> {
    const referenced = new Set<string>();
    const visit = (value: unknown, depth: number): void => {
      if (depth > 8 || value === null || typeof value !== "object") {
        return;
      }
      if (Array.isArray(value)) {
        for (const entry of value) visit(entry, depth + 1);
        return;
      }
      const record = value as Record<string, unknown>;
      // Anything AttachmentRef-shaped counts, wherever it sits: a message's
      // own list, or an answered question that carried files.
      if (typeof record.id === "string" && typeof record.name === "string") {
        referenced.add(record.id);
      }
      for (const entry of Object.values(record)) visit(entry, depth + 1);
    };
    for (const item of state.items) {
      if (item.kind === "message") {
        for (const attachment of item.attachments ?? []) {
          referenced.add(attachment.id);
        }
        for (const chip of item.context ?? []) {
          if (chip.kind === "attachment" && typeof chip.ref === "string") {
            referenced.add(chip.ref);
          }
        }
      } else {
        visit(item.payload, 0);
      }
    }
    return referenced;
  }

  async function sweepDirectory(
    dir: string,
    nowMs: number,
    keep: (attachmentId: string) => boolean
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry);
      const isPartial = entry.endsWith(".part");
      let maxAgeMs = PARTIAL_UPLOAD_MAX_AGE_MS;
      if (!isPartial) {
        const attachmentId = parseAttachmentIdFromRelativePath(entry);
        if (attachmentId === null) {
          continue;
        }
        if (keep(attachmentId)) {
          continue;
        }
        maxAgeMs =
          parseThreadSegmentFromAttachmentId(attachmentId) === PENDING_ATTACHMENT_THREAD_SEGMENT
            ? PENDING_ATTACHMENT_MAX_AGE_MS
            : UNREFERENCED_ATTACHMENT_GRACE_MS;
      }
      try {
        const stat = await fsp.stat(filePath);
        if (nowMs - stat.mtimeMs > maxAgeMs) {
          await fsp.rm(filePath, { force: true });
        }
      } catch {
        continue;
      }
    }
  }

  function pruneRawLogs(nowMs: number): void {
    const liveThreadIds = new Set<string>();
    for (const [id, entry] of threads) {
      if (entry.raw !== null) {
        liveThreadIds.add(id);
      }
    }
    try {
      pruneRawLogDirectory({
        threadsRoot: threadsDir(rootDir),
        liveThreadIds,
        now: () => nowMs
      });
    } catch {
      // Diagnostics never block a turn, and never fail a sweep.
    }
  }

  // --- the store -----------------------------------------------------------

  const store: AgentThreadStore = {
    async append(input: {
      threadId: string;
      events: AppendableDomainEvent[];
      receipt?: Omit<CommandReceipt, "seq">;
    }): Promise<AppendResult> {
      return enqueue(input.threadId, async () => {
        const entry = await ensureLoaded(input.threadId);
        if (entry.tornTail && input.events.length > 0) {
          // A fragment nobody could cut is still at the end of the log. Cut it
          // before a byte is written — or throw here, having minted nothing
          // and written nothing, so the caller sees an ordinary failed append.
          entry.logBytes = await truncateTornTail(threadEventsPath(rootDir, input.threadId));
          entry.tornTail = false;
        }
        const seqBefore = entry.seq;
        const stamped: DomainEvent[] = input.events.map(
          (event) => ({ ...event, seq: ++entry.seq }) as DomainEvent
        );

        // Each line's position is the log's length before it plus the UTF-8
        // bytes of every line ahead of it in this batch — bytes, never
        // characters, because a history page is read back by byte range.
        const lines = stamped.map((event) => `${JSON.stringify(event)}\n`);
        const positions: EventPosition[] = [];
        let endOffset = entry.logBytes;
        lines.forEach((line, index) => {
          const byteLength = Buffer.byteLength(line, "utf8");
          positions.push({ seq: stamped[index]!.seq, byteOffset: endOffset, byteLength });
          endOffset += byteLength;
        });

        if (lines.length > 0) {
          const eventsPath = threadEventsPath(rootDir, input.threadId);
          try {
            await fsp.mkdir(threadDir(rootDir, input.threadId), { recursive: true });
            const handle = await fsp.open(eventsPath, "a", 0o600);
            try {
              await handle.writeFile(lines.join(""), "utf8");
              await handle.sync();
            } finally {
              await handle.close();
            }
          } catch (error) {
            // A batch that failed never happened — the caller is told so, and
            // nothing was published or receipted — but a failed write may
            // still have landed some or all of it (a failed fsync lands all
            // of it). Roll the log back to where it stood, sequences too: a
            // partial write left in place is a torn fragment the next batch
            // is glued onto. If even that fails, the disk holds none, some or
            // all of the batch and nobody knows which: re-derive BOTH
            // counters from the file, as the load does — never `seqBefore`
            // (a line that landed would be minted again, a collision
            // `readLog` reads as corruption) and never the advanced one (a
            // hole in the log's own sequences, which no index catch-up can
            // ever bridge) — flag a fragment it could not cut for the next
            // append, and say so, because a log that cannot be rolled back
            // is a failing disk, not a quiet retry.
            try {
              await fsp.truncate(eventsPath, entry.logBytes);
              entry.seq = seqBefore;
            } catch (rollbackError) {
              await resyncFromDisk(input.threadId, entry);
              options.logger?.warn(
                "agent-host: an append failed and its rollback failed too; the thread's counters were re-read from disk",
                {
                  threadId: input.threadId,
                  error: (error as Error)?.message ?? String(error),
                  rollbackError: (rollbackError as Error)?.message ?? String(rollbackError),
                  seq: entry.seq,
                  logBytes: entry.logBytes
                }
              );
            }
            throw error;
          }
          entry.logBytes = endOffset;
        }

        // STRICTLY after the events: a receipt must never exist for events
        // that did not land (§5.1).
        if (input.receipt !== undefined) {
          const receipt: CommandReceipt = { ...input.receipt, seq: entry.seq };
          await enqueueReceipt(() => writeReceipt(receipt));
        }

        for (const event of stamped) {
          entry.head = applyEventToHead(entry.head, event);
        }
        entry.eventsSinceHeadSave += stamped.length;
        if (entry.head !== null && entry.eventsSinceHeadSave >= HEAD_CHECKPOINT_EVENTS) {
          entry.eventsSinceHeadSave = 0;
          try {
            await writeHead(entry.head);
          } catch {
            // A failed checkpoint costs replay time on the next boot, nothing
            // more: the log is the record.
          }
        }

        return { seq: entry.seq, events: stamped, positions, logBytes: entry.logBytes };
      });
    },

    async readTail(threadId: string, afterSeq: number): Promise<ThreadTail> {
      await ensureLoaded(threadId);
      const tail = await readLog(threadId);
      return {
        events: tail.events.filter((event) => event.seq > afterSeq),
        seq: tail.seq,
        truncated: tail.truncated
      };
    },

    async readAll(threadId: string): Promise<ThreadTail> {
      await ensureLoaded(threadId);
      return readLog(threadId);
    },

    /**
     * The log from a recorded cursor to its end. A cursor is only trusted
     * while the line at its offset carries `afterSeq + 1`: a log that is
     * shorter, rewritten, or cut mid-line there answers `mismatch` with
     * nothing read, and the caller starts again from byte 0 — the log is the
     * authority, never the cursor.
     */
    async readEventsFrom(
      threadId: string,
      input: { byteOffset: number; afterSeq: number }
    ): Promise<EventsFromResult> {
      await ensureLoaded(threadId);
      const { byteOffset, afterSeq } = input;
      const stale: EventsFromResult = {
        events: [],
        positions: [],
        truncated: false,
        seq: afterSeq,
        logBytes: byteOffset,
        mismatch: true
      };
      // Checked BEFORE any read: position -1 means "the current position" to
      // `read(2)`, which would silently read from the top.
      if (!isCursorCount(byteOffset) || !isCursorCount(afterSeq)) {
        return stale;
      }
      const window = await readFileWindow(threadEventsPath(rootDir, threadId), byteOffset);
      if ((window?.size ?? 0) < byteOffset) {
        return stale;
      }
      const decoded = await decodeWindow(window?.bytes ?? Buffer.alloc(0), byteOffset);
      // The first complete line decides: it must decode AND carry afterSeq + 1.
      if (decoded.lines > 0 && decoded.events[0]?.seq !== afterSeq + 1) {
        return stale;
      }
      const last = decoded.positions[decoded.positions.length - 1];
      return {
        events: decoded.events,
        positions: decoded.positions,
        truncated: decoded.truncated,
        seq: last?.seq ?? afterSeq,
        logBytes: last === undefined ? byteOffset : last.byteOffset + last.byteLength,
        mismatch: false
      };
    },

    /**
     * A history page's bytes: exactly `[fromByte, toByte)`, both line
     * boundaries some earlier append reported. `truncated` whenever the window
     * cannot be decoded whole — a malformed line, a line cut by either edge,
     * or a log that ends before `toByte` — so a caller holding stale positions
     * learns it rather than rendering a short page as complete.
     */
    async readEventRange(
      threadId: string,
      input: { fromByte: number; toByte: number }
    ): Promise<{ events: DomainEvent[]; truncated: boolean }> {
      assertSafeThreadId(threadId);
      const { fromByte, toByte } = input;
      if (!isCursorCount(fromByte) || !isCursorCount(toByte) || toByte < fromByte) {
        throw new RangeError(`agent-chat: unusable byte range [${fromByte}, ${toByte})`);
      }
      if (toByte === fromByte) {
        return { events: [], truncated: false };
      }
      const window = await readFileWindow(threadEventsPath(rootDir, threadId), fromByte, toByte);
      if (window === null) {
        return { events: [], truncated: true };
      }
      const decoded = await decodeWindow(window.bytes, fromByte);
      return { events: decoded.events, truncated: decoded.truncated || window.size < toByte };
    },

    async lastSeq(threadId: string): Promise<number> {
      const entry = await ensureLoaded(threadId);
      return entry.seq;
    },

    async logLength(threadId: string): Promise<number> {
      const entry = await ensureLoaded(threadId);
      return entry.logBytes;
    },

    /**
     * `state.json` (A2) — a cache of the log, so every doubt answers `null`
     * and the caller folds from byte 0: missing, unreadable, not JSON, another
     * version or thread (`parseFoldSnapshotFile`), or AHEAD of the log.
     * Written after the append it covers, a snapshot can only trail the log;
     * one that claims more (a log restored from an older backup, a hand edit)
     * would make the fold drop every event appended up to its seq. Never
     * throws — not even for an unusable thread id.
     */
    async loadFoldSnapshot(threadId: string): Promise<FoldSnapshotFile | null> {
      if (!isSafeThreadId(threadId)) {
        return null;
      }
      try {
        const raw = await readFileOrNull(threadStatePath(rootDir, threadId));
        if (raw === null) {
          return null;
        }
        const snapshot = parseFoldSnapshotFile(JSON.parse(raw), threadId);
        if (snapshot === null) {
          return null;
        }
        const entry = await ensureLoaded(threadId);
        return snapshot.seq > entry.seq || snapshot.logBytes > entry.logBytes ? null : snapshot;
      } catch {
        return null;
      }
    },

    /**
     * Serialised NOW, written when the thread's queue gets to it: the caller
     * keeps folding meanwhile (the save is fire-and-forget), so what lands
     * must be the state as of `seq`, not whatever the caller's objects hold
     * by then. The queue makes saves land in call order, after every append
     * queued before them. A save the log cannot honour — the thread was
     * deleted meanwhile, or the claim runs past the log — is dropped rather
     * than written: it must not recreate a deleted thread's directory, and a
     * load would refuse it anyway.
     */
    async saveFoldSnapshot(input: {
      threadId: string;
      seq: number;
      logBytes: number;
      state: ThreadFoldState;
      extras?: Record<string, unknown>;
    }): Promise<void> {
      assertSafeThreadId(input.threadId);
      if (input.state.seq !== input.seq) {
        // `parseFoldSnapshotFile` refuses such a file, so writing it would be
        // a silent, permanent cache miss: fail where the caller can log it.
        throw new Error(
          `agent-chat: fold snapshot seq ${input.seq} does not match its state's seq ${input.state.seq}`
        );
      }
      const snapshot: FoldSnapshotFile = {
        version: FOLD_SNAPSHOT_VERSION,
        threadId: input.threadId,
        seq: input.seq,
        logBytes: input.logBytes,
        writtenAt: clock.nowIso(),
        state: serializeFoldState(input.state),
        ...(input.extras !== undefined ? { extras: input.extras } : {})
      };
      // Compact: a few MB rewritten every 200 events, never read by a human.
      const contents = `${JSON.stringify(snapshot)}\n`;
      await enqueue(input.threadId, async () => {
        const entry = await ensureLoaded(input.threadId);
        if (entry.logBytes === 0 || input.seq > entry.seq || input.logBytes > entry.logBytes) {
          return;
        }
        await atomicWriteFile(threadStatePath(rootDir, input.threadId), contents);
      });
    },

    async loadHead(
      threadId: string,
      options?: { seedRuntime?: boolean }
    ): Promise<ThreadHead | null> {
      if (options?.seedRuntime === false) {
        assertSafeThreadId(threadId);
        const entry = runtime(threadId);
        // A seeded entry's head is at least as new as the file (appends advance
        // it between checkpoints), so re-reading `meta.json` over it would
        // roll it back.
        if (loaded.has(threadId)) {
          return entry.head;
        }
        try {
          const raw = await readFileOrNull(threadMetaPath(rootDir, threadId));
          if (raw === null) return null;
          let decoded: unknown;
          try {
            decoded = JSON.parse(raw);
          } catch (error) {
            entry.error = `meta.json is not JSON: ${(error as Error).message}`;
            return null;
          }
          const head = parseAgentThreadHead(decoded);
          if (head === null) {
            entry.error = "meta.json does not match the thread head schema";
            return null;
          }
          entry.head = head as ThreadHead;
          return entry.head;
        } catch (error) {
          entry.error = `meta.json is unreadable: ${(error as Error).message}`;
          return null;
        }
      }
      const entry = await ensureLoaded(threadId);
      return entry.head;
    },

    async saveHead(head: ThreadHead): Promise<void> {
      await enqueue(head.id, async () => {
        const entry = await ensureLoaded(head.id);
        await writeHead(head);
        // The fold is authoritative: adopt it, and restart the checkpoint
        // counter so the next automatic write is 50 events from here.
        entry.head = head;
        entry.eventsSinceHeadSave = 0;
        if (head.seq > entry.seq) {
          entry.seq = head.seq;
        }
      });
    },

    async loadBinding(threadId: string): Promise<ProviderSessionBinding | null> {
      assertSafeThreadId(threadId);
      return readBinding(threadId);
    },

    /**
     * Field-wise, on the thread's own write queue, so two concurrent writers
     * cannot lose each other's fields (§3.3). `undefined` keeps what is
     * stored; `null` clears it. There is no "replace the binding" call, by
     * construction — that is what erased the cursor from the head.
     */
    async upsertSessionBinding(input: {
      threadId: string;
      adapter: AgentAdapterId;
      patch: ProviderSessionBindingPatch;
    }): Promise<ProviderSessionBinding> {
      assertSafeThreadId(input.threadId);
      return enqueue(input.threadId, async () => {
        const entry = runtime(input.threadId);
        const existing = await readBinding(input.threadId);
        const merged = mergeSessionBinding({
          threadId: input.threadId,
          existing,
          patch: input.patch,
          fallbackAdapter: input.adapter,
          now: clock.nowIso()
        });
        await writeBinding(merged);
        entry.binding = merged;
        return merged;
      });
    },

    async listThreads(): Promise<string[]> {
      try {
        const entries = await fsp.readdir(threadsDir(rootDir), { withFileTypes: true });
        return entries
          .filter((entry) => entry.isDirectory() && isSafeThreadId(entry.name))
          .map((entry) => entry.name)
          .sort();
      } catch {
        return [];
      }
    },

    /**
     * Deletes the thread directory, its attachments, its raw log **and its
     * checkpoint refs** (§5.4, §6.1).
     *
     * The store owns no git, so the refs go through
     * {@link ThreadStoreOptions.deleteThreadRefs} — W1 wires
     * `CheckpointService.deleteThreadRefs` into it at construction. The cwd it
     * needs comes off the head, which is read here rather than asked of the
     * caller. Two orderings matter: the refs go FIRST, so a failure leaves the
     * thread whole and retryable instead of a directory-less pile of refs, and
     * a throw from the hook aborts the delete rather than being swallowed.
     */
    async deleteThread(threadId: string): Promise<void> {
      await enqueue(threadId, async () => {
        const entry = await ensureLoaded(threadId);
        const cwd = entry.head?.cwd;
        if (deleteThreadRefs !== undefined && cwd !== undefined) {
          await deleteThreadRefs({ threadId, cwd });
        }
        entry.raw?.close();
        entry.raw = null;
        entry.binding = undefined;
        await fsp.rm(threadDir(rootDir, threadId), { recursive: true, force: true });
        threads.delete(threadId);
        loaded.delete(threadId);
        loading.delete(threadId);
      });
    },

    async getReceipt(commandId: string): Promise<CommandReceipt | null> {
      await enqueueReceipt(loadReceipts);
      return receiptIndex.get(commandId) ?? null;
    },

    async putReceipt(receipt: CommandReceipt): Promise<void> {
      await enqueueReceipt(() => writeReceipt(receipt));
    },

    async putAttachment(input: AttachmentPutInput): Promise<AttachmentRef> {
      assertSafeThreadId(input.threadId);
      const stat = await fsp.stat(input.sourcePath);
      if (!stat.isFile()) {
        throw new Error("agent-chat: an attachment source must be a regular file");
      }
      // Bounds are validated against the STAT'd file, never the declared size.
      const sizeBytes = stat.size;
      const mimeType = input.mimeType?.trim().toLowerCase();
      const extension = attachmentFileExtension(input.name);
      // The image cap keys on BOTH the declared mime and the extension the
      // host actually stores: keying on the mime alone let
      // `?name=x.png&type=application/octet-stream` carry 40 MiB in under the
      // 50 MiB file limit and then be re-declared `image/png` on the turn
      // (S1 #7). The wider of the two claims decides, so neither string alone
      // buys the larger bound.
      const isImage =
        (mimeType !== undefined &&
          (SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) ||
        IMAGE_FILE_EXTENSIONS.has(extension);
      const limit = isImage ? MAX_TURN_IMAGE_BYTES : MAX_TURN_FILE_BYTES;
      if (sizeBytes > limit) {
        throw new Error(
          `agent-chat: attachment is ${sizeBytes} bytes, over the ${limit}-byte limit`
        );
      }

      const attachmentId = createAttachmentId(
        input.threadId,
        ids.uuid(),
        extension.replace(/^\./, "")
      );
      if (attachmentId === null) {
        throw new Error("agent-chat: thread id cannot be expressed as an attachment segment");
      }
      const dir = attachmentsDirFor(input.threadId);
      await fsp.mkdir(dir, { recursive: true });
      const destination = path.join(dir, `${attachmentId}${extension}`);
      // COPIED, never hard-linked: an agent editing the delivered file in
      // place must not mutate the retry source (§6.3).
      await fsp.copyFile(input.sourcePath, destination);
      await fsp.chmod(destination, 0o600);

      if (
        mimeType !== undefined &&
        (SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)
      ) {
        return {
          type: "image",
          id: attachmentId,
          name: input.name,
          mimeType,
          sizeBytes,
          path: destination
        };
      }
      return {
        type: "file",
        id: attachmentId,
        name: input.name,
        ...(mimeType !== undefined ? { mimeType } : {}),
        sizeBytes,
        // The absolute path the composer names in the prompt (§7.4). Only the
        // upload reply carries it; `validate.ts` strips it from commands.
        path: destination
      };
    },

    async resolveAttachment(threadId: string, attachmentId: string): Promise<string> {
      assertSafeThreadId(threadId);
      const dir = dirForAttachment(threadId, attachmentId);
      if (dir === null) {
        throw new Error("agent-chat: attachment does not belong to this thread");
      }
      const filePath = await findAttachmentFile(dir, attachmentId);
      if (filePath === null) {
        throw new Error("agent-chat: attachment not found (removed or expired)");
      }
      return filePath;
    },

    async pruneAttachments(input?: { threadId?: string; now?: Date }): Promise<void> {
      const nowMs = (input?.now ?? clock.now()).getTime();
      // `pending`-segment uploads and `.part` files: nothing references them
      // by construction, so the age bounds are the whole rule.
      await sweepDirectory(pendingDir, nowMs, () => false);

      // §3.1's host-wide raw-log ceiling rides the same schedule: it is the
      // only bound above the per-thread rotation, and it cannot live inside a
      // single thread's writer (S1 #5).
      if (input?.threadId === undefined) {
        pruneRawLogs(nowMs);
      }

      const targets =
        input?.threadId !== undefined ? [input.threadId] : await store.listThreads();
      for (const threadId of targets) {
        try {
          const dir = attachmentsDirFor(threadId);
          // Only a stored attachment needs a verdict (`.part` files go by age
          // alone), so a thread with none is never read at all.
          const entries = await fsp.readdir(dir).catch((): string[] => []);
          const needsVerdict = entries.some(
            (entry) => !entry.endsWith(".part") && parseAttachmentIdFromRelativePath(entry) !== null
          );
          // The retained set is recomputed from the SURVIVING items, which is
          // what makes this correct after a revert truncated the thread.
          const referenced = needsVerdict
            ? referencedAttachmentIds(await foldForSweep(threadId))
            : new Set<string>();
          await sweepDirectory(dir, nowMs, (id) => referenced.has(id));
        } catch {
          // One unreadable thread never stops the sweep of the others (§5.1).
        }
        // One thread at a time, with the loop breathing in between.
        await yieldToLoop();
      }
    },

    logRawFrame(threadId: string, frame: unknown): void {
      const entry = runtime(threadId);
      if (entry.raw === null) {
        // One writer per thread: two writers rotating the same file race.
        entry.raw = new RawFrameLog({
          filePath: threadRawPath(rootDir, threadId),
          ...(homeDirs !== undefined ? { homeDirs } : {}),
          now: () => clock.now().getTime()
        });
      }
      entry.raw.write(frame);
    },

    async drain(): Promise<void> {
      const queues = [...threads.values()].map((entry) => entry.queue);
      await Promise.allSettled([...queues, receiptQueue]);
      for (const entry of threads.values()) {
        entry.raw?.flush();
      }
      // A queued write may have enqueued another; settle once more so `drain`
      // is the seam a test can wait on instead of sleeping (§9).
      await Promise.allSettled([...[...threads.values()].map((entry) => entry.queue), receiptQueue]);
    },

    threadError(threadId: string): string | null {
      return threads.get(threadId)?.error ?? null;
    },

    pendingAttachmentsDir(): string {
      return pendingDir;
    },

    async sweepNow(): Promise<void> {
      await store.pruneAttachments();
    },

    async sweepStartup(): Promise<void> {
      const nowMs = clock.now().getTime();
      await sweepDirectory(pendingDir, nowMs, () => false);
      pruneRawLogs(nowMs);
      // Partials need no event-log reference scan. Keep every completed file;
      // the scheduled deep sweep will fold histories and collect true orphans.
      for (const threadId of await store.listThreads()) {
        await sweepDirectory(attachmentsDirFor(threadId), nowMs, () => true);
      }
    },

    close(): void {
      if (sweepTimer !== null) {
        clearTimer(sweepTimer);
        sweepTimer = null;
      }
      for (const entry of threads.values()) {
        entry.raw?.close();
        entry.raw = null;
      }
    },

    async readItem(threadId: string, itemId: string): Promise<ThreadItem | null> {
      assertSafeThreadId(threadId);
      const tail = await readLog(threadId);
      for (let index = tail.events.length - 1; index >= 0; index -= 1) {
        const event = tail.events[index]!;
        if (event.type === "thread.activity-appended") {
          if (event.payload.activity.id === itemId) {
            return event.payload.activity;
          }
          continue;
        }
        if (event.type !== "thread.message-sent" || event.payload.messageId !== itemId) {
          continue;
        }
        // A message id is written once per delta, so the newest row alone is
        // a fragment: rebuild the accumulated body the same way the fold does
        // — yielding, like every other whole-log fold in this store, so a
        // long thread's "load full output" cannot starve the health probe.
        const state = await foldForward(createEmptyThreadState(), tail.events);
        return state.items.find((item) => item.id === itemId) ?? null;
      }
      return null;
    }
  };

  if (sweepIntervalMs > 0) {
    sweepTimer = setTimer(() => {
      // Best effort and never awaited by anything: a sweep that fails costs
      // disk, never a turn.
      void store.pruneAttachments().catch(() => undefined);
    }, sweepIntervalMs);
  }

  return store;
}
