/**
 * Agent host — in-memory fakes of the `services.ts` seams (spec §9).
 *
 * Every package under the host codes against `ThreadStore`, `Ingestion` and
 * `CheckpointService`; these are the doubles that let one be built and tested
 * before its neighbour exists. They implement the interfaces honestly — the
 * store assigns a per-thread monotonic `seq` and writes the receipt in the same
 * step that appends the events, so a receipt never exists for events that did
 * not land (§5.1) — and they never sleep.
 */

import type {
  CheckpointFile,
  CheckpointStatus,
  CommandReceipt,
  DomainEvent,
  FoldSnapshotFile,
  RuntimeEvent,
  ProviderSessionBinding,
  ProviderSessionBindingPatch,
  ThreadFoldState,
  ThreadHead,
  AttachmentRef,
  AgentAdapterId
} from "@orquester/api/agent-chat";
import {
  FOLD_SNAPSHOT_VERSION,
  parseFoldSnapshotFile,
  serializeFoldState
} from "@orquester/api/agent-chat";

import type {
  AppendResult,
  AppendableDomainEvent,
  AttachmentPutInput,
  CaptureResult,
  CheckpointService,
  EventPosition,
  EventsFromResult,
  Ingestion,
  ThreadStore,
  ThreadTail,
  TurnDiffSummary
} from "../../services.ts";
import type { AdapterLogger } from "../../adapter.ts";
import { mergeSessionBinding } from "../../store/binding.ts";

// ---------------------------------------------------------------------------
// ThreadStore
// ---------------------------------------------------------------------------

export interface FakeThreadStore extends ThreadStore {
  /**
   * Every `pruneAttachments` call, in order. An entry that is `undefined` is
   * the argument-less host-wide sweep — the only form that reaches the
   * cross-thread raw-log ceiling (S1 #5).
   */
  readonly pruneCalls: Array<{ threadId?: string; now?: Date } | undefined>;
  /** Every event ever appended, per thread. */
  readonly logs: Map<string, DomainEvent[]>;
  readonly heads: Map<string, ThreadHead>;
  /** `binding.json`, per thread (§3.3). Survives a `createTestHost` restart. */
  readonly bindings: Map<string, ProviderSessionBinding>;
  readonly receipts: Map<string, CommandReceipt>;
  readonly rawFrames: Array<{ threadId: string; frame: unknown }>;
  /** Cut the log at `index`, as a malformed line would (§5.1). */
  truncateAt(threadId: string, index: number): void;
  headSaves: number;
  /**
   * `state.json` per thread, as `saveFoldSnapshot` wrote it (A2). Plant a
   * stale or broken snapshot here to drive the fallback: `loadFoldSnapshot`
   * validates it exactly as the real store validates the file.
   */
  readonly snapshots: Map<string, FoldSnapshotFile>;
}

export function createFakeThreadStore(): FakeThreadStore {
  /**
   * Positions are synthetic: every event "occupies" this many bytes, so the
   * line at log index `i` sits at `i * FAKE_LINE_BYTES`. Only the relations
   * between positions are the real store's contract — contiguous, starting
   * where the last append ended — and those hold here too. Derived from the
   * index at read time, so a test that pushes onto `logs` directly stays
   * consistent.
   */
  const FAKE_LINE_BYTES = 1000;
  const positionAt = (index: number, seq: number): EventPosition => ({
    seq,
    byteOffset: index * FAKE_LINE_BYTES,
    byteLength: FAKE_LINE_BYTES
  });
  const isCursorCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
  const lastSeqOf = (threadId: string): number => {
    const log = logs.get(threadId) ?? [];
    return log[log.length - 1]?.seq ?? 0;
  };
  const logBytesOf = (threadId: string): number =>
    (logs.get(threadId) ?? []).length * FAKE_LINE_BYTES;
  /** What the real store's trip through `state.json` does to a snapshot. */
  const throughDisk = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const logs = new Map<string, DomainEvent[]>();
  const snapshots = new Map<string, FoldSnapshotFile>();
  const heads = new Map<string, ThreadHead>();
  const bindings = new Map<string, ProviderSessionBinding>();
  const receipts = new Map<string, CommandReceipt>();
  const attachments = new Map<string, string>();
  const rawFrames: Array<{ threadId: string; frame: unknown }> = [];
  const pruneCalls: Array<{ threadId?: string; now?: Date } | undefined> = [];
  const truncated = new Map<string, number>();
  const store = {
    logs,
    heads,
    bindings,
    receipts,
    rawFrames,
    pruneCalls,
    snapshots,
    headSaves: 0,

    truncateAt(threadId: string, index: number): void {
      truncated.set(threadId, index);
    },

    async append(input: {
      threadId: string;
      events: AppendableDomainEvent[];
      receipt?: Omit<CommandReceipt, "seq">;
    }): Promise<AppendResult> {
      const log = logs.get(input.threadId) ?? [];
      logs.set(input.threadId, log);
      const stamped: DomainEvent[] = [];
      const positions: EventPosition[] = [];
      for (const event of input.events) {
        const seq = log.length + 1;
        const persisted = { ...event, seq } as DomainEvent;
        positions.push(positionAt(log.length, seq));
        log.push(persisted);
        stamped.push(persisted);
      }
      const seq = log.length;
      if (input.receipt) {
        // Written in the same step as the events.
        receipts.set(input.receipt.commandId, { ...input.receipt, seq });
      }
      return { seq, events: stamped, positions, logBytes: log.length * FAKE_LINE_BYTES };
    },

    async readTail(threadId: string, afterSeq: number): Promise<ThreadTail> {
      const log = logs.get(threadId) ?? [];
      const cut = truncated.get(threadId);
      const visible = cut === undefined ? log : log.slice(0, cut);
      return {
        events: visible.filter((event) => event.seq > afterSeq),
        seq: log.length,
        truncated: cut !== undefined
      };
    },

    async readAll(threadId: string): Promise<ThreadTail> {
      return store.readTail(threadId, 0);
    },

    /**
     * The real store's cursor rules over the synthetic positions: an offset
     * that is not a line boundary, past the end, or whose line does not carry
     * `afterSeq + 1` is a mismatch. A `truncateAt` cut is the malformed line:
     * a read stops before it (`truncated`), and a cursor at or past it is
     * stale.
     */
    async readEventsFrom(
      threadId: string,
      input: { byteOffset: number; afterSeq: number }
    ): Promise<EventsFromResult> {
      const log = logs.get(threadId) ?? [];
      const cut = Math.min(truncated.get(threadId) ?? log.length, log.length);
      const { byteOffset, afterSeq } = input;
      const stale: EventsFromResult = {
        events: [],
        positions: [],
        truncated: false,
        seq: afterSeq,
        logBytes: byteOffset,
        mismatch: true
      };
      if (
        !isCursorCount(byteOffset) ||
        !isCursorCount(afterSeq) ||
        byteOffset % FAKE_LINE_BYTES !== 0 ||
        byteOffset / FAKE_LINE_BYTES > log.length
      ) {
        return stale;
      }
      const start = byteOffset / FAKE_LINE_BYTES;
      if (start === log.length) {
        return { ...stale, mismatch: false };
      }
      if (start >= cut || log[start]!.seq !== afterSeq + 1) {
        return stale;
      }
      const events = log.slice(start, cut);
      return {
        events,
        positions: events.map((event, index) => positionAt(start + index, event.seq)),
        truncated: cut < log.length,
        seq: events[events.length - 1]!.seq,
        logBytes: cut * FAKE_LINE_BYTES,
        mismatch: false
      };
    },

    async readEventRange(
      threadId: string,
      input: { fromByte: number; toByte: number }
    ): Promise<{ events: DomainEvent[]; truncated: boolean }> {
      const { fromByte, toByte } = input;
      if (!isCursorCount(fromByte) || !isCursorCount(toByte) || toByte < fromByte) {
        throw new RangeError(`agent-chat: unusable byte range [${fromByte}, ${toByte})`);
      }
      if (fromByte === toByte) {
        return { events: [], truncated: false };
      }
      if (fromByte % FAKE_LINE_BYTES !== 0) {
        // Starts inside a line: nothing decodes.
        return { events: [], truncated: true };
      }
      const log = logs.get(threadId) ?? [];
      const cut = Math.min(truncated.get(threadId) ?? log.length, log.length);
      const start = fromByte / FAKE_LINE_BYTES;
      // Only lines whose newline falls inside the window are complete.
      const end = Math.floor(toByte / FAKE_LINE_BYTES);
      return {
        events: log.slice(start, Math.min(end, cut)),
        truncated: toByte % FAKE_LINE_BYTES !== 0 || end > cut
      };
    },

    async lastSeq(threadId: string): Promise<number> {
      return lastSeqOf(threadId);
    },

    async logLength(threadId: string): Promise<number> {
      return logBytesOf(threadId);
    },

    /**
     * The real store's rules: validated through `parseFoldSnapshotFile` after
     * a JSON round trip, and refused when it claims more of the log than
     * there is. Never throws.
     */
    async loadFoldSnapshot(threadId: string): Promise<FoldSnapshotFile | null> {
      const stored = snapshots.get(threadId);
      if (stored === undefined) {
        return null;
      }
      let snapshot: FoldSnapshotFile | null;
      try {
        snapshot = parseFoldSnapshotFile(throughDisk(stored), threadId);
      } catch {
        return null;
      }
      if (snapshot === null) {
        return null;
      }
      return snapshot.seq > lastSeqOf(threadId) || snapshot.logBytes > logBytesOf(threadId)
        ? null
        : snapshot;
    },

    /**
     * Stored synchronously, as a copy taken at call time (the real store
     * serialises before it queues). Refuses a state not folded to `seq`, and
     * drops a save the log cannot honour, exactly like the real store.
     */
    async saveFoldSnapshot(input: {
      threadId: string;
      seq: number;
      logBytes: number;
      state: ThreadFoldState;
      extras?: Record<string, unknown>;
    }): Promise<void> {
      if (input.state.seq !== input.seq) {
        throw new Error(
          `agent-chat: fold snapshot seq ${input.seq} does not match its state's seq ${input.state.seq}`
        );
      }
      if (
        logBytesOf(input.threadId) === 0 ||
        input.seq > lastSeqOf(input.threadId) ||
        input.logBytes > logBytesOf(input.threadId)
      ) {
        return;
      }
      snapshots.set(
        input.threadId,
        throughDisk({
          version: FOLD_SNAPSHOT_VERSION,
          threadId: input.threadId,
          seq: input.seq,
          logBytes: input.logBytes,
          writtenAt: new Date(0).toISOString(),
          state: serializeFoldState(input.state),
          ...(input.extras !== undefined ? { extras: input.extras } : {})
        })
      );
    },

    async loadHead(threadId: string): Promise<ThreadHead | null> {
      return heads.get(threadId) ?? null;
    },

    async saveHead(head: ThreadHead): Promise<void> {
      store.headSaves += 1;
      heads.set(head.id, { ...head });
    },

    async loadBinding(threadId: string): Promise<ProviderSessionBinding | null> {
      const binding = bindings.get(threadId);
      return binding === undefined ? null : { ...binding };
    },

    async upsertSessionBinding(input: {
      threadId: string;
      adapter: AgentAdapterId;
      patch: ProviderSessionBindingPatch;
    }): Promise<ProviderSessionBinding> {
      const merged = mergeSessionBinding({
        threadId: input.threadId,
        existing: bindings.get(input.threadId) ?? null,
        patch: input.patch,
        fallbackAdapter: input.adapter,
        now: new Date(0).toISOString()
      });
      bindings.set(input.threadId, merged);
      return { ...merged };
    },

    async listThreads(): Promise<string[]> {
      return [...new Set([...logs.keys(), ...heads.keys()])];
    },

    async deleteThread(threadId: string): Promise<void> {
      logs.delete(threadId);
      heads.delete(threadId);
      bindings.delete(threadId);
      truncated.delete(threadId);
      snapshots.delete(threadId);
      for (const [id, commandId] of [...receipts]) {
        if (commandId.threadId === threadId) receipts.delete(id);
      }
    },

    async getReceipt(commandId: string): Promise<CommandReceipt | null> {
      return receipts.get(commandId) ?? null;
    },

    async putReceipt(receipt: CommandReceipt): Promise<void> {
      receipts.set(receipt.commandId, receipt);
    },

    async putAttachment(input: AttachmentPutInput): Promise<AttachmentRef> {
      const id = `${input.threadId}-${attachments.size + 1}`;
      attachments.set(id, input.sourcePath);
      return {
        type: "file",
        id,
        name: input.name,
        ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
        sizeBytes: 0,
        // Mirrors the real store: the upload reply names the absolute path (§7.4).
        path: input.sourcePath
      };
    },

    async resolveAttachment(threadId: string, attachmentId: string): Promise<string> {
      const path = attachments.get(attachmentId);
      if (!path) {
        throw new Error(`Unknown attachment '${attachmentId}' on thread '${threadId}'.`);
      }
      return path;
    },

    async pruneAttachments(input?: { threadId?: string; now?: Date }): Promise<void> {
      pruneCalls.push(input);
    },

    logRawFrame(threadId: string, frame: unknown): void {
      rawFrames.push({ threadId, frame });
    },

    async drain(): Promise<void> {}
  } satisfies FakeThreadStore;
  return store;
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export interface FakeIngestion extends Ingestion {
  readonly ingested: RuntimeEvent[];
  readonly flushedTurns: Array<{ threadId: string; turnId: string | undefined }>;
  readonly flushedThreads: string[];
  /** Threads released through `Ingestion.forget` (Q1 #9). */
  readonly forgottenThreads: string[];
  /** What to append for a given runtime event, if anything. */
  translate?: (event: RuntimeEvent) => AppendableDomainEvent[];
}

export function createFakeIngestion(input: {
  sink?: (threadId: string, events: AppendableDomainEvent[]) => Promise<void>;
}): FakeIngestion {
  const ingested: RuntimeEvent[] = [];
  const flushedTurns: Array<{ threadId: string; turnId: string | undefined }> = [];
  const flushedThreads: string[] = [];
  const forgottenThreads: string[] = [];
  const fake: FakeIngestion = {
    ingested,
    flushedTurns,
    flushedThreads,
    forgottenThreads,
    async ingest(event: RuntimeEvent): Promise<void> {
      ingested.push(event);
      const events = fake.translate?.(event) ?? [];
      if (events.length > 0 && input.sink) {
        await input.sink(event.threadId, events);
      }
    },
    async flushTurn(threadId: string, turnId: string | undefined): Promise<void> {
      flushedTurns.push({ threadId, turnId });
    },
    async finalizeReasoning(): Promise<void> {},
    async flushThread(threadId: string): Promise<void> {
      flushedThreads.push(threadId);
    },
    async forget(threadId: string): Promise<void> {
      forgottenThreads.push(threadId);
    },
    async drain(): Promise<void> {}
  };
  return fake;
}

// ---------------------------------------------------------------------------
// CheckpointService
// ---------------------------------------------------------------------------

export interface FakeCheckpointService extends CheckpointService {
  /** Every `pruneAbove`, in order; `droppedTurnCounts` is `[]` when none was named. */
  readonly pruned: Array<{
    threadId: string;
    targetTurnCount: number;
    droppedTurnCounts: number[];
  }>;
  readonly deleted: string[];
  /** Thread ids a baseline was requested for, in order. */
  readonly baselines: string[];
  /**
   * Every `captureBaseline` request as the host made it, in order — the turn it
   * precedes and the count it named (§5.5: checkpoints count turns by order).
   */
  readonly baselineRequests: Array<{
    threadId: string;
    turnId?: string | null;
    turnCount?: number;
  }>;
  /** Every `captureTurnEnd` request, in order, with the ordinal the host named. */
  readonly turnEndRequests: Array<{
    threadId: string;
    turnId: string | null;
    turnCount?: number;
  }>;
  /** Set to model a project that is not a git repo (§5.4 skips silently). */
  nonGit: boolean;
  /** Adapters whose rollback is refused (§5.5 step 2). Grok by default. */
  rollbackUnsupported: Set<AgentAdapterId>;
  diff: string;
  /**
   * The derived counter: what a capture falls back to when the host names no
   * `turnCount`. A named count wins and advances this to at least itself, the
   * way the real service's "highest existing + 1" would.
   */
  turnCount: number;
  /** Override what `captureBaseline` answers; `null` models a non-git project. */
  baseline?: CaptureResult | null;
}

export function createFakeCheckpointService(): FakeCheckpointService {
  const pruned: FakeCheckpointService["pruned"] = [];
  const deleted: string[] = [];
  const baselines: string[] = [];
  const baselineRequests: FakeCheckpointService["baselineRequests"] = [];
  const turnEndRequests: FakeCheckpointService["turnEndRequests"] = [];
  const fake: FakeCheckpointService = {
    pruned,
    deleted,
    baselines,
    baselineRequests,
    turnEndRequests,
    nonGit: false,
    rollbackUnsupported: new Set<AgentAdapterId>(["grok"]),
    diff: "",
    turnCount: 0,
    /**
     * A git-backed project by default. `null` is reserved for "this project
     * has no checkpoints at all"; an already-published baseline answers
     * `ready`, which is what the real service does from a thread's second turn
     * onwards. Set `fake.baseline = null` to model a non-git project.
     */
    async captureBaseline(input: {
      threadId: string;
      turnId?: string | null;
      turnCount?: number;
    }): Promise<CaptureResult | null> {
      // Recorded so a test can assert WHEN the baseline was taken, not just
      // what it answered — the §5.4 ordering is the thing under test.
      baselines.push(input.threadId);
      baselineRequests.push({
        threadId: input.threadId,
        ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
        ...(input.turnCount !== undefined ? { turnCount: input.turnCount } : {})
      });
      const turnCount = input.turnCount ?? fake.turnCount;
      return fake.baseline === undefined
        ? {
            turnCount,
            ref: `refs/orquester/checkpoints/${input.threadId}/turn/${turnCount}`,
            status: "ready"
          }
        : fake.baseline;
    },
    async captureTurnEnd(input: {
      threadId: string;
      cwd: string;
      turnId: string | null;
      assistantMessageId: string | null;
      turnCount?: number;
    }): Promise<TurnDiffSummary | null> {
      turnEndRequests.push({
        threadId: input.threadId,
        turnId: input.turnId,
        ...(input.turnCount !== undefined ? { turnCount: input.turnCount } : {})
      });
      // The turn's ordinal when the host names it; the counter otherwise.
      const turnCount = input.turnCount ?? fake.turnCount + 1;
      fake.turnCount = Math.max(fake.turnCount, turnCount);
      const files: CheckpointFile[] = [];
      const status: CheckpointStatus = "ready";
      return {
        turnCount,
        ref: `refs/orquester/checkpoints/${input.threadId}/turn/${turnCount}`,
        status,
        turnId: input.turnId,
        files,
        assistantMessageId: input.assistantMessageId,
        completedAt: new Date(0).toISOString()
      };
    },
    async readTurnDiff(): Promise<string> {
      return fake.diff;
    },
    async pruneAbove(input): Promise<void> {
      pruned.push({
        threadId: input.threadId,
        targetTurnCount: input.targetTurnCount,
        droppedTurnCounts: [...(input.droppedTurnCounts ?? [])]
      });
    },
    async deleteThreadRefs(input): Promise<void> {
      deleted.push(input.threadId);
    },
    assertRollbackSupported(adapter: AgentAdapterId): void {
      if (fake.rollbackUnsupported.has(adapter)) {
        throw new Error(`${adapter} cannot rewind a conversation.`);
      }
    }
  };
  return fake;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface RecordingLogger extends AdapterLogger {
  readonly entries: Array<{ level: string; message: string; detail?: unknown }>;
}

export function createRecordingLogger(): RecordingLogger {
  const entries: Array<{ level: string; message: string; detail?: unknown }> = [];
  const push = (level: string) => (message: string, detail?: unknown) => {
    entries.push({ level, message, detail });
  };
  return {
    entries,
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error")
  };
}

// ---------------------------------------------------------------------------
// Deterministic clock and ids
// ---------------------------------------------------------------------------

export interface TestClock {
  now(): Date;
  nowIso(): string;
  advance(ms: number): void;
  set(ms: number): void;
}

export function createTestClock(startMs = 0): TestClock {
  let current = startMs;
  return {
    now: () => new Date(current),
    nowIso: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    }
  };
}

export function createTestIdGen(): {
  eventId(): string;
  messageId(prefix: string): string;
  uuid(): string;
} {
  let counter = 0;
  const next = (): number => {
    counter += 1;
    return counter;
  };
  return {
    eventId: () => `evt-${next()}`,
    messageId: (prefix: string) => `${prefix}${next()}`,
    uuid: () => `uuid-${next()}`
  };
}

/** A manual timer wheel: nothing in a test ever waits on real elapsed time. */
export interface TestTimers {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Run every timer whose deadline is at or below `nowMs`. */
  runDue(nowMs: number): void;
  readonly pending: number;
}

export function createTestTimers(): TestTimers {
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let elapsed = 0;
  return {
    setTimer(fn: () => void, ms: number): unknown {
      nextId += 1;
      timers.set(nextId, { at: elapsed + ms, fn });
      return nextId;
    },
    clearTimer(handle: unknown): void {
      if (typeof handle === "number") timers.delete(handle);
    },
    runDue(nowMs: number): void {
      elapsed = nowMs;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= nowMs) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    get pending() {
      return timers.size;
    }
  };
}
