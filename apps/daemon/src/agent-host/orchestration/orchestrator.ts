/**
 * Agent host — orchestration (spec §3.1, §3.3, §3.4, §4.1 rules, §5.5, §6.2, §6.3).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` (the serial
 * command queue, the receipt-first check, append + project + receipt in one
 * step and publication strictly after commit),
 * `apps/server/src/orchestration/decider.ts` (each command's invariants and the
 * event it decides to) and
 * `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` (session
 * ensure/restart, steering, the settle-then-interrupt order, the compaction
 * queue and the `provider.*.failed` activities).
 *
 * Two differences from T3, both deliberate:
 * - the command queue is **per thread**, not one global worker fiber: one slow
 *   provider must not stall every other tab (§3.1);
 * - a command's provider side effect runs on a second per-thread queue after
 *   the receipt has landed, because §6.2 requires `/turn` to answer as soon as
 *   the command is recorded and a provider-side failure to surface as a
 *   timeline row rather than an HTTP error.
 */

import {
  COMMANDS_ALLOWED_IN_ERROR_STATE,
  DEFAULT_RUNTIME_MODE,
  SETTLED_TURN_STATES,
  type AgentAdapterId,
  type AgentChatCommandName,
  type AgentChatSessionSummaryFields,
  type AttachmentRef,
  type DomainEvent,
  type InteractionMode,
  type ModelSelection,
  type ProviderSession,
  type ProviderSnapshot,
  type RuntimeEvent,
  type RuntimeMode,
  type ThreadActivityItem,
  type ThreadFoldState,
  type ThreadHead,
  type ThreadItem,
  type ThreadReadResponse,
  type ThreadSessionState,
  type ThreadSessionStatus,
  type ThreadSnapshotPayload,
  type Turn,
  AGENT_CHAT_REPLAY_MAX_EVENTS,
  AGENT_CHAT_REPLAY_PAYLOAD_BUDGET_BYTES
} from "@orquester/api/agent-chat";

import type { AccountHome } from "@orquester/api/agent-chat";

import type { AdapterLogger, AgentAdapter } from "../adapter.ts";
import {
  CONTINUATION_FAILED_MESSAGE,
  CONTINUATION_PROMPT,
  COMPACTION_FAILED_MESSAGE,
  type CreateHostThreadRequest
} from "../host-protocol.ts";
import type {
  AppendableDomainEvent,
  CaptureResult,
  CheckpointService,
  Ingestion,
  LivenessRegistry,
  ProviderSnapshotRegistry,
  ThreadStore
} from "../services.ts";
import {
  CheckpointRefUnavailableError,
  CheckpointTurnRangeError
} from "../checkpoints/index.ts";
import { createEventBuilder, describeFailure, makeActivity, type BuildEvent } from "./events.ts";
import {
  AgentChatCommandError,
  commandRejected,
  compactionUnavailable,
  invalidCommand,
  isAgentChatCommandError,
  replayRecordedRejection,
  threadNotFound
} from "./errors.ts";
import { DEFAULT_FOLD_OPS, type FoldOps } from "./fold-ops.ts";
import {
  createDeferred,
  createSerialQueue,
  systemClock,
  systemIdGen,
  type Clock,
  type Deferred,
  type IdGen,
  type SerialQueue
} from "./runtime-seams.ts";
import {
  decideSessionRestart,
  modelSelectionEquals,
  type BoundSessionShape,
  type DesiredSessionShape
} from "./session-policy.ts";
import { COMPACT_COMMAND_TEXT, isHostNativeCompact, providerInputFor } from "./slash.ts";
import { createTurnWatchdog, stalledTurnMessage, type TurnWatchdog } from "./turn-watchdog.ts";
import { checkMinimumVersion, MINIMUM_CLI_VERSIONS } from "./version-gate.ts";
import {
  parseAnswers,
  parseApprovalDecision,
  parseAttachments,
  parseAttachmentsByQuestionId,
  parseComposerContext,
  parseInteractionMode,
  parseModelSelection,
  parseOptionalTurnId,
  parseRequestId,
  parseRuntimeMode,
  parseTargetTurnCount,
  parseTurnInput,
  requireBody,
  requireCommandId
} from "./validate.ts";
import { isUsableConversationId, resumeCursorFor } from "./resume.ts";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ResolvedLaunch {
  adapter: AgentAdapterId;
  home: AccountHome;
}

/**
 * The store plus the two optional members W2's implementation adds beyond the
 * `ThreadStore` seam: the parse message for a thread that could not be read,
 * and the backwards log scan that serves a `GET …/items/:id` for a row the
 * fold's retention window already dropped.
 */
export type HostThreadStore = ThreadStore & {
  threadError?(threadId: string): string | null;
  readItem?(threadId: string, itemId: string): Promise<ThreadItem | null>;
};

export interface OrchestratorOptions {
  store: HostThreadStore;
  ingestion: Ingestion;
  checkpoints: CheckpointService;
  liveness: LivenessRegistry;
  snapshots: ProviderSnapshotRegistry;
  /** Acquired before the command gate opens (§3.1) — never lazily imported (§8). */
  adapters: ReadonlyMap<AgentAdapterId, AgentAdapter>;
  logger: AdapterLogger;
  hostInstanceId: string;
  /** Registry id (`claude`, `claudex`, `codex`, …) → adapter id, from the catalog. */
  adapterForRefId(refId: string): AgentAdapterId | null;
  /** Absolute home dir for a thread's account (§3.1). Host-side only. */
  resolveHome(input: {
    adapter: AgentAdapterId;
    refId: string;
    accountId: string;
    home: "system" | "account" | "cliproxy";
  }): Promise<AccountHome>;
  /**
   * §3.3: continuation is opt-in per project over a host-wide default that is
   * **off**, because "pick up where you left off" is wrong for a project where
   * a turn was halfway through a destructive operation.
   */
  continuationEnabled?(projectPath: string): boolean | Promise<boolean>;
  /** A tab the user closed: settled on the next boot, never continued (§3.3). */
  isThreadClosed?(threadId: string): boolean | Promise<boolean>;
  clock?: Clock;
  ids?: IdGen;
  fold?: FoldOps;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  minimumVersions?: Readonly<Record<AgentAdapterId, string | null>>;
}

export interface ThreadSubscription {
  /** Stamped events, in order, exactly as they were persisted. */
  onEvents(events: DomainEvent[]): void;
}

// ---------------------------------------------------------------------------
// Per-thread runtime state
// ---------------------------------------------------------------------------

interface QueuedTurn {
  messageId: string;
  input: string;
  attachments: AttachmentRef[];
  interactionMode: InteractionMode;
  modelSelection?: ModelSelection;
}

interface ThreadRuntime {
  id: string;
  /** Decide + append + receipt, one at a time (§6.2 "Ordering"). */
  commands: SerialQueue;
  /** Provider work, one at a time (§3.1 "one command at a time"). */
  effects: SerialQueue;
  /**
   * Checkpoint capture, on its own queue: git work must never sit in front of
   * an interrupt, and a capture or diff failure never fails the turn (§5.4).
   */
  captures: SerialQueue;
  state: ThreadFoldState;
  /**
   * `continueAfterRestart` is head-only state: no domain event carries it, so
   * it lives in `meta.json` and is merged back onto every projected head.
   */
  continueAfterRestart: ThreadHead["continueAfterRestart"];
  eventsSinceHeadSave: number;
  compacting: boolean;
  queuedTurns: QueuedTurn[];
  bound: BoundSessionShape | null;
  watchdog: TurnWatchdog | null;
  subscribers: Set<ThreadSubscription>;
  /**
   * §5.1: a thread directory that fails to parse marks **that thread** `error`
   * with the parse message; it never affects another thread or host startup.
   */
  parseError: string | null;
  deleted: boolean;
}

const HEAD_SAVE_EVENT_INTERVAL = 50;

/** Events that change `meta.json`'s own fields, so the head is rewritten. */
const HEAD_WRITING_EVENTS: ReadonlySet<string> = new Set([
  "thread.created",
  "thread.meta-updated",
  "thread.runtime-mode-set",
  "thread.session-set",
  "thread.turn-diff-completed",
  "thread.reverted",
  "thread.deleted"
]);

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

export interface Orchestrator {
  /** Resolves when the gate opens; rejects with the startup error (§3.1). */
  readonly ready: Promise<void>;
  openGate(): void;
  failGate(error: unknown): void;
  /** Queue until the gate opens, then run in arrival order (§3.1). */
  whenReady<T>(task: () => Promise<T>): Promise<T>;

  createThread(request: CreateHostThreadRequest): Promise<ThreadHead>;
  updateThread(threadId: string, input: { title?: string }): Promise<{ seq: number }>;
  deleteThread(threadId: string): Promise<void>;

  command(
    threadId: string,
    name: AgentChatCommandName,
    body: unknown
  ): Promise<{ seq: number }>;

  readThread(threadId: string, afterSeq?: number): Promise<ThreadReadResponse>;
  readItem(threadId: string, itemId: string): Promise<ThreadItem | null>;
  readTurnDiff(
    threadId: string,
    turnCount: number,
    options?: { ignoreWhitespace?: boolean }
  ): Promise<{ fromTurnCount: number; toTurnCount: number; diff: string } | null>;
  summary(threadId: string): AgentChatSessionSummaryFields | null;

  subscribe(threadId: string, subscription: ThreadSubscription): Promise<() => void>;

  providers(): ProviderSnapshot[];
  refreshProvider(
    adapterId: AgentAdapterId,
    input?: { cwd?: string }
  ): Promise<{ provider: ProviderSnapshot; changed: boolean }>;

  /** `GET /health` — the drain-restart of §3.1 waits on `activeTurnThreadIds`. */
  liveThreadIds(): string[];
  activeTurnThreadIds(): string[];

  /** §3.3 step 1, for an intentional stop. Returns the threads it marked. */
  markThreadsForContinuation(): Promise<string[]>;
  clearContinuationMarkers(threadIds: readonly string[]): Promise<void>;

  /** §3.3, run before the gate opens. Never throws. */
  reconcile(): Promise<void>;
  /** Consume one adapter's event stream. Forked once per adapter at startup. */
  consume(adapter: AgentAdapter): Promise<void>;
  /** Flush every queue — the drain seam tests wait on instead of sleeping (§9). */
  drain(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Where `createIngestion({sink})` delivers translated domain events (§5.1).
   * They are appended through the store, in order, on the thread's own command
   * queue, so an ingestion append can never interleave with a command's.
   */
  ingestionSink(threadId: string, events: AppendableDomainEvent[]): Promise<void>;
}

export function createOrchestrator(options: OrchestratorOptions): Orchestrator {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? systemIdGen;
  const fold = options.fold ?? DEFAULT_FOLD_OPS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const buildEvent: BuildEvent = createEventBuilder({ clock, ids });
  const { store, ingestion, checkpoints, liveness, snapshots, logger } = options;

  const runtimes = new Map<string, ThreadRuntime>();
  const gate: Deferred<void> = createDeferred<void>();
  const gateQueue = createSerialQueue();
  let gateOpen = false;
  let stopped = false;

  // -------------------------------------------------------------------------
  // The readiness gate (§3.1 "Readiness is a gate, not a race")
  // -------------------------------------------------------------------------

  const whenReady = <T>(task: () => Promise<T>): Promise<T> => {
    if (gateOpen) {
      return task();
    }
    // Commands that arrive before the gate opens are queued and run in arrival
    // order once it resolves; if startup fails, the gate is failed with that
    // error and every queued and subsequent command answers with it rather
    // than hanging (§3.1). One at a time, like T3's single command worker.
    return gateQueue.run(async () => {
      await gate.promise;
      return task();
    });
  };

  const openGate = (): void => {
    if (gateOpen) return;
    gateOpen = true;
    gate.resolve();
  };

  const failGate = (error: unknown): void => {
    gate.reject(error);
  };

  // -------------------------------------------------------------------------
  // Thread runtimes
  // -------------------------------------------------------------------------

  const adapterFor = (adapterId: AgentAdapterId): AgentAdapter => {
    const adapter = options.adapters.get(adapterId);
    if (!adapter) {
      throw new Error(`No adapter registered for '${adapterId}'.`);
    }
    return adapter;
  };

  const loadRuntime = async (threadId: string): Promise<ThreadRuntime> => {
    const existing = runtimes.get(threadId);
    if (existing) {
      return existing;
    }
    const tail = await store.readAll(threadId);
    const state = fold.foldAll(tail.events);
    const persistedHead = await store.loadHead(threadId).catch(() => null);
    const runtime: ThreadRuntime = {
      id: threadId,
      commands: createSerialQueue(),
      effects: createSerialQueue(),
      captures: createSerialQueue(),
      state,
      continueAfterRestart: persistedHead?.continueAfterRestart,
      eventsSinceHeadSave: 0,
      compacting: false,
      queuedTurns: [],
      bound: null,
      watchdog: null,
      subscribers: new Set(),
      parseError: store.threadError?.(threadId) ?? null,
      deleted: state.deleted
    };
    runtimes.set(threadId, runtime);
    return runtime;
  };

  const headOf = (runtime: ThreadRuntime): ThreadHead | null => {
    const head = runtime.state.head;
    if (!head) return null;
    return runtime.continueAfterRestart === undefined
      ? head
      : { ...head, continueAfterRestart: runtime.continueAfterRestart };
  };

  const requireHead = (runtime: ThreadRuntime): ThreadHead => {
    const head = headOf(runtime);
    if (!head || runtime.deleted) {
      if (runtime.parseError !== null && !runtime.deleted) {
        // The thread exists but its log could not be read: that thread alone
        // is in error, and the message says why (§5.1).
        throw commandRejected(`This thread could not be read: ${runtime.parseError}`);
      }
      throw threadNotFound(runtime.id);
    }
    return head;
  };

  const publish = (runtime: ThreadRuntime, events: DomainEvent[]): void => {
    if (events.length === 0) return;
    for (const subscriber of [...runtime.subscribers]) {
      try {
        subscriber.onEvents(events);
      } catch (error) {
        logger.warn("agent-host: thread subscriber failed", error);
      }
    }
  };

  const saveHeadNow = async (runtime: ThreadRuntime): Promise<void> => {
    const head = headOf(runtime);
    if (!head) return;
    runtime.eventsSinceHeadSave = 0;
    try {
      await store.saveHead(head);
    } catch (error) {
      logger.warn(`agent-host: failed to persist meta.json for ${runtime.id}`, error);
    }
  };

  /**
   * The one write path. Events, their projection and (when given) the receipt
   * land in one step, and nothing is published until they have.
   */
  const commit = async (
    runtime: ThreadRuntime,
    events: AppendableDomainEvent[],
    receipt?: { commandId: string; status: "accepted" | "rejected"; error?: AgentChatCommandError }
  ): Promise<{ seq: number; events: DomainEvent[] }> => {
    const result = await store.append({
      threadId: runtime.id,
      events,
      ...(receipt
        ? {
            receipt: {
              commandId: receipt.commandId,
              threadId: runtime.id,
              status: receipt.status,
              acceptedAt: clock.nowIso(),
              ...(receipt.error
                ? {
                    error: {
                      code: receipt.error.code,
                      message: receipt.error.message,
                      ...(receipt.error.detail !== undefined
                        ? { detail: receipt.error.detail }
                        : {})
                    }
                  }
                : {})
            }
          }
        : {})
    });
    for (const event of result.events) {
      runtime.state = fold.apply(runtime.state, event);
      if (event.type === "thread.deleted") {
        runtime.deleted = true;
      }
    }
    runtime.eventsSinceHeadSave += result.events.length;
    publish(runtime, result.events);
    // Rewritten every 50 events and on every head-shaped change (§5.1). A
    // session transition always writes: the §3.3 reconcile reads `meta.json`
    // alone, so a head that lagged behind the log would make a live turn look
    // settled on the next boot.
    const headChanged = result.events.some((event) => HEAD_WRITING_EVENTS.has(event.type));
    if (runtime.eventsSinceHeadSave >= HEAD_SAVE_EVENT_INTERVAL || headChanged) {
      await saveHeadNow(runtime);
    }
    return result;
  };

  /** Append outside a command (ingestion, provider failures, reconcile). */
  const append = (runtime: ThreadRuntime, events: AppendableDomainEvent[]): Promise<{ seq: number }> =>
    runtime.commands.run(async () => {
      if (events.length === 0) {
        return { seq: runtime.state.seq };
      }
      return commit(runtime, events);
    });

  const appendActivity = async (
    runtime: ThreadRuntime,
    input: {
      id?: string;
      kind: string;
      summary: string;
      detail?: string;
      tone?: ThreadActivityItem["tone"];
      turnId?: string | null;
      requestId?: string;
      payload?: Record<string, unknown>;
    }
  ): Promise<void> => {
    const createdAt = clock.nowIso();
    const activity = makeActivity({
      id: input.id ?? ids.eventId(),
      tone: input.tone ?? "error",
      activityKind: input.kind,
      summary: input.summary,
      payload: {
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        ...(input.payload ?? {})
      },
      turnId: input.turnId ?? runtime.state.head?.session.activeTurnId ?? null,
      createdAt
    });
    await append(runtime, [
      buildEvent(runtime.id, "thread.activity-appended", { activity }, { occurredAt: createdAt })
    ]);
  };

  const persistSession = async (
    runtime: ThreadRuntime,
    session: ThreadSessionState
  ): Promise<void> => {
    await append(runtime, [buildEvent(runtime.id, "thread.session-set", { session })]);
  };

  const currentSession = (runtime: ThreadRuntime): ThreadSessionState =>
    runtime.state.head?.session ?? { status: "idle", activeTurnId: null };

  // -------------------------------------------------------------------------
  // Session lifecycle (§3.4 + §4.1 lazy recovery)
  // -------------------------------------------------------------------------

  const desiredShapeFor = (head: ThreadHead): DesiredSessionShape => ({
    adapter: head.adapter,
    runtimeMode: head.runtimeMode,
    cwd: head.cwd,
    accountKey: `${head.home}:${head.accountId}`,
    modelSelection: head.modelSelection
  });

  const mapSessionStatus = (
    status: ProviderSession["status"],
    pendingTurnStart: boolean
  ): ThreadSessionStatus =>
    // A `ready` session with a turn start pending is reported as `starting`, so
    // the UI never shows idle between the restart and the send
    // (*T3: `ProviderCommandReactor.ts:734-750`*).
    pendingTurnStart && status === "ready" ? "starting" : status;

  const stopStaleSessions = async (runtime: ThreadRuntime, keep: AgentAdapterId): Promise<void> => {
    // One live session per thread: a resume cursor must never be advanced by
    // two processes (*T3: `ProviderService.ts:1362-1394`*).
    for (const [adapterId, adapter] of options.adapters) {
      if (adapterId === keep) continue;
      if (!adapter.hasSession(runtime.id)) continue;
      try {
        await adapter.stopSession(runtime.id);
      } catch (error) {
        logger.warn(`agent-host: failed to stop stale ${adapterId} session`, error);
      }
    }
  };

  /**
   * §3.4: "the check runs on the send path, not beside it". Either returns the
   * live session or restarts it and rebinds, and only then does the caller
   * send. Nothing else starts sessions.
   */
  const ensureSession = async (
    runtime: ThreadRuntime,
    opts: { pendingTurnStart?: boolean } = {}
  ): Promise<ProviderSession> => {
    const head = requireHead(runtime);
    const adapter = adapterFor(head.adapter);
    const desired = desiredShapeFor(head);
    const pendingTurnStart = opts.pendingTurnStart === true;

    const bound = runtime.bound;
    if (bound && adapter.hasSession(runtime.id) && bound.session.status !== "stopped") {
      const decision = decideSessionRestart({
        desired,
        bound,
        capabilities: adapter.capabilities
      });
      if (!decision.restart) {
        snapshots.ensureWorkspaceSnapshot(head.adapter, head.cwd);
        return bound.session;
      }
      logger.info("agent-host: restarting provider session", {
        threadId: runtime.id,
        reasons: decision.reasons
      });
      try {
        await adapter.stopSession(runtime.id);
      } catch (error) {
        logger.warn("agent-host: failed to stop session before restart", error);
      }
      const cursor = decision.carryResumeCursor
        ? (bound.session.resumeCursor ?? head.session.resumeCursor)
        : undefined;
      return startSession(runtime, head, desired, cursor, pendingTurnStart);
    }

    await stopStaleSessions(runtime, head.adapter);
    // Lazy recovery (§4.1): a crashed, OOM-killed or restarted session is
    // indistinguishable from a fresh one — start from the persisted cursor.
    return startSession(runtime, head, desired, head.session.resumeCursor, pendingTurnStart);
  };

  const startSession = async (
    runtime: ThreadRuntime,
    head: ThreadHead,
    desired: DesiredSessionShape,
    resumeCursor: unknown,
    pendingTurnStart: boolean
  ): Promise<ProviderSession> => {
    const adapter = adapterFor(head.adapter);
    // §3.2: an out-of-range CLI is refused with the required version in the
    // message rather than started and allowed to fail on the first frame.
    const gateResult = checkMinimumVersion({
      adapter: head.adapter,
      version: snapshots.get(head.adapter)?.version ?? null,
      minimums: options.minimumVersions ?? MINIMUM_CLI_VERSIONS
    });
    if (!gateResult.ok) {
      throw new Error(gateResult.message);
    }
    const home = await options.resolveHome({
      adapter: head.adapter,
      refId: head.refId,
      accountId: head.accountId,
      home: head.home
    });
    const session = await adapter.startSession({
      threadId: runtime.id,
      cwd: head.cwd,
      home,
      title: head.title,
      modelSelection: head.modelSelection,
      runtimeMode: head.runtimeMode,
      ...(resumeCursor !== undefined ? { resumeCursor } : {})
    });
    runtime.bound = { ...desired, session };
    await persistSession(runtime, {
      status: mapSessionStatus(session.status, pendingTurnStart),
      activeTurnId: session.activeTurnId ?? null,
      ...(session.resumeCursor !== undefined
        ? { resumeCursor: session.resumeCursor }
        : resumeCursor !== undefined
          ? { resumeCursor }
          : {}),
      ...(session.lastError !== undefined ? { lastError: session.lastError } : {})
    });
    // Forked off the session start so it never delays a turn (§4.6.4).
    snapshots.ensureWorkspaceSnapshot(head.adapter, head.cwd);
    return session;
  };

  /**
   * §4.1: every pending approval and user-input request is resolved with
   * `cancel` and emitted as `request.resolved` / `user-input.resolved`
   * **before** `interruptTurn` or `stopSession` reaches the provider.
   *
   * Not a UI nicety: a transport that answers server requests inline on its
   * read loop is blocked by an open prompt, so cancelling after the interrupt
   * RPC deadlocks Stop exactly when a card is open (§3.1).
   */
  const settlePendingRequests = async (runtime: ThreadRuntime): Promise<void> => {
    const pending = runtime.state.pending;
    const approvals = pending?.approvals ?? [];
    const userInputs = pending?.userInputs ?? [];
    if (approvals.length === 0 && userInputs.length === 0) {
      return;
    }
    const head = headOf(runtime);
    const adapter = head ? options.adapters.get(head.adapter) : undefined;
    const createdAt = clock.nowIso();
    const events: AppendableDomainEvent[] = [];
    for (const approval of approvals) {
      events.push(
        buildEvent(
          runtime.id,
          "thread.activity-appended",
          {
            activity: makeActivity({
              id: `settle-cancel:${approval.requestId}`,
              tone: "info",
              activityKind: "approval.resolved",
              summary: "Request cancelled",
              payload: { requestId: approval.requestId, decision: "cancel" },
              turnId: currentSession(runtime).activeTurnId,
              createdAt
            })
          },
          { occurredAt: createdAt, metadata: { requestId: approval.requestId } }
        )
      );
    }
    for (const question of userInputs) {
      events.push(
        buildEvent(
          runtime.id,
          "thread.activity-appended",
          {
            activity: makeActivity({
              id: `settle-cancel:${question.requestId}`,
              tone: "info",
              activityKind: "user-input.resolved",
              summary: "Question cancelled",
              payload: { requestId: question.requestId },
              turnId: currentSession(runtime).activeTurnId,
              createdAt
            })
          },
          { occurredAt: createdAt, metadata: { requestId: question.requestId } }
        )
      );
    }
    await append(runtime, events);
    if (!adapter) return;
    for (const approval of approvals) {
      try {
        await adapter.respondToApproval(runtime.id, approval.requestId, "cancel");
      } catch (error) {
        logger.warn("agent-host: failed to cancel a pending approval", error);
      }
    }
    for (const question of userInputs) {
      try {
        await adapter.respondToUserInput(runtime.id, question.requestId, {});
      } catch (error) {
        logger.warn("agent-host: failed to cancel a pending question", error);
      }
    }
  };

  const stopSessionInternal = async (runtime: ThreadRuntime): Promise<void> => {
    const head = headOf(runtime);
    if (!head) return;
    const adapter = options.adapters.get(head.adapter);
    runtime.watchdog?.stop();
    runtime.watchdog = null;
    await settlePendingRequests(runtime);
    if (adapter && adapter.hasSession(runtime.id)) {
      try {
        await adapter.stopSession(runtime.id);
      } catch (error) {
        await appendActivity(runtime, {
          kind: "provider.session.stop.failed",
          summary: "Provider session stop failed",
          detail: describeFailure(error)
        });
      }
    }
    runtime.bound = null;
    liveness.clear(runtime.id);
    await ingestion.flushThread(runtime.id).catch(() => undefined);
  };

  // -------------------------------------------------------------------------
  // Effects (provider work), serialised per thread
  // -------------------------------------------------------------------------

  const watchdogFor = (runtime: ThreadRuntime): TurnWatchdog => {
    if (runtime.watchdog) return runtime.watchdog;
    const watchdog = createTurnWatchdog({
      threadId: runtime.id,
      clock,
      setTimer,
      clearTimer,
      onStalled: ({ threadId, turnId, elapsedMs, windowMs }) => {
        const message = stalledTurnMessage(elapsedMs, windowMs);
        void runEffect(runtime, async () => {
          const head = headOf(runtime);
          const adapter = head ? options.adapters.get(head.adapter) : undefined;
          if (adapter) {
            try {
              await adapter.interruptTurn(threadId, turnId);
            } catch (error) {
              logger.warn("agent-host: failed to cancel a stalled turn", error);
            }
          }
          await appendActivity(runtime, {
            kind: "runtime.error",
            summary: "Turn cancelled after inactivity",
            detail: message,
            turnId
          });
          // Settled as failed: the fold settles a turn from the session status.
          await persistSession(runtime, {
            ...currentSession(runtime),
            status: "error",
            activeTurnId: null,
            lastError: message
          });
        });
      }
    });
    runtime.watchdog = watchdog;
    return watchdog;
  };

  const runEffect = (runtime: ThreadRuntime, task: () => Promise<void>): Promise<void> =>
    runtime.effects
      .run(task)
      .catch((error: unknown) => {
        logger.error(`agent-host: effect failed for ${runtime.id}`, error);
      });

  const sendTurnEffect = async (runtime: ThreadRuntime, turn: QueuedTurn): Promise<void> => {
    const head = headOf(runtime);
    if (!head) return;
    try {
      await ensureSession(runtime, { pendingTurnStart: true });
    } catch (error) {
      const detail = describeFailure(error);
      await appendActivity(runtime, {
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail,
        requestId: turn.messageId
      });
      await persistSession(runtime, {
        ...currentSession(runtime),
        status: "error",
        activeTurnId: null,
        lastError: detail
      });
      return;
    }

    const adapter = adapterFor(head.adapter);
    try {
      const result = await adapter.sendTurn({
        threadId: runtime.id,
        // §4.6.9: never prefixed, indented or wrapped.
        input: providerInputFor(turn.input),
        attachments: turn.attachments,
        ...(turn.modelSelection !== undefined ? { modelSelection: turn.modelSelection } : {}),
        interactionMode: turn.interactionMode
      });
      if (runtime.bound) {
        runtime.bound = {
          ...runtime.bound,
          session: {
            ...runtime.bound.session,
            status: "running",
            activeTurnId: result.turnId,
            ...(result.resumeCursor !== undefined ? { resumeCursor: result.resumeCursor } : {})
          }
        };
      }
      // §4.1 "Cursor per turn": persisted every time, not only when it changed.
      await persistSession(runtime, {
        ...currentSession(runtime),
        status: "running",
        activeTurnId: result.turnId,
        ...(result.resumeCursor !== undefined
          ? { resumeCursor: result.resumeCursor }
          : currentSession(runtime).resumeCursor !== undefined
            ? { resumeCursor: currentSession(runtime).resumeCursor }
            : {})
      });
      watchdogFor(runtime);
    } catch (error) {
      await appendActivity(runtime, {
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: describeFailure(error),
        requestId: turn.messageId
      });
    }
  };

  const cancelQueuedTurns = async (runtime: ThreadRuntime, detail: string): Promise<void> => {
    const queued = runtime.queuedTurns;
    runtime.queuedTurns = [];
    for (const turn of queued) {
      await appendActivity(runtime, {
        kind: "provider.turn.start.failed",
        summary: "Queued message was not sent",
        detail,
        requestId: turn.messageId
      });
    }
  };

  const drainQueuedTurns = async (runtime: ThreadRuntime): Promise<void> => {
    // Ordered replay, one awaited at a time (*T3: `ProviderCommandReactor.ts:327-370`*).
    while (runtime.queuedTurns.length > 0 && !runtime.compacting) {
      const turn = runtime.queuedTurns.shift();
      if (!turn) break;
      await sendTurnEffect(runtime, turn);
    }
  };

  const compactEffect = async (runtime: ThreadRuntime, messageId: string): Promise<void> => {
    try {
      await ensureSession(runtime, { pendingTurnStart: true });
      const head = requireHead(runtime);
      await adapterFor(head.adapter).compact(runtime.id);
      runtime.compacting = false;
      await drainQueuedTurns(runtime);
    } catch (error) {
      runtime.compacting = false;
      await appendActivity(runtime, {
        kind: "provider.turn.start.failed",
        summary: "Context compaction failed",
        detail: describeFailure(error),
        requestId: messageId
      });
      // A queued message is never silently dropped and never sent into a
      // conversation that was not compacted (§3.4).
      await cancelQueuedTurns(runtime, COMPACTION_FAILED_MESSAGE);
    }
  };

  const interruptEffect = async (
    runtime: ThreadRuntime,
    turnId: string | undefined
  ): Promise<void> => {
    await cancelQueuedTurns(
      runtime,
      "Context compaction was interrupted. Send this message again to continue."
    );
    const head = headOf(runtime);
    const adapter = head ? options.adapters.get(head.adapter) : undefined;
    const session = currentSession(runtime);
    if (!adapter || !adapter.hasSession(runtime.id) || session.status === "stopped") {
      // Against a thread with no bound session, or one already stopped, the
      // host appends an activity rather than answering an HTTP error (§6.2).
      await appendActivity(runtime, {
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: turnId ?? null
      });
      return;
    }
    await settlePendingRequests(runtime);
    try {
      await adapter.interruptTurn(runtime.id, turnId);
      runtime.watchdog?.stop();
    } catch (error) {
      await appendActivity(runtime, {
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: describeFailure(error),
        turnId: turnId ?? null
      });
    }
  };

  const approvalEffect = async (
    runtime: ThreadRuntime,
    requestId: string,
    decision: Parameters<AgentAdapter["respondToApproval"]>[2]
  ): Promise<void> => {
    const head = headOf(runtime);
    const adapter = head ? options.adapters.get(head.adapter) : undefined;
    if (!adapter || !adapter.hasSession(runtime.id)) {
      await appendActivity(runtime, {
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        requestId
      });
      return;
    }
    try {
      await adapter.respondToApproval(runtime.id, requestId, decision);
    } catch (error) {
      await appendActivity(runtime, {
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: describeFailure(error),
        requestId
      });
    }
  };

  const answerEffect = async (
    runtime: ThreadRuntime,
    requestId: string,
    answers: Record<string, unknown>,
    attachmentsByQuestionId: Record<string, AttachmentRef[]> | undefined
  ): Promise<void> => {
    const head = headOf(runtime);
    const adapter = head ? options.adapters.get(head.adapter) : undefined;
    if (!adapter || !adapter.hasSession(runtime.id)) {
      await appendActivity(runtime, {
        kind: "provider.user-input.respond.failed",
        summary: "Provider question response failed",
        detail: "No active provider session is bound to this thread.",
        requestId
      });
      return;
    }
    // §6.2: attachments are folded into the answer text by the host, so the
    // adapter interface stays free of a second attachment channel.
    const folded: Record<string, unknown> = { ...answers };
    for (const [questionId, attachments] of Object.entries(attachmentsByQuestionId ?? {})) {
      if (attachments.length === 0) continue;
      const paths: string[] = [];
      for (const attachment of attachments) {
        try {
          paths.push(await store.resolveAttachment(runtime.id, attachment.id));
        } catch {
          paths.push(attachment.name);
        }
      }
      const base = typeof folded[questionId] === "string" ? (folded[questionId] as string) : "";
      folded[questionId] = base.length > 0 ? `${base}\n\n${paths.join("\n")}` : paths.join("\n");
    }
    try {
      await adapter.respondToUserInput(runtime.id, requestId, folded);
    } catch (error) {
      await appendActivity(runtime, {
        kind: "provider.user-input.respond.failed",
        summary: "Provider question response failed",
        detail: describeFailure(error),
        requestId
      });
    }
  };

  const maxCheckpointTurnCount = (runtime: ThreadRuntime): number =>
    (runtime.state.checkpoints ?? []).reduce(
      (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
      0
    );

  const revertEffect = async (runtime: ThreadRuntime, targetTurnCount: number): Promise<void> => {
    const head = headOf(runtime);
    if (!head) return;
    try {
      // §5.5 step 2, before anything on disk, in the ref store or in the
      // provider is touched.
      checkpoints.assertRollbackSupported(head.adapter);
      const current = maxCheckpointTurnCount(runtime);
      const numTurns = current - targetTurnCount;
      if (numTurns > 0) {
        await adapterFor(head.adapter).rollbackThread(runtime.id, numTurns);
      }
      await checkpoints.pruneAbove({ threadId: runtime.id, cwd: head.cwd, targetTurnCount });
      await append(runtime, [
        buildEvent(runtime.id, "thread.reverted", { turnCount: targetTurnCount })
      ]);
      await store.pruneAttachments({ threadId: runtime.id }).catch(() => undefined);
    } catch (error) {
      // Any failure is appended as an activity with tone `error`, not raised as
      // a modal (§5.5 step 6).
      await appendActivity(runtime, {
        kind: "checkpoint.revert.failed",
        summary: "Rewind failed",
        detail: describeFailure(error),
        payload: { turnCount: targetTurnCount }
      });
    }
  };

  // -------------------------------------------------------------------------
  // Commands (§6.2)
  // -------------------------------------------------------------------------

  interface Decision {
    events: AppendableDomainEvent[];
    /** Provider work, run on the thread's effect queue after the receipt lands. */
    effect?: () => Promise<void>;
    /**
     * Runs **synchronously** right after the commit, still inside the command
     * queue. The compaction queue of §3.4 needs this: whether a `/turn` is
     * queued or dispatched is decided at command time, while the compaction is
     * genuinely in flight, not later when the effect queue reaches it.
     */
    schedule?: () => void;
  }

  const turnIsActive = (runtime: ThreadRuntime): boolean => {
    const session = currentSession(runtime);
    if (session.activeTurnId !== null) return true;
    return (runtime.state.turns ?? []).some((turn: Turn) => !SETTLED_TURN_STATES.has(turn.state));
  };

  const decideCompaction = (
    runtime: ThreadRuntime,
    commandId: string,
    text: string
  ): Decision => {
    const session = currentSession(runtime);
    const userMessages = (runtime.state.items ?? []).filter(
      (item) => item.kind === "message" && item.role === "user"
    );
    if (userMessages.length === 0) {
      throw commandRejected("Context compaction requires an existing conversation.");
    }
    if (
      runtime.compacting ||
      runtime.queuedTurns.length > 0 ||
      session.status === "starting" ||
      session.status === "running" ||
      turnIsActive(runtime)
    ) {
      throw compactionUnavailable(
        "Context compaction is unavailable while a provider turn is running."
      );
    }
    const messageId = ids.messageId("user:");
    const occurredAt = clock.nowIso();
    return {
      events: [
        buildEvent(
          runtime.id,
          "thread.message-sent",
          {
            messageId,
            role: "user",
            // Persisted verbatim and rendered as a compaction marker (§4.6.5(b)).
            text,
            streaming: false,
            turnId: null
          },
          { commandId, occurredAt }
        )
      ],
      schedule: () => {
        // Claimed synchronously, so a `/turn` committed a moment later is
        // queued rather than dispatched into an uncompacted conversation.
        runtime.compacting = true;
        void runEffect(runtime, () => compactEffect(runtime, messageId));
      }
    };
  };

  const decide = (
    runtime: ThreadRuntime,
    name: AgentChatCommandName,
    raw: unknown,
    commandId: string
  ): Decision => {
    const body = requireBody(raw);
    const head = requireHead(runtime);
    const session = currentSession(runtime);

    // 409 for any command against a thread in `error` except `/session/stop`
    // and `/revert` — without that carve-out a wedged session is unrecoverable.
    if (
      (session.status === "error" || runtime.parseError !== null) &&
      !COMMANDS_ALLOWED_IN_ERROR_STATE.has(name)
    ) {
      throw commandRejected(
        "This thread's session is in an error state. Stop the session or rewind to continue."
      );
    }

    switch (name) {
      case "turn": {
        const input = parseTurnInput(body.input);
        const attachments = parseAttachments(body.attachments);
        const context = parseComposerContext(body.context);
        const interactionMode = parseInteractionMode(body.interactionMode);
        const modelSelection =
          body.modelSelection === undefined
            ? undefined
            : parseModelSelection(body.modelSelection);
        if (input.length === 0 && attachments.length === 0) {
          throw invalidCommand("A turn needs input or at least one attachment.");
        }
        // §4.6.5(b): the same host path as the `/compact` command, including
        // its refusal and queueing rules.
        if (isHostNativeCompact({ text: input, attachments })) {
          return decideCompaction(runtime, commandId, input);
        }

        const messageId = ids.messageId("user:");
        const occurredAt = clock.nowIso();
        const events: AppendableDomainEvent[] = [];
        if (
          modelSelection !== undefined &&
          !modelSelectionEquals(modelSelection, head.modelSelection)
        ) {
          events.push(
            buildEvent(runtime.id, "thread.meta-updated", { modelSelection }, { commandId, occurredAt })
          );
        }
        events.push(
          buildEvent(
            runtime.id,
            "thread.message-sent",
            {
              messageId,
              role: "user",
              text: input,
              streaming: false,
              turnId: session.activeTurnId,
              ...(attachments.length > 0 ? { attachments } : {}),
              ...(context !== undefined ? { context } : {})
            },
            { commandId, occurredAt }
          )
        );
        // Steering: `sendTurn` while a turn is active reuses the active turn id
        // and injects into the running loop. It is neither an error nor a
        // second turn (§4.1), so no pending turn row is opened for it.
        if (session.activeTurnId === null) {
          events.push(
            buildEvent(
              runtime.id,
              "thread.turn-start-requested",
              {
                turnId: null,
                messageId,
                interactionMode,
                ...(modelSelection !== undefined ? { modelSelection } : {})
              },
              { commandId, occurredAt }
            )
          );
        }

        const queuedTurn: QueuedTurn = {
          messageId,
          input,
          attachments,
          interactionMode,
          ...(modelSelection !== undefined ? { modelSelection } : {})
        };
        return {
          events,
          schedule: () => {
            // A `/turn` that arrives during a compaction is queued per thread
            // and replayed in order afterwards, each awaited before the next is
            // dispatched and the original message id reused so the user sees
            // one bubble, not two (§3.4).
            if (runtime.compacting || runtime.queuedTurns.length > 0) {
              runtime.queuedTurns.push(queuedTurn);
              return;
            }
            void runEffect(runtime, () => sendTurnEffect(runtime, queuedTurn));
          }
        };
      }

      case "interrupt": {
        const turnId = parseOptionalTurnId(body.turnId);
        return {
          events: [
            buildEvent(
              runtime.id,
              "thread.turn-interrupt-requested",
              { turnId: turnId ?? null },
              { commandId }
            )
          ],
          effect: () => interruptEffect(runtime, turnId)
        };
      }

      case "approval": {
        const requestId = parseRequestId(body);
        const decision = parseApprovalDecision(body.decision);
        return {
          events: [
            buildEvent(
              runtime.id,
              "thread.approval-response-requested",
              { requestId, decision },
              { commandId, metadata: { requestId } }
            )
          ],
          effect: () => approvalEffect(runtime, requestId, decision)
        };
      }

      case "answer": {
        const requestId = parseRequestId(body);
        const answers = parseAnswers(body.answers);
        const attachmentsByQuestionId = parseAttachmentsByQuestionId(
          body.attachmentsByQuestionId
        );
        // Persisted so an answered card renders without the original request.
        const question = (runtime.state.pending?.userInputs ?? []).find(
          (entry) => entry.requestId === requestId
        );
        const questionTextById: Record<string, string> = {};
        for (const entry of question?.questions ?? []) {
          questionTextById[entry.id] = entry.question;
        }
        return {
          events: [
            buildEvent(
              runtime.id,
              "thread.user-input-response-requested",
              {
                requestId,
                answers,
                ...(Object.keys(questionTextById).length > 0 ? { questionTextById } : {})
              },
              { commandId, metadata: { requestId } }
            )
          ],
          effect: () => answerEffect(runtime, requestId, answers, attachmentsByQuestionId)
        };
      }

      case "dismiss": {
        const requestId = parseRequestId(body);
        const question = (runtime.state.pending?.userInputs ?? []).find(
          (entry) => entry.requestId === requestId
        );
        if (!question) {
          throw commandRejected("This question has already been answered.");
        }
        if (!question.dismissible) {
          throw commandRejected("This question needs an answer. Answer it or stop the turn.");
        }
        const createdAt = clock.nowIso();
        return {
          events: [
            buildEvent(
              runtime.id,
              "thread.activity-appended",
              {
                activity: makeActivity({
                  // The deterministic id of §6.2.
                  id: `async-dismiss:${requestId}`,
                  tone: "info",
                  activityKind: "user-input.resolved",
                  summary: "User input dismissed",
                  payload: { requestId, responseMode: "message" },
                  turnId: session.activeTurnId,
                  createdAt
                })
              },
              { commandId, occurredAt: createdAt, metadata: { requestId } }
            )
          ]
          // The agent is not messaged.
        };
      }

      case "revert": {
        const targetTurnCount = parseTargetTurnCount(body.targetTurnCount);
        const current = maxCheckpointTurnCount(runtime);
        if (targetTurnCount > current) {
          throw commandRejected(
            `Checkpoint turn count ${targetTurnCount} exceeds the current turn count ${current}.`
          );
        }
        if (turnIsActive(runtime)) {
          throw commandRejected("Stop the current turn before rewinding this thread.");
        }
        return {
          events: [
            buildEvent(
              runtime.id,
              "thread.checkpoint-revert-requested",
              { targetTurnCount },
              { commandId }
            )
          ],
          effect: () => revertEffect(runtime, targetTurnCount)
        };
      }

      case "compact":
        return decideCompaction(runtime, commandId, COMPACT_COMMAND_TEXT);

      case "mode": {
        const runtimeMode: RuntimeMode | undefined =
          body.runtimeMode === undefined ? undefined : parseRuntimeMode(body.runtimeMode);
        const modelSelection =
          body.modelSelection === undefined
            ? undefined
            : parseModelSelection(body.modelSelection);
        if (runtimeMode === undefined && modelSelection === undefined) {
          throw invalidCommand("mode requires runtimeMode or modelSelection.");
        }
        const events: AppendableDomainEvent[] = [];
        const occurredAt = clock.nowIso();
        if (runtimeMode !== undefined && runtimeMode !== head.runtimeMode) {
          events.push(
            buildEvent(
              runtime.id,
              "thread.runtime-mode-set",
              { runtimeMode },
              { commandId, occurredAt }
            )
          );
        }
        if (
          modelSelection !== undefined &&
          !modelSelectionEquals(modelSelection, head.modelSelection)
        ) {
          events.push(
            buildEvent(
              runtime.id,
              "thread.meta-updated",
              { modelSelection },
              { commandId, occurredAt }
            )
          );
        }
        if (events.length === 0) {
          // Nothing changed: still a receipt, still `{seq}`, no provider work.
          events.push(
            buildEvent(
              runtime.id,
              "thread.meta-updated",
              { ...(modelSelection !== undefined ? { modelSelection } : {}) },
              { commandId, occurredAt }
            )
          );
          return { events };
        }
        return {
          events,
          effect: async () => {
            // §3.4: the ensure step is the only thing that restarts a session,
            // and it is a no-op when nothing changed. A thread with no live
            // session is left alone — the next `/turn` starts it with the new
            // mode rather than spending a provider child on a setting change.
            const adapter = options.adapters.get(head.adapter);
            if (!adapter || !adapter.hasSession(runtime.id)) {
              return;
            }
            try {
              await ensureSession(runtime);
            } catch (error) {
              const detail = describeFailure(error);
              await appendActivity(runtime, {
                kind: "provider.turn.start.failed",
                summary: "Provider session restart failed",
                detail
              });
              await persistSession(runtime, {
                ...currentSession(runtime),
                status: "error",
                activeTurnId: null,
                lastError: detail
              });
            }
          }
        };
      }

      case "session/stop": {
        return {
          events: [
            buildEvent(
              runtime.id,
              "thread.session-set",
              {
                session: {
                  ...session,
                  status: "stopped",
                  activeTurnId: null
                }
              },
              { commandId }
            )
          ],
          effect: () => stopSessionInternal(runtime)
        };
      }

      default: {
        const never: never = name;
        throw invalidCommand(`Unknown command '${String(never)}'.`);
      }
    }
  };

  const command = async (
    threadId: string,
    name: AgentChatCommandName,
    raw: unknown
  ): Promise<{ seq: number }> =>
    whenReady(async () => {
      const runtime = await loadRuntime(threadId);
      return runtime.commands.run(async () => {
        const body = requireBody(raw);
        const commandId = requireCommandId(body);

        // Receipt first: a receipt only proves that exact command was handled.
        const receipt = await store.getReceipt(commandId);
        if (receipt) {
          if (receipt.threadId !== threadId) {
            throw new AgentChatCommandError(
              "COMMAND_ID_CONFLICT",
              `commandId '${commandId}' is already recorded against another thread.`,
              { threadId: receipt.threadId }
            );
          }
          if (receipt.status === "accepted") {
            return { seq: receipt.seq };
          }
          throw replayRecordedRejection(
            receipt.error ?? { code: "COMMAND_REJECTED", message: "Previously rejected." }
          );
        }

        let decision: Decision;
        try {
          decision = decide(runtime, name, body, commandId);
        } catch (error) {
          if (isAgentChatCommandError(error) && error.recorded) {
            await store
              .putReceipt({
                commandId,
                threadId,
                seq: runtime.state.seq,
                status: "rejected",
                acceptedAt: clock.nowIso(),
                error: {
                  code: error.code,
                  message: error.message,
                  ...(error.detail !== undefined ? { detail: error.detail } : {})
                }
              })
              .catch((writeError: unknown) => {
                logger.warn("agent-host: failed to record a rejected receipt", writeError);
              });
          }
          throw error;
        }

        const result = await commit(runtime, decision.events, {
          commandId,
          status: "accepted"
        });
        // Strictly after the receipt: `/turn` answers as soon as the command is
        // recorded, and a provider refusal becomes a timeline row (§6.2).
        if (decision.schedule) {
          decision.schedule();
        } else if (decision.effect) {
          const effect = decision.effect;
          void runEffect(runtime, effect);
        }
        return { seq: result.seq };
      });
    });

  // -------------------------------------------------------------------------
  // Thread lifecycle (§6.1)
  // -------------------------------------------------------------------------

  const createThread = async (request: CreateHostThreadRequest): Promise<ThreadHead> =>
    whenReady(async () => {
      const threadId = request.threadId;
      if (typeof threadId !== "string" || threadId.length === 0) {
        throw invalidCommand("threadId is required.");
      }
      const adapterId = options.adapterForRefId(request.refId);
      if (!adapterId) {
        throw invalidCommand(`Registry entry '${request.refId}' has no chat adapter.`);
      }
      const runtime = await loadRuntime(threadId);
      if (runtime.state.head) {
        return requireHead(runtime);
      }
      const modelSelection = parseModelSelection(request.modelSelection);
      const runtimeMode =
        request.runtimeMode === undefined
          ? DEFAULT_RUNTIME_MODE
          : parseRuntimeMode(request.runtimeMode);
      const home = request.home;
      if (home !== "system" && home !== "account" && home !== "cliproxy") {
        throw invalidCommand("home must be system, account or cliproxy.");
      }

      let resumeCursor: unknown;
      if (request.resume !== undefined) {
        // §6.1: refused at creation rather than opening a fresh thread the user
        // believes is their old one. The only route that answers this code.
        if (!isUsableConversationId(request.resume.conversationId)) {
          throw new AgentChatCommandError(
            "INVALID_COMMAND",
            "This conversation cannot be resumed with the selected agent.",
            { code: "RESUME_UNAVAILABLE" }
          );
        }
        resumeCursor = resumeCursorFor(adapterId, threadId, request.resume.conversationId);
      }

      const occurredAt = clock.nowIso();
      const events: AppendableDomainEvent[] = [
        buildEvent(
          threadId,
          "thread.created",
          {
            projectPath: request.projectPath,
            cwd: request.cwd,
            title: request.title,
            adapter: adapterId,
            refId: request.refId,
            accountId: request.accountId,
            home,
            modelSelection,
            runtimeMode
          },
          { occurredAt }
        )
      ];
      if (resumeCursor !== undefined) {
        events.push(
          buildEvent(
            threadId,
            "thread.session-set",
            { session: { status: "idle", activeTurnId: null, resumeCursor } },
            { occurredAt }
          )
        );
      }
      await runtime.commands.run(() => commit(runtime, events));
      await saveHeadNow(runtime);
      return requireHead(runtime);
    });

  const updateThread = async (
    threadId: string,
    input: { title?: string }
  ): Promise<{ seq: number }> =>
    whenReady(async () => {
      const runtime = await loadRuntime(threadId);
      return runtime.commands.run(async () => {
        requireHead(runtime);
        if (typeof input.title !== "string" || input.title.trim().length === 0) {
          throw invalidCommand("title is required.");
        }
        if (input.title.length > 300) {
          throw invalidCommand("title is too long.");
        }
        const result = await commit(runtime, [
          buildEvent(threadId, "thread.meta-updated", { title: input.title.trim() })
        ]);
        await saveHeadNow(runtime);
        return { seq: result.seq };
      });
    });

  const deleteThread = async (threadId: string): Promise<void> =>
    whenReady(async () => {
      const runtime = await loadRuntime(threadId);
      const head = headOf(runtime);
      // The host settles pending requests, stops the provider child, prunes
      // every checkpoint ref under the thread's prefix and removes the
      // directory. A closed tab whose record is gone is gone (§6.1).
      await runtime.effects.run(() => stopSessionInternal(runtime));
      // The store also calls `deleteThreadRefs` through its own hook before it
      // removes the directory (a throw there aborts the delete). Doing it here
      // too keeps the cascade honest for any store that has no hook wired;
      // deleting refs under a prefix is idempotent.
      if (head) {
        await checkpoints
          .deleteThreadRefs({ threadId, cwd: head.cwd })
          .catch((error: unknown) => {
            logger.warn("agent-host: failed to prune checkpoint refs", error);
          });
      }
      await store.deleteThread(threadId);
      runtime.deleted = true;
      for (const subscriber of [...runtime.subscribers]) {
        void subscriber;
      }
      runtimes.delete(threadId);
    });

  // -------------------------------------------------------------------------
  // Reads (§6.3)
  // -------------------------------------------------------------------------

  const snapshotOf = (runtime: ThreadRuntime): ThreadSnapshotPayload => {
    const payload = fold.snapshot(runtime.state);
    return runtime.continueAfterRestart === undefined
      ? payload
      : {
          ...payload,
          head: { ...payload.head, continueAfterRestart: runtime.continueAfterRestart }
        };
  };

  const readThread = async (threadId: string, afterSeq?: number): Promise<ThreadReadResponse> =>
    whenReady(async () => {
      const runtime = await loadRuntime(threadId);
      requireHead(runtime);
      if (afterSeq === undefined) {
        return { kind: "snapshot", thread: snapshotOf(runtime) };
      }
      const replay = await measureReplay(runtime, afterSeq);
      if (replay) {
        return { kind: "events", seq: runtime.state.seq, events: replay };
      }
      return { kind: "snapshot", thread: snapshotOf(runtime) };
    });

  /**
   * Snapshot-or-replay is the SERVER's decision (§6.3). Events after `after`
   * are replayed only when the range — measured over this thread's rows alone —
   * is within BOTH budgets; past either, a snapshot. A range containing the
   * thread's own creation, a revert truncation below `after`, or an `after`
   * above the current head all force a snapshot.
   */
  const measureReplay = async (
    runtime: ThreadRuntime,
    afterSeq: number
  ): Promise<DomainEvent[] | null> => {
    if (afterSeq < 0 || afterSeq > runtime.state.seq) {
      return null;
    }
    const tail = await store.readTail(runtime.id, afterSeq);
    if (tail.truncated) {
      // The log was cut at a malformed line: answer a snapshot, not a replay.
      return null;
    }
    if (tail.events.length > AGENT_CHAT_REPLAY_MAX_EVENTS) {
      return null;
    }
    let bytes = 0;
    for (const event of tail.events) {
      if (event.type === "thread.created" || event.type === "thread.reverted") {
        // A recreated thread, or a revert truncation below `after`.
        return null;
      }
      // Row count alone is not a bound: a handful of events with large tool
      // payloads decode to far more than their number suggests, which is why
      // the byte budget is measured before the replay is used.
      bytes += serializedSize(event);
      if (bytes > AGENT_CHAT_REPLAY_PAYLOAD_BUDGET_BYTES) {
        return null;
      }
    }
    return tail.events;
  };

  const readItem = async (threadId: string, itemId: string): Promise<ThreadItem | null> =>
    whenReady(async () => {
      const runtime = await loadRuntime(threadId);
      requireHead(runtime);
      // Retention drops the oldest 500 activities from the fold, and a
      // `tool.updated` row is persisted already slimmed while its
      // `tool.completed` carries the full payload — so the LOG, read
      // backwards, is the authoritative answer, not the projection (§5.6).
      if (store.readItem) {
        return store.readItem(threadId, itemId);
      }
      const inFold = (runtime.state.items ?? []).find((item) => item.id === itemId);
      if (inFold) {
        return inFold;
      }
      const tail = await store.readAll(threadId);
      for (let index = tail.events.length - 1; index >= 0; index -= 1) {
        const event = tail.events[index]!;
        if (event.type === "thread.activity-appended" && event.payload.activity.id === itemId) {
          return event.payload.activity;
        }
      }
      return null;
    });

  const readTurnDiff = async (
    threadId: string,
    turnCount: number,
    diffOptions: { ignoreWhitespace?: boolean } = {}
  ): Promise<{ fromTurnCount: number; toTurnCount: number; diff: string } | null> =>
    whenReady(async () => {
      const runtime = await loadRuntime(threadId);
      const head = requireHead(runtime);
      const highest = maxCheckpointTurnCount(runtime);
      // A turn above the thread's highest checkpoint is a 404 rather than an
      // empty result (§5.4).
      if (turnCount > highest || turnCount < 0) {
        return null;
      }
      const fromTurnCount = Math.max(0, turnCount - 1);
      try {
        const diff = await checkpoints.readTurnDiff({
          threadId,
          cwd: head.cwd,
          fromTurnCount,
          toTurnCount: turnCount,
          ignoreWhitespace: diffOptions.ignoreWhitespace ?? true
        });
        return { fromTurnCount, toTurnCount: turnCount, diff };
      } catch (error) {
        // A range the checkpoints cannot serve is a 404, not a 500: the ref may
        // have been pruned by a revert between the read and the request (§5.4).
        if (
          error instanceof CheckpointTurnRangeError ||
          error instanceof CheckpointRefUnavailableError
        ) {
          return null;
        }
        throw error;
      }
    });

  const summary = (threadId: string): AgentChatSessionSummaryFields | null => {
    const runtime = runtimes.get(threadId);
    const head = runtime ? headOf(runtime) : null;
    if (!runtime || !head) return null;
    const pending = runtime.state.pending ?? { approvals: [], userInputs: [] };
    const turns = runtime.state.turns ?? [];
    const latest = turns.length > 0 ? turns[turns.length - 1]! : null;
    return {
      hasPendingApprovals: pending.approvals.length > 0,
      hasPendingUserInput: pending.userInputs.length > 0,
      hasActionableProposedPlan: (runtime.state.items ?? []).some(
        (item) => item.kind === "activity" && item.activityKind === "turn.proposed.completed"
      ),
      backgroundLiveness: liveness.liveness(threadId),
      latestTurn: latest
        ? {
            turnId: latest.turnId,
            state: latest.state,
            startedAt: latest.startedAt,
            completedAt: latest.completedAt
          }
        : null,
      chatSessionStatus: head.session.status
    };
  };

  const subscribe = async (
    threadId: string,
    subscription: ThreadSubscription
  ): Promise<() => void> => {
    const runtime = await loadRuntime(threadId);
    runtime.subscribers.add(subscription);
    return () => {
      runtime.subscribers.delete(subscription);
    };
  };

  // -------------------------------------------------------------------------
  // Checkpoints (§5.4) — driven off the runtime turn boundary
  // -------------------------------------------------------------------------

  /**
   * One activity per capture: `checkpoint.captured` when the ref landed clean,
   * `checkpoint.capture.failed` when the capture failed **or** only the diff
   * summary was unavailable. Never fails the turn (§5.4).
   */
  const appendCaptureOutcome = async (
    runtime: ThreadRuntime,
    result: CaptureResult,
    turnId: string | null
  ): Promise<void> => {
    const failed = result.status === "error" || result.detail !== undefined;
    await appendActivity(runtime, {
      kind: failed ? "checkpoint.capture.failed" : "checkpoint.captured",
      summary: failed ? "Checkpoint capture failed" : "Checkpoint captured",
      tone: failed ? "error" : "info",
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
      turnId,
      payload: { turnCount: result.turnCount, ref: result.ref, status: result.status }
    });
  };

  const captureBaseline = (runtime: ThreadRuntime): void => {
    const head = headOf(runtime);
    if (!head) return;
    void runtime.captures
      .run(async () => {
        const result = await checkpoints.captureBaseline({
          threadId: runtime.id,
          cwd: head.cwd,
          checkpoints: runtime.state.checkpoints ?? []
        });
        // A non-git project skips silently.
        if (!result) return;
        if (result.status === "error" || result.detail !== undefined) {
          await appendCaptureOutcome(runtime, result, currentSession(runtime).activeTurnId);
        }
      })
      .catch((error: unknown) => {
        logger.warn(`agent-host: baseline capture failed for ${runtime.id}`, error);
      });
  };

  const captureTurnEnd = (runtime: ThreadRuntime, turnId: string | null): void => {
    const head = headOf(runtime);
    if (!head) return;
    void runtime.captures
      .run(async () => {
        const turn = (runtime.state.turns ?? []).find((entry) => entry.turnId === turnId);
        const summary = await checkpoints.captureTurnEnd({
          threadId: runtime.id,
          cwd: head.cwd,
          turnId,
          assistantMessageId: turn?.assistantMessageId ?? null,
          checkpoints: runtime.state.checkpoints ?? [],
          activeTurnId: currentSession(runtime).activeTurnId
        });
        if (!summary) return;
        await append(runtime, [
          buildEvent(runtime.id, "thread.turn-diff-completed", {
            turnCount: summary.turnCount,
            turnId: summary.turnId,
            ref: summary.ref,
            status: summary.status,
            files: summary.files,
            assistantMessageId: summary.assistantMessageId,
            completedAt: summary.completedAt
          })
        ]);
        await appendCaptureOutcome(runtime, summary, turnId);
      })
      .catch((error: unknown) => {
        logger.warn(`agent-host: turn-end capture failed for ${runtime.id}`, error);
      });
  };

  // -------------------------------------------------------------------------
  // Runtime event consumption
  // -------------------------------------------------------------------------

  const consume = async (adapter: AgentAdapter): Promise<void> => {
    try {
      for await (const event of adapter.events) {
        if (stopped) break;
        try {
          liveness.observe(event);
          const runtime = runtimes.get(event.threadId);
          if (runtime) {
            runtime.watchdog?.observe(event);
            if (event.type === "session.exited") {
              runtime.watchdog?.stop();
              runtime.watchdog = null;
              runtime.bound = null;
            }
            trackSessionCursor(runtime, event);
          }
          snapshots.applyUsageLimits(adapter.id, event);
          await ingestion.ingest(event);
          if (runtime) {
            // After ingestion, so the fold already holds the turn row the
            // capture reads its `assistantMessageId` from.
            if (event.type === "turn.started") {
              captureBaseline(runtime);
            } else if (event.type === "turn.completed" || event.type === "turn.aborted") {
              captureTurnEnd(runtime, event.turnId ?? null);
            }
          }
        } catch (error) {
          logger.error("agent-host: failed to ingest a runtime event", error);
        }
      }
    } catch (error) {
      if (!stopped) {
        logger.error(`agent-host: ${adapter.id} event stream failed`, error);
      }
    }
  };

  /** Claude refreshes its cursor mid-turn; keep the bound copy current. */
  const trackSessionCursor = (runtime: ThreadRuntime, event: RuntimeEvent): void => {
    if (event.type !== "session.started") return;
    const resume = event.payload.resume;
    if (resume === undefined || !runtime.bound) return;
    runtime.bound = {
      ...runtime.bound,
      session: { ...runtime.bound.session, resumeCursor: resume }
    };
  };

  /** The sink `createIngestion` writes translated domain events into. */
  const ingestionSink = async (
    threadId: string,
    events: AppendableDomainEvent[]
  ): Promise<void> => {
    if (events.length === 0) return;
    const runtime = runtimes.get(threadId) ?? (await loadRuntime(threadId));
    await append(runtime, events);
  };

  // -------------------------------------------------------------------------
  // §3.3 continuation markers and reconcile
  // -------------------------------------------------------------------------

  const writeMarker = async (
    runtime: ThreadRuntime,
    marker: ThreadHead["continueAfterRestart"]
  ): Promise<void> => {
    runtime.continueAfterRestart = marker;
    await saveHeadNow(runtime);
  };

  const markThreadsForContinuation = async (): Promise<string[]> => {
    const marked: string[] = [];
    for (const threadId of await store.listThreads()) {
      try {
        const runtime = await loadRuntime(threadId);
        const head = headOf(runtime);
        if (!head || runtime.deleted) continue;
        const { session } = head;
        // Only threads that are running with a usable cursor (§3.3).
        if (session.status !== "running" || session.activeTurnId === null) continue;
        if (session.resumeCursor === undefined || session.resumeCursor === null) continue;
        await writeMarker(runtime, { turnId: session.activeTurnId });
        marked.push(threadId);
      } catch (error) {
        logger.warn(`agent-host: failed to mark ${threadId} for continuation`, error);
      }
    }
    return marked;
  };

  const clearContinuationMarkers = async (threadIds: readonly string[]): Promise<void> => {
    for (const threadId of threadIds) {
      const runtime = runtimes.get(threadId);
      if (!runtime) continue;
      try {
        await writeMarker(runtime, undefined);
      } catch (error) {
        logger.warn(`agent-host: failed to clear the continuation marker on ${threadId}`, error);
      }
    }
  };

  const settleAsError = async (runtime: ThreadRuntime, message: string): Promise<void> => {
    await writeMarker(runtime, undefined);
    await persistSession(runtime, {
      ...currentSession(runtime),
      status: "error",
      activeTurnId: null,
      lastError: message
    });
    await appendActivity(runtime, {
      kind: "runtime.error",
      summary: "Session did not survive a restart",
      detail: message
    });
  };

  const reconcile = async (): Promise<void> => {
    // Never blocks or fails host startup: every thread is handled and settled
    // individually, and a failure of the whole pass is logged (§3.3).
    try {
      const live = new Set<string>();
      for (const adapter of options.adapters.values()) {
        for (const session of adapter.listSessions()) {
          live.add(session.threadId);
        }
      }
      const threadIds = await store.listThreads();
      for (const threadId of threadIds) {
        try {
          await reconcileThread(threadId, live);
        } catch (error) {
          logger.warn(`agent-host: reconcile failed for ${threadId}`, error);
        }
      }
    } catch (error) {
      logger.warn("agent-host: thread reconciliation failed", error);
    }
  };

  const reconcileThread = async (threadId: string, live: Set<string>): Promise<void> => {
    // Anything the host can see running is excluded first, so an adopted host
    // is not reconciled against itself.
    if (live.has(threadId)) return;
    const runtime = await loadRuntime(threadId);
    const head = headOf(runtime);
    if (!head) {
      // A thread directory that fails to parse marks that thread `error`; it
      // never affects other threads or host startup (§5.1).
      return;
    }
    const session = head.session;
    const marker = head.continueAfterRestart;
    const prepared = marker?.prepared === true;
    const orphaned =
      session.status === "starting" ||
      session.status === "running" ||
      session.activeTurnId !== null ||
      (session.status === "ready" && prepared);
    if (!orphaned) {
      // Threads without an active turn are not resumed eagerly; the first
      // `sendTurn` re-adopts them (lazy recovery, §4.1).
      return;
    }

    const closed = runtime.deleted || (await options.isThreadClosed?.(threadId)) === true;
    const markerMatches =
      marker !== undefined &&
      (session.activeTurnId === null || marker.turnId === session.activeTurnId);
    const optIn = (await options.continuationEnabled?.(head.projectPath)) === true;
    const hasCursor = session.resumeCursor !== undefined && session.resumeCursor !== null;
    const continuable =
      !closed &&
      hasCursor &&
      (markerMatches || (optIn && session.status === "running" && session.activeTurnId !== null));

    if (!continuable) {
      // Archived and deleted threads, threads whose project opted out, and
      // threads with no cursor are settled, never continued (§3.3).
      await settleAsError(runtime, CONTINUATION_FAILED_MESSAGE);
      return;
    }

    // 1/2. The marker is written AGAIN, with `prepared`, immediately before the
    // continuation is sent: that is what makes recovery survive a host that
    // dies between resuming and sending.
    const turnId = session.activeTurnId ?? marker?.turnId;
    if (typeof turnId !== "string") {
      await settleAsError(runtime, CONTINUATION_FAILED_MESSAGE);
      return;
    }
    await persistSession(runtime, { ...session, status: "starting", activeTurnId: null });
    await writeMarker(runtime, { turnId, prepared: true });

    // 3. Forked: the loop only prepares the continuation (§3.3).
    void runEffect(runtime, async () => {
      try {
        await ensureSession(runtime, { pendingTurnStart: true });
        const adapter = adapterFor(head.adapter);
        const promptless = adapter.capabilities.promptlessTurnContinuation === true;
        const result = await adapter.sendTurn({
          threadId,
          // Promptless where the adapter declares it (Codex), otherwise the
          // literal continuation prompt.
          input: promptless ? "" : CONTINUATION_PROMPT,
          attachments: [],
          interactionMode: "default",
          ...(promptless ? { continuation: true } : {})
        });
        await persistSession(runtime, {
          ...currentSession(runtime),
          status: "running",
          activeTurnId: result.turnId,
          ...(result.resumeCursor !== undefined ? { resumeCursor: result.resumeCursor } : {})
        });
        // 4. Clear the marker on success.
        await writeMarker(runtime, undefined);
      } catch (error) {
        logger.warn(`agent-host: failed to continue ${threadId} after a restart`, error);
        await settleAsError(runtime, CONTINUATION_FAILED_MESSAGE);
      }
    });
  };

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  const drain = async (): Promise<void> => {
    for (const runtime of [...runtimes.values()]) {
      await runtime.commands.drain();
      await runtime.effects.drain();
      await runtime.captures.drain();
      await runtime.commands.drain();
    }
    await ingestion.drain();
    await store.drain();
    for (const runtime of [...runtimes.values()]) {
      await runtime.captures.drain();
      await runtime.commands.drain();
    }
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    for (const runtime of runtimes.values()) {
      runtime.watchdog?.stop();
    }
    await drain();
    for (const runtime of runtimes.values()) {
      await saveHeadNow(runtime);
    }
  };

  return {
    ready: gate.promise,
    openGate,
    failGate,
    whenReady,
    createThread,
    updateThread,
    deleteThread,
    command,
    readThread,
    readItem,
    readTurnDiff,
    summary,
    subscribe,
    providers: () => snapshots.all(),
    refreshProvider: async (adapterId, input) => {
      const before = snapshots.get(adapterId);
      const provider = await snapshots.refresh(adapterId, input);
      return { provider, changed: before !== provider };
    },
    liveThreadIds: () => {
      const live = new Set<string>();
      for (const adapter of options.adapters.values()) {
        for (const session of adapter.listSessions()) {
          live.add(session.threadId);
        }
      }
      return [...live];
    },
    activeTurnThreadIds: () =>
      [...runtimes.values()]
        .filter((runtime) => currentSession(runtime).activeTurnId !== null)
        .map((runtime) => runtime.id),
    markThreadsForContinuation,
    clearContinuationMarkers,
    reconcile,
    consume,
    drain,
    stop,
    // The sink `createIngestion({sink})` is wired to in `main.ts`.
    ingestionSink
  };
}

const sizeCache = new WeakMap<object, number>();

/**
 * An event's serialized size is measured once and cached by identity, since one
 * event object is shared by every stream watching that thread (§6.3).
 */
export function serializedSize(value: object): number {
  const cached = sizeCache.get(value);
  if (cached !== undefined) {
    return cached;
  }
  const bytes = Buffer.byteLength(JSON.stringify(value));
  sizeCache.set(value, bytes);
  return bytes;
}
