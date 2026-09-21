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
  RuntimeEvent,
  ThreadHead,
  AttachmentRef,
  AgentAdapterId
} from "@orquester/api/agent-chat";

import type {
  AppendResult,
  AppendableDomainEvent,
  AttachmentPutInput,
  CaptureResult,
  CheckpointService,
  Ingestion,
  ThreadStore,
  ThreadTail,
  TurnDiffSummary
} from "../../services.ts";
import type { AdapterLogger } from "../../adapter.ts";

// ---------------------------------------------------------------------------
// ThreadStore
// ---------------------------------------------------------------------------

export interface FakeThreadStore extends ThreadStore {
  /** Every event ever appended, per thread. */
  readonly logs: Map<string, DomainEvent[]>;
  readonly heads: Map<string, ThreadHead>;
  readonly receipts: Map<string, CommandReceipt>;
  readonly rawFrames: Array<{ threadId: string; frame: unknown }>;
  /** Cut the log at `index`, as a malformed line would (§5.1). */
  truncateAt(threadId: string, index: number): void;
  headSaves: number;
}

export function createFakeThreadStore(): FakeThreadStore {
  const logs = new Map<string, DomainEvent[]>();
  const heads = new Map<string, ThreadHead>();
  const receipts = new Map<string, CommandReceipt>();
  const attachments = new Map<string, string>();
  const rawFrames: Array<{ threadId: string; frame: unknown }> = [];
  const truncated = new Map<string, number>();
  const store = {
    logs,
    heads,
    receipts,
    rawFrames,
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
      for (const event of input.events) {
        const seq = log.length + 1;
        const persisted = { ...event, seq } as DomainEvent;
        log.push(persisted);
        stamped.push(persisted);
      }
      const seq = log.length;
      if (input.receipt) {
        // Written in the same step as the events.
        receipts.set(input.receipt.commandId, { ...input.receipt, seq });
      }
      return { seq, events: stamped };
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

    async loadHead(threadId: string): Promise<ThreadHead | null> {
      return heads.get(threadId) ?? null;
    },

    async saveHead(head: ThreadHead): Promise<void> {
      store.headSaves += 1;
      heads.set(head.id, { ...head });
    },

    async listThreads(): Promise<string[]> {
      return [...new Set([...logs.keys(), ...heads.keys()])];
    },

    async deleteThread(threadId: string): Promise<void> {
      logs.delete(threadId);
      heads.delete(threadId);
      truncated.delete(threadId);
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
        sizeBytes: 0
      };
    },

    async resolveAttachment(threadId: string, attachmentId: string): Promise<string> {
      const path = attachments.get(attachmentId);
      if (!path) {
        throw new Error(`Unknown attachment '${attachmentId}' on thread '${threadId}'.`);
      }
      return path;
    },

    async pruneAttachments(): Promise<void> {},

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
  readonly pruned: Array<{ threadId: string; targetTurnCount: number }>;
  readonly deleted: string[];
  /** Adapters whose rollback is refused (§5.5 step 2). Grok by default. */
  rollbackUnsupported: Set<AgentAdapterId>;
  diff: string;
  turnCount: number;
  /** Override what `captureBaseline` answers; `null` models a non-git project. */
  baseline?: CaptureResult | null;
}

export function createFakeCheckpointService(): FakeCheckpointService {
  const pruned: Array<{ threadId: string; targetTurnCount: number }> = [];
  const deleted: string[] = [];
  const fake: FakeCheckpointService = {
    pruned,
    deleted,
    rollbackUnsupported: new Set<AgentAdapterId>(["grok"]),
    diff: "",
    turnCount: 0,
    /**
     * A git-backed project by default. `null` is reserved for "this project
     * has no checkpoints at all"; an already-published baseline answers
     * `ready`, which is what the real service does from a thread's second turn
     * onwards. Set `fake.baseline = null` to model a non-git project.
     */
    async captureBaseline(input: { threadId: string }): Promise<CaptureResult | null> {
      return fake.baseline === undefined
        ? {
            turnCount: fake.turnCount,
            ref: `refs/orquester/checkpoints/${input.threadId}/turn/${fake.turnCount}`,
            status: "ready"
          }
        : fake.baseline;
    },
    async captureTurnEnd(input: {
      threadId: string;
      cwd: string;
      turnId: string | null;
      assistantMessageId: string | null;
    }): Promise<TurnDiffSummary | null> {
      fake.turnCount += 1;
      const files: CheckpointFile[] = [];
      const status: CheckpointStatus = "ready";
      return {
        turnCount: fake.turnCount,
        ref: `refs/orquester/checkpoints/${input.threadId}/turn/${fake.turnCount}`,
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
      pruned.push({ threadId: input.threadId, targetTurnCount: input.targetTurnCount });
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
