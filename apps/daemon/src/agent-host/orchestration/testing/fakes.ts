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
  ProviderSessionBinding,
  ProviderSessionBindingPatch,
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
}

export function createFakeThreadStore(): FakeThreadStore {
  const logs = new Map<string, DomainEvent[]>();
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
