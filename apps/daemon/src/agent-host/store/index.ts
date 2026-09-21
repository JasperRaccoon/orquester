/**
 * The thread store — `<appdir>/daemon/agent/` (spec §5.1).
 *
 * ```
 * <rootDir>/
 *   threads/<threadId>/
 *     meta.json          the head, rewritten atomically every 50 events and on turn end
 *     events.ndjson      append-only domain events, per-thread monotonic `seq`
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
  parseAgentReceiptsFile,
  parseAgentThreadHead
} from "@orquester/config";
import type {
  AttachmentRef,
  CommandReceipt,
  DomainEvent,
  ThreadHead,
  ThreadItem
} from "@orquester/api/agent-chat";
import {
  MAX_TURN_FILE_BYTES,
  MAX_TURN_IMAGE_BYTES,
  SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES,
  foldThread
} from "@orquester/api/agent-chat";

import type {
  AppendResult,
  AppendableDomainEvent,
  AttachmentPutInput,
  Clock,
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
import { atomicWriteFile, readFileOrNull, readLastCompleteLine, splitCompleteLines } from "./files.ts";
import { applyEventToHead } from "./head.ts";
import { RawFrameLog, pruneRawLogDirectory } from "./raw-log.ts";

/** `meta.json` is rewritten after this many appended events (§5.1). */
export const HEAD_CHECKPOINT_EVENTS = 50;

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
}

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
  head: ThreadHead | null;
  eventsSinceHeadSave: number;
  /** The per-thread write queue: every mutation chains onto it. */
  queue: Promise<unknown>;
  raw: RawFrameLog | null;
  /** Set when this thread's own directory failed to parse (§5.1). */
  error: string | null;
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
}

export function createThreadStore(options: ThreadStoreOptions): AgentThreadStore {
  const { rootDir } = options;
  const clock = options.clock ?? defaultClock;
  const ids = options.idGen ?? defaultIdGen;
  const homeDirs = options.homeDirs;
  const deleteThreadRefs = options.deleteThreadRefs;

  const threads = new Map<string, ThreadRuntime>();
  const pendingDir = path.join(rootDir, "pending-attachments");

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
        head: null,
        eventsSinceHeadSave: 0,
        queue: Promise.resolve(),
        raw: null,
        error: null
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

    // The log is authoritative for the sequence, even when `meta.json` is
    // stale or gone: reading the last complete line is what makes boot cheap.
    try {
      const lastLine = await readLastCompleteLine(threadEventsPath(rootDir, threadId));
      if (lastLine !== null) {
        const parsed = decodeLine(lastLine);
        if (parsed !== null) {
          entry.seq = parsed.seq;
        } else {
          // The tail does not decode; fall back to a full scan so the next
          // append cannot reuse a sequence that is already on disk.
          const tail = await readLog(threadId);
          entry.seq = tail.seq;
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

  /** Read the whole log, truncating at the first line that does not decode. */
  async function readLog(threadId: string): Promise<ThreadTail> {
    const contents = await readFileOrNull(threadEventsPath(rootDir, threadId));
    if (contents === null) {
      return { events: [], seq: 0, truncated: false };
    }
    const { lines, torn } = splitCompleteLines(contents);
    const events: DomainEvent[] = [];
    let truncated = torn;
    let seq = 0;
    for (const line of lines) {
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
    }
    return { events, seq, truncated };
  }

  async function writeHead(head: ThreadHead): Promise<void> {
    await atomicWriteFile(
      threadMetaPath(rootDir, head.id),
      `${JSON.stringify(head, null, 2)}\n`
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

  /** Every attachment id a thread's SURVIVING items still reference (§5.5). */
  function referencedAttachmentIds(events: readonly DomainEvent[]): Set<string> {
    const state = foldThread(events);
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

  // --- the store -----------------------------------------------------------

  const store: AgentThreadStore = {
    async append(input: {
      threadId: string;
      events: AppendableDomainEvent[];
      receipt?: Omit<CommandReceipt, "seq">;
    }): Promise<AppendResult> {
      return enqueue(input.threadId, async () => {
        const entry = await ensureLoaded(input.threadId);
        const stamped: DomainEvent[] = input.events.map(
          (event) => ({ ...event, seq: ++entry.seq }) as DomainEvent
        );

        if (stamped.length > 0) {
          const payload = stamped.map((event) => `${JSON.stringify(event)}\n`).join("");
          await fsp.mkdir(threadDir(rootDir, input.threadId), { recursive: true });
          const handle = await fsp.open(
            threadEventsPath(rootDir, input.threadId),
            "a",
            0o600
          );
          try {
            await handle.writeFile(payload, "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
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

        return { seq: entry.seq, events: stamped };
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

    async loadHead(threadId: string): Promise<ThreadHead | null> {
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
        return { type: "image", id: attachmentId, name: input.name, mimeType, sizeBytes };
      }
      return {
        type: "file",
        id: attachmentId,
        name: input.name,
        ...(mimeType !== undefined ? { mimeType } : {}),
        sizeBytes
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

      const targets =
        input?.threadId !== undefined ? [input.threadId] : await store.listThreads();
      for (const threadId of targets) {
        try {
          // The retained set is recomputed from the SURVIVING items, which is
          // what makes this correct after a revert truncated the thread.
          const tail = await readLog(threadId);
          const referenced = referencedAttachmentIds(tail.events);
          await sweepDirectory(attachmentsDirFor(threadId), nowMs, (id) => referenced.has(id));
        } catch {
          // One unreadable thread never stops the sweep of the others (§5.1).
          continue;
        }
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
        // a fragment: rebuild the accumulated body the same way the fold does.
        const state = foldThread(tail.events);
        return state.items.find((item) => item.id === itemId) ?? null;
      }
      return null;
    }
  };

  return store;
}
