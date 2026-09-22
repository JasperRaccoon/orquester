// Ported from T3 Code (MIT): apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
/**
 * Ingestion — the runtime → domain hop (spec §5.1 ingestion rules, §5.6
 * batching).
 *
 * This is where the §5.1 rules live, so no adapter decides which runtime event
 * becomes a message, an activity, a session transition or nothing at all. It
 * is also the write-side batcher of §5.6: assistant, reasoning and plan deltas
 * buffer per message and flush every 250 ms or 8 KB, whichever first.
 *
 * Everything that makes it testable is injected: the clock, the id generator
 * and the timers. No test in this package sleeps.
 *
 * Invariants:
 * - **it never throws on a provider event.** A malformed frame produces a
 *   `runtime.warning` activity and ingestion continues (§10);
 * - **per-thread ordering is total.** Domain events reach `sink` in the order
 *   they were produced, one `sink` call at a time per thread;
 * - **a `tool.updated` row is persisted already slimmed** (§5.6), because a
 *   streaming update's `data` carries the whole output accumulated so far.
 */

import {
  DEFAULT_INTERACTION_MODE,
  HISTORICAL_RAW_SOURCE,
  isToolLifecycleItemType,
  slimActivityPayload,
  type AgentAdapterId,
  type DomainEvent,
  type RuntimeEvent,
  type ThreadActivityItem,
  type ThreadMessageRole,
  type ThreadSessionState
} from "@orquester/api/agent-chat";

import type { Clock, IdGen } from "../adapter.ts";
import type { AppendableDomainEvent, Ingestion, LivenessRegistry } from "../services.ts";
import { runtimeEventToActivities } from "./activities.ts";
import { DeltaBufferSet, type BufferFlush, type TimerHandle } from "./buffer.ts";
import { COALESCE_WINDOW_MS, MAX_PENDING_UPDATES, coalesceToolUpdates } from "./coalesce.ts";
import {
  proposedPlanActivityId,
  proposedPlanIdFromEvent,
  reasoningSegmentBaseKeyFromEvent,
  segmentBaseKeyFromEvent,
  segmentMessageId,
  historicalUserMessageId,
  messageStreamRoleOf,
  reasoningKindOfMessageId,
  toolOutputBufferKey,
  type MessageStreamRole
} from "./message-ids.ts";
import {
  initialSessionState,
  isSessionLifecycleEvent,
  nextSessionState,
  sameSessionState
} from "./session-status.ts";
import { hasRenderableText, truncateDetail } from "./text-boundary.ts";

export { runtimeEventToActivities, requestKindFromCanonicalRequestType } from "./activities.ts";
export { BATCH_INTERVAL_MS, BATCH_MAX_CHARS } from "./buffer.ts";
export {
  COALESCE_WINDOW_MS,
  MAX_PENDING_UPDATES,
  coalesceToolUpdates,
  dropStaleContextWindowActivities,
  dropSupersededToolUpdatedActivities,
  projectSnapshotActivities,
  slimActivity,
  slimActivityEvent,
  stableToolCallId,
  toolLifecycleIdentity
} from "./coalesce.ts";
export { splitBufferedText } from "./text-boundary.ts";
export { nextSessionState, threadStatusFromRuntimeState } from "./session-status.ts";

/**
 * What the host knows about a thread that ingestion cannot derive from the
 * event stream alone. Read lazily on every event, so a head rewritten by the
 * §3.3 reconcile is picked up without a restart.
 */
export interface IngestionThreadContext {
  /** The head's session state, used as the base after a host restart. */
  session?: ThreadSessionState;
  /**
   * The adapter that produced this thread's frames, stamped into
   * {@link DomainEventMetadata.adapterKey} (§5.1). Without it a forensic read
   * of `events.ndjson` can only join against the head's *current* adapter,
   * which a model change may have moved (R5 #17).
   */
  adapter?: AgentAdapterId;
  /**
   * True when the user renamed the thread. §5.1: a manual rename is **never**
   * overwritten by `thread.metadata.updated`.
   */
  titleManual?: boolean;
}

export interface IngestionLogger {
  warn(message: string, detail?: unknown): void;
}

export interface IngestionOptions {
  /** Where translated domain events go — W1 appends them through the store, in order, per thread. */
  sink: (threadId: string, events: AppendableDomainEvent[]) => Promise<void>;
  /** Fed on every task transition (§3.1 background liveness). */
  liveness: LivenessRegistry;
  clock?: Clock;
  idGen?: IdGen;
  /** Injectable timers so batching is testable without sleeping (§9). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** The head's view of a thread (§5.1 title rule, §3.3 restart, §5.1 metadata). */
  threadContext?: (threadId: string) => IngestionThreadContext | null | undefined;
  /**
   * §5.4: `turn.diff.updated` produces a **placeholder** checkpoint. The turn
   * count is the checkpoint service's to know, so it is resolved through this
   * hook; returning `null` (no git repo, a real checkpoint already exists, the
   * turn is not running) skips the placeholder entirely.
   */
  placeholderCheckpoint?: (input: {
    threadId: string;
    turnId: string;
    eventId: string;
    createdAt: string;
  }) => { turnCount: number } | null | undefined;
  /**
   * §5.1: `auth.status` and `account.rate-limits.updated` are **not thread
   * facts** — they update the provider snapshot (§6.3) and surface in §7.7.
   * Ingestion writes nothing for them and hands them here instead, so the
   * "which runtime event becomes what" decision still lives in exactly one
   * place. W1 routes them to `ProviderSnapshotRegistry.applyUsageLimits`.
   */
  onAccountEvent?: (
    event: Extract<RuntimeEvent, { type: "auth.status" | "account.rate-limits.updated" }>
  ) => void;
  /** §5.6 slimming. Defaults to W2's `slimActivityPayload`. */
  slim?: (payload: unknown) => unknown;
  logger?: IngestionLogger;
}

interface SegmentState {
  baseKey: string;
  nextSegmentIndex: number;
  activeMessageId: string | null;
}

interface ThreadState {
  session: ThreadSessionState;
  /** Stamped into every event's `metadata.adapterKey` (§5.1). */
  adapter?: AgentAdapterId;
  /**
   * Turns being REPLAYED from the provider's transcript (E6), keyed by turn
   * id: the stamp its `turn.started` carried, the first user message it
   * appended and the turn's answer. A historical turn's row is written once,
   * already settled, at its `turn.completed` — so everything the row needs is
   * accumulated here until then.
   */
  historicalTurns: Map<
    string,
    { startedAt: string; userMessageId?: string; assistantMessageId?: string }
  >;
  messages: DeltaBufferSet;
  toolOutput: DeltaBufferSet;
  /** `${turnId}:${role}` → the open segment. */
  segments: Map<string, SegmentState>;
  /** turnId → every message id the turn has opened. */
  turnMessageIds: Map<string, Set<string>>;
  /**
   * Message ids whose text already reached the log, so a completion is owed.
   * Scoped to the live turn: `finalizeMessage` drops each id as it closes it,
   * and `finalizeTurn` sweeps whatever a provider left open — without that it
   * grew by one entry per streamed message for the life of the host (Q1 #9).
   */
  projected: Set<string>;
  /** messageId → the turn it belongs to. */
  messageTurn: Map<string, string | null>;
  /** messageId → the last reasoning part index seen (Codex splits traces). */
  reasoningPartIndex: Map<string, number>;
  /**
   * §7.3 `messageKind`. Codex's `agentMessage` carries a `phase`
   * (`final_answer` vs `commentary`), which the adapter surfaces as the
   * assistant item's `detail` — but the message itself is built from
   * `content.delta`, which has no phase. So the phase is remembered per
   * provider item id and stamped onto whichever message that item opened.
   */
  assistantPhaseByItemId: Map<string, "answer" | "commentary">;
  /** messageId → the resolved {@link ThreadMessageItem.messageKind}. */
  messageKind: Map<string, "answer" | "commentary">;
  /**
   * planId → the accumulated proposal markdown, the turn it belongs to and the
   * subagent that streamed it (§5.1 attribution; the completion may arrive
   * without an `agentId`).
   */
  plans: Map<
    string,
    { text: string; createdAt: string; turnId: string | null; agentId?: string }
  >;
  /**
   * §5.6: plan deltas buffer like assistant and reasoning text. The proposal
   * row is a single stable id carrying the WHOLE markdown so far, so this
   * buffer is used only for its 250 ms / 8 KB pacing and its timer — the
   * accumulated text comes from `plans`.
   */
  planPacer: DeltaBufferSet;
  /** taskId → the remembered description, for titling `task.completed`. */
  taskTitles: Map<string, string>;
  /** toolOutput buffer key → the item/stream it belongs to. */
  outputMeta: Map<
    string,
    { toolUseId: string; streamKind: string; turnId: string | null; agentId?: string }
  >;
  outbox: AppendableDomainEvent[];
  pendingUpdates: AppendableDomainEvent[];
  coalesceTimer: TimerHandle | null;
  chain: Promise<void>;
}

const defaultClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString()
};

function defaultIdGen(): IdGen {
  let counter = 0;
  const mint = (prefix: string): string => {
    counter += 1;
    return `${prefix}${Date.now().toString(36)}-${counter.toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  };
  return {
    eventId: () => mint("evt_"),
    messageId: (prefix: string) => mint(prefix),
    uuid: () => mint("")
  };
}

function messageRoleOf(messageId: string): ThreadMessageRole {
  return messageStreamRoleOf(messageId) === "reasoning" ? "reasoning" : "assistant";
}

function segmentKey(turnId: string, role: MessageStreamRole): string {
  return `${turnId}\u0000${role}`;
}


export function createIngestion(options: IngestionOptions): Ingestion {
  const clock = options.clock ?? defaultClock;
  const ids = options.idGen ?? defaultIdGen();
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown);
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  const slim = options.slim ?? slimActivityPayload;
  const logger = options.logger;

  const threads = new Map<string, ThreadState>();

  // -------------------------------------------------------------------------
  // Thread state
  // -------------------------------------------------------------------------

  function stateFor(threadId: string): ThreadState {
    const existing = threads.get(threadId);
    if (existing !== undefined) {
      return existing;
    }
    const context = safeContext(threadId);
    const state: ThreadState = {
      session: context?.session ?? initialSessionState(),
      ...(context?.adapter !== undefined ? { adapter: context.adapter } : {}),
      messages: undefined as unknown as DeltaBufferSet,
      toolOutput: undefined as unknown as DeltaBufferSet,
      segments: new Map(),
      turnMessageIds: new Map(),
      projected: new Set(),
      messageTurn: new Map(),
      reasoningPartIndex: new Map(),
      historicalTurns: new Map(),
      assistantPhaseByItemId: new Map(),
      messageKind: new Map(),
      plans: new Map(),
      planPacer: undefined as unknown as DeltaBufferSet,
      taskTitles: new Map(),
      outputMeta: new Map(),
      outbox: [],
      pendingUpdates: [],
      coalesceTimer: null,
      chain: Promise.resolve()
    };
    const timers = { setTimer, clearTimer };
    const now = () => clock.now().getTime();
    state.messages = new DeltaBufferSet({
      timers,
      now,
      onTimerFlush: (flush) => {
        emitMessageDelta(threadId, state, flush);
        void commit(threadId, state);
      }
    });
    state.toolOutput = new DeltaBufferSet({
      timers,
      now,
      onTimerFlush: (flush) => {
        emitToolOutput(threadId, state, flush);
        void commit(threadId, state);
      }
    });
    state.planPacer = new DeltaBufferSet({
      timers,
      now,
      onTimerFlush: (flush) => {
        emitBufferedPlan(threadId, state, flush.key, null);
        void commit(threadId, state);
      }
    });
    threads.set(threadId, state);
    return state;
  }

  function safeContext(threadId: string): IngestionThreadContext | null {
    if (options.threadContext === undefined) {
      return null;
    }
    try {
      return options.threadContext(threadId) ?? null;
    } catch (error) {
      logger?.warn("agent-chat/ingestion: threadContext failed", error);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Emission
  // -------------------------------------------------------------------------

  function envelope(
    threadId: string,
    cause: RuntimeEvent | null,
    occurredAt: string
  ): Omit<AppendableDomainEvent, "type" | "payload"> {
    const refs = cause?.providerRefs;
    const adapterKey = threads.get(threadId)?.adapter;
    return {
      eventId: ids.eventId(),
      threadId,
      occurredAt,
      commandId: null,
      causationEventId: cause?.eventId ?? null,
      metadata: {
        ...(refs?.providerTurnId !== undefined ? { providerTurnId: refs.providerTurnId } : {}),
        ...(refs?.providerItemId !== undefined ? { providerItemId: refs.providerItemId } : {}),
        ...(adapterKey !== undefined ? { adapterKey } : {}),
        ...(cause?.requestId !== undefined ? { requestId: cause.requestId } : {}),
        ingestedAt: clock.nowIso()
      }
    };
  }

  function emit<TType extends DomainEvent["type"]>(
    state: ThreadState,
    threadId: string,
    cause: RuntimeEvent | null,
    occurredAt: string,
    type: TType,
    payload: Extract<DomainEvent, { type: TType }>["payload"]
  ): void {
    state.outbox.push({
      ...envelope(threadId, cause, occurredAt),
      type,
      payload
    } as AppendableDomainEvent);
  }

  function emitActivity(
    state: ThreadState,
    threadId: string,
    cause: RuntimeEvent | null,
    activity: ThreadActivityItem
  ): void {
    emit(state, threadId, cause, activity.createdAt, "thread.activity-appended", { activity });
  }

  /**
   * True for an event projected from the provider's OWN transcript
   * (`AgentAdapter.projectHistory`, §4.2) rather than decoded from a live
   * frame. It describes something that already happened, so it must not move
   * the session, feed the liveness registry, mint a checkpoint or raise
   * attention — only rebuild the timeline (E6).
   */
  function isHistorical(event: RuntimeEvent): boolean {
    return event.raw?.source === HISTORICAL_RAW_SOURCE;
  }

  /**
   * The text of a replayed message item. `data.text` wins over `detail`
   * because an adapter may elide `detail` for the row label while keeping the
   * whole message in `data` — Claude does exactly that
   * (`adapters/claude/project-history.ts`), so reading `detail` would replay a
   * truncated conversation.
   */
  function historicalItemText(payload: {
    detail?: string;
    data?: unknown;
  }): string | undefined {
    const data = payload.data;
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      const text = (data as { text?: unknown }).text;
      if (typeof text === "string" && text.trim().length > 0) {
        return text;
      }
    }
    return hasRenderableText(payload.detail) ? payload.detail : undefined;
  }

  /**
   * Codex's `agentMessage` phase, as the adapter surfaces it on the
   * `assistant_message` item's `detail` (`apps/daemon/test/fixtures/codex/README.md`
   * observation 18: `"final_answer"` vs `"commentary"` — the running "I'll do X
   * next" narration). Any other detail is that item's real text, and a
   * provider with no such notion never sends either marker.
   */
  function assistantPhaseFromDetail(
    detail: string | undefined
  ): "answer" | "commentary" | null {
    switch (detail?.trim().toLowerCase()) {
      case "commentary":
        return "commentary";
      case "final_answer":
        return "answer";
      default:
        return null;
    }
  }

  /** True when `detail` is the phase marker and therefore NOT message text. */
  function detailIsPhaseMarker(detail: string | undefined): boolean {
    return assistantPhaseFromDetail(detail) !== null;
  }

  /**
   * Record the phase for a provider item and stamp it onto the message that
   * item opened. The phase can arrive before the first delta (`item.started`)
   * or after the last one (`item.completed`), so both the remembered-by-item
   * map and the already-open message are updated.
   */
  function noteAssistantPhase(
    state: ThreadState,
    itemId: string,
    phase: "answer" | "commentary",
    turnId: string | null
  ): void {
    state.assistantPhaseByItemId.set(itemId, phase);
    state.messageKind.set(segmentMessageId(itemId, 0, "assistant"), phase);
    if (turnId === null) {
      return;
    }
    const segment = state.segments.get(segmentKey(turnId, "assistant"));
    if (segment?.activeMessageId != null && segment.baseKey === itemId) {
      state.messageKind.set(segment.activeMessageId, phase);
    }
  }

  /**
   * The §7.3 badge fields, resolved once so every `thread.message-sent` — the
   * first delta, a later spill and the completion alike — carries them.
   * `reasoningKind` is read straight off the message id (the stream key is
   * baked into the base key); `messageKind` comes from the provider's message
   * phase, remembered per item id.
   */
  function messageKindFields(
    state: ThreadState,
    messageId: string,
    role: ThreadMessageRole
  ): { reasoningKind?: "text" | "summary"; messageKind?: "answer" | "commentary" } {
    if (role === "reasoning") {
      const reasoningKind = reasoningKindOfMessageId(messageId);
      return reasoningKind !== undefined ? { reasoningKind } : {};
    }
    if (role !== "assistant") {
      return {};
    }
    return { messageKind: state.messageKind.get(messageId) ?? "answer" };
  }

  function emitMessageDelta(threadId: string, state: ThreadState, flush: BufferFlush): void {
    if (!hasRenderableText(flush.text)) {
      return;
    }
    const role = messageRoleOf(flush.key);
    const turnId = state.messageTurn.get(flush.key) ?? null;
    state.projected.add(flush.key);
    emit(
      state,
      threadId,
      null,
      role === "reasoning" ? flush.openedAt : clock.nowIso(),
      "thread.message-sent",
      {
        messageId: flush.key,
        role,
        text: flush.text,
        streaming: true,
        turnId,
        ...messageKindFields(state, flush.key, role)
      }
    );
  }

  function emitToolOutput(threadId: string, state: ThreadState, flush: BufferFlush): void {
    const meta = state.outputMeta.get(flush.key);
    if (meta === undefined || flush.text.length === 0) {
      return;
    }
    emitActivity(state, threadId, null, {
      kind: "activity",
      id: ids.eventId(),
      tone: "tool",
      activityKind: "tool.output",
      summary: "Tool output",
      payload: {
        toolUseId: meta.toolUseId,
        streamKind: meta.streamKind,
        delta: flush.text
      },
      turnId: meta.turnId,
      ...(meta.agentId !== undefined ? { agentId: meta.agentId } : {}),
      createdAt: flush.openedAt,
      updatedAt: clock.nowIso()
    });
  }

  /**
   * Ship the outbox, running the §5.6 coalescer over it: `tool.updated` rows
   * queue for 50 ms (512 max) so a burst of `item.updated` frames for one call
   * becomes one row; any other event closes the window immediately, which is
   * what preserves ordering.
   */
  function commit(threadId: string, state: ThreadState): Promise<void> {
    const outbox = state.outbox;
    if (outbox.length === 0) {
      return state.chain;
    }
    state.outbox = [];
    const ship: AppendableDomainEvent[] = [];
    for (const event of outbox) {
      if (isToolUpdatedEvent(event)) {
        state.pendingUpdates.push(event);
        if (state.pendingUpdates.length >= MAX_PENDING_UPDATES) {
          cancelCoalesceWindow(state);
          ship.push(...takePendingUpdates(state));
        } else if (state.coalesceTimer === null) {
          state.coalesceTimer = setTimer(() => {
            state.coalesceTimer = null;
            const flushed = takePendingUpdates(state);
            if (flushed.length > 0) {
              enqueue(threadId, state, flushed);
            }
          }, COALESCE_WINDOW_MS);
        }
        continue;
      }
      cancelCoalesceWindow(state);
      ship.push(...takePendingUpdates(state), event);
    }
    if (ship.length === 0) {
      return state.chain;
    }
    return enqueue(threadId, state, ship);
  }

  function enqueue(
    threadId: string,
    state: ThreadState,
    events: AppendableDomainEvent[]
  ): Promise<void> {
    state.chain = state.chain.then(async () => {
      try {
        await options.sink(threadId, events);
      } catch (error) {
        // The sink is the store. A failed append must not take the host down;
        // the thread's own error surfacing is W1's (§5.1 "a thread directory
        // that fails to parse marks that thread error").
        logger?.warn("agent-chat/ingestion: sink failed", error);
      }
    });
    return state.chain;
  }

  function isToolUpdatedEvent(event: AppendableDomainEvent): boolean {
    return (
      event.type === "thread.activity-appended" &&
      event.payload.activity.activityKind === "tool.updated"
    );
  }

  function takePendingUpdates(state: ThreadState): AppendableDomainEvent[] {
    if (state.pendingUpdates.length === 0) {
      return [];
    }
    const pending = state.pendingUpdates;
    state.pendingUpdates = [];
    const activities = pending.map(
      (event) =>
        (event as Extract<AppendableDomainEvent, { type: "thread.activity-appended" }>).payload
          .activity
    );
    const kept = new Set(coalesceToolUpdates(activities).map((activity) => activity.id));
    return pending.filter((event, index) => kept.has(activities[index]!.id));
  }

  function cancelCoalesceWindow(state: ThreadState): void {
    if (state.coalesceTimer !== null) {
      clearTimer(state.coalesceTimer);
      state.coalesceTimer = null;
    }
  }

  /**
   * Close an open coalescing window and ship its survivors immediately, ahead
   * of anything the flush itself is about to emit. Every explicit flush seam
   * (`flushTurn`, `finalizeReasoning`, `flushThread`, `drain`) goes through
   * this — otherwise a `tool.updated` that arrived less than 50 ms before a
   * drain would sit in memory forever. It cannot go back through `commit`,
   * which would simply re-open the window on the same rows.
   */
  function closeCoalesceWindow(threadId: string, state: ThreadState): void {
    cancelCoalesceWindow(state);
    const pending = takePendingUpdates(state);
    if (pending.length > 0) {
      void enqueue(threadId, state, pending);
    }
  }

  // -------------------------------------------------------------------------
  // Segments and buffered text
  // -------------------------------------------------------------------------

  function rememberMessage(state: ThreadState, turnId: string | null, messageId: string): void {
    state.messageTurn.set(messageId, turnId);
    if (turnId === null) {
      return;
    }
    const turnMessages = state.turnMessageIds.get(turnId) ?? new Set<string>();
    turnMessages.add(messageId);
    state.turnMessageIds.set(turnId, turnMessages);
  }

  function forgetMessage(state: ThreadState, turnId: string | null, messageId: string): void {
    state.messageTurn.delete(messageId);
    state.projected.delete(messageId);
    state.reasoningPartIndex.delete(messageId);
    state.messageKind.delete(messageId);
    if (turnId === null) {
      return;
    }
    const ids = state.turnMessageIds.get(turnId);
    if (ids !== undefined) {
      ids.delete(messageId);
      if (ids.size === 0) {
        state.turnMessageIds.delete(turnId);
      }
    }
  }

  function startSegment(
    state: ThreadState,
    turnId: string,
    baseKey: string,
    role: MessageStreamRole
  ): string {
    const key = segmentKey(turnId, role);
    const existing = state.segments.get(key);
    let next: SegmentState;
    if (existing === undefined) {
      next = {
        baseKey,
        nextSegmentIndex: 1,
        activeMessageId: segmentMessageId(baseKey, 0, role)
      };
    } else {
      // Reasoning never resets the index on a new base key: one item can
      // stream a summary and a raw trace, and summary → raw → summary would
      // otherwise reuse the id of the first, finished block.
      const reuseIndex = existing.baseKey === baseKey || role === "reasoning";
      const segmentIndex = reuseIndex ? existing.nextSegmentIndex : 0;
      next = {
        baseKey,
        nextSegmentIndex: reuseIndex ? existing.nextSegmentIndex + 1 : 1,
        activeMessageId: segmentMessageId(baseKey, segmentIndex, role)
      };
    }
    state.segments.set(key, next);
    return next.activeMessageId!;
  }

  function activeSegmentId(
    state: ThreadState,
    turnId: string,
    role: MessageStreamRole
  ): string | null {
    return state.segments.get(segmentKey(turnId, role))?.activeMessageId ?? null;
  }

  /**
   * Close the open segment: deliver whatever is buffered, then write the
   * completion. A completion with empty text keeps the accumulated body
   * (§5.1), which is exactly what a finalise after a flush needs.
   */
  function finalizeSegment(
    threadId: string,
    state: ThreadState,
    turnId: string,
    role: MessageStreamRole,
    input: { cause: RuntimeEvent | null; occurredAt: string; fallbackText?: string }
  ): void {
    const key = segmentKey(turnId, role);
    const segment = state.segments.get(key);
    const messageId = segment?.activeMessageId ?? null;
    if (segment === undefined || messageId === null) {
      return;
    }
    finalizeMessage(threadId, state, messageId, turnId, input);
    state.segments.set(key, { ...segment, activeMessageId: null });
  }

  function finalizeMessage(
    threadId: string,
    state: ThreadState,
    messageId: string,
    turnId: string | null,
    input: { cause: RuntimeEvent | null; occurredAt: string; fallbackText?: string }
  ): void {
    const buffered = state.messages.take(messageId);
    const openedAt = state.messages.openedAt(messageId, input.occurredAt);
    const role = messageRoleOf(messageId);
    const text =
      buffered.length > 0
        ? buffered
        : hasRenderableText(input.fallbackText)
          ? input.fallbackText!
          : "";
    const kindFields = messageKindFields(state, messageId, role);
    if (hasRenderableText(text)) {
      state.projected.add(messageId);
      emit(
        state,
        threadId,
        input.cause,
        role === "reasoning" ? openedAt : input.occurredAt,
        "thread.message-sent",
        { messageId, role, text, streaming: true, turnId, ...kindFields }
      );
    }
    if (state.projected.has(messageId)) {
      emit(state, threadId, input.cause, input.occurredAt, "thread.message-sent", {
        messageId,
        role,
        text: "",
        streaming: false,
        turnId,
        ...kindFields
      });
    }
    forgetMessage(state, turnId, messageId);
  }

  /** Deliver every buffered message of a turn WITHOUT closing its segments. */
  function flushTurnBuffers(threadId: string, state: ThreadState, turnId: string): void {
    const messageIds = state.turnMessageIds.get(turnId);
    if (messageIds === undefined) {
      return;
    }
    for (const messageId of [...messageIds]) {
      const text = state.messages.take(messageId);
      if (!hasRenderableText(text)) {
        continue;
      }
      emitMessageDelta(threadId, state, {
        key: messageId,
        text,
        openedAt: state.messages.openedAt(messageId, clock.nowIso())
      });
    }
  }

  /** Close every open message of a turn, then forget the turn's state. */
  function finalizeTurn(
    threadId: string,
    state: ThreadState,
    turnId: string,
    input: { cause: RuntimeEvent | null; occurredAt: string }
  ): void {
    finalizeSegment(threadId, state, turnId, "reasoning", input);
    finalizeSegment(threadId, state, turnId, "assistant", input);
    const messageIds = state.turnMessageIds.get(turnId);
    if (messageIds !== undefined) {
      for (const messageId of [...messageIds]) {
        finalizeMessage(threadId, state, messageId, turnId, input);
      }
    }
    state.turnMessageIds.delete(turnId);
    state.segments.delete(segmentKey(turnId, "assistant"));
    state.segments.delete(segmentKey(turnId, "reasoning"));
    finalizePlansForTurn(threadId, state, turnId, input);
    // Nothing keyed on this turn can still be written to, so the dedupe and
    // phase bookkeeping for it goes with it (Q1 #9).
    for (const [messageId, messageTurnId] of [...state.messageTurn]) {
      if (messageTurnId === turnId) {
        forgetMessage(state, turnId, messageId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // The proposal buffer (§5.1 `plan_text` / `turn.proposed.*`)
  // -------------------------------------------------------------------------

  /**
   * Accumulate a proposal delta and report whether §5.6's pacing says it is
   * time to publish. The row is replace-by-id, so what gets published is the
   * whole accumulation — the pacer only decides *when*.
   */
  function appendPlan(
    state: ThreadState,
    planId: string,
    delta: string,
    createdAt: string,
    turnId: string | null,
    agentId: string | undefined
  ): boolean {
    const existing = state.plans.get(planId);
    state.plans.set(planId, {
      text: `${existing?.text ?? ""}${delta}`,
      createdAt: existing?.createdAt ?? createdAt,
      turnId: existing?.turnId ?? turnId,
      ...(existing?.agentId ?? agentId) !== undefined
        ? { agentId: existing?.agentId ?? agentId }
        : {}
    });
    return state.planPacer.append(planId, delta, createdAt).length > 0;
  }

  /** Publish the accumulated proposal for `planId`, if there is any. */
  function emitBufferedPlan(
    threadId: string,
    state: ThreadState,
    planId: string,
    cause: RuntimeEvent | null
  ): void {
    const entry = state.plans.get(planId);
    if (entry === undefined || entry.text.trim().length === 0) {
      return;
    }
    emitPlanRow(threadId, state, planId, entry, entry.turnId, "turn.proposed.delta", cause);
  }

  function emitPlanRow(
    threadId: string,
    state: ThreadState,
    planId: string,
    entry: { text: string; createdAt: string; agentId?: string },
    turnId: string | null,
    activityKind: "turn.proposed.delta" | "turn.proposed.completed",
    cause: RuntimeEvent | null
  ): void {
    // §5.1: a catch-all row carries that event's payload and its
    // `turnId`/`agentId`. A proposal streamed inside a subagent keeps its
    // attribution, so it can be tied to a §7.6 roster row (R5 #8). The buffer
    // remembers the agent, because the completion may arrive without one.
    const agentId = cause?.agentId ?? entry.agentId;
    // One stable id per proposal, so a streaming card is replaced rather than
    // appended to — the same "latest state" treatment task.progress gets.
    emitActivity(state, threadId, cause, {
      kind: "activity",
      id: proposedPlanActivityId(planId),
      tone: "info",
      activityKind,
      summary: "Plan proposed",
      payload: { planId, planMarkdown: entry.text },
      turnId,
      ...(agentId !== undefined ? { agentId } : {}),
      createdAt: entry.createdAt,
      updatedAt: clock.nowIso()
    });
  }

  function finalizePlan(
    threadId: string,
    state: ThreadState,
    planId: string,
    turnId: string | null,
    cause: RuntimeEvent | null,
    fallbackMarkdown?: string
  ): void {
    const entry = state.plans.get(planId);
    state.plans.delete(planId);
    state.planPacer.discard(planId);
    const text = entry?.text.trim().length ? entry.text : (fallbackMarkdown ?? "");
    if (text.trim().length === 0) {
      return;
    }
    emitPlanRow(
      threadId,
      state,
      planId,
      {
        text,
        createdAt: entry?.createdAt ?? clock.nowIso(),
        // The completion often arrives without an agentId; the buffer is what
        // remembers which subagent streamed the proposal (R5 #8).
        ...(entry?.agentId !== undefined ? { agentId: entry.agentId } : {})
      },
      turnId ?? entry?.turnId ?? null,
      "turn.proposed.completed",
      cause
    );
  }

  function finalizePlansForTurn(
    threadId: string,
    state: ThreadState,
    turnId: string,
    input: { cause: RuntimeEvent | null }
  ): void {
    const prefix = `plan:${threadId}:turn:${turnId}`;
    for (const planId of [...state.plans.keys()]) {
      if (planId === prefix) {
        finalizePlan(threadId, state, planId, turnId, input.cause);
      }
    }
  }

  // -------------------------------------------------------------------------
  // The public surface
  // -------------------------------------------------------------------------

  async function ingest(event: RuntimeEvent): Promise<void> {
    let state: ThreadState | null = null;
    try {
      if (
        event === null ||
        typeof event !== "object" ||
        typeof event.type !== "string" ||
        typeof event.threadId !== "string" ||
        event.threadId.length === 0
      ) {
        logger?.warn("agent-chat/ingestion: unusable runtime event", event);
        return;
      }
      state = stateFor(event.threadId);
      translate(event.threadId, state, event);
    } catch (error) {
      // §10: a malformed provider event is surfaced, never dropped by a
      // catch-all, and it never ends the turn.
      const message =
        error instanceof Error ? error.message : `ingestion failed: ${String(error)}`;
      logger?.warn("agent-chat/ingestion: translate failed", error);
      const threadId =
        typeof (event as RuntimeEvent | undefined)?.threadId === "string"
          ? (event as RuntimeEvent).threadId
          : null;
      if (threadId !== null) {
        const warned = state ?? stateFor(threadId);
        const occurredAt =
          typeof (event as RuntimeEvent).createdAt === "string"
            ? (event as RuntimeEvent).createdAt
            : clock.nowIso();
        emitActivity(warned, threadId, null, {
          kind: "activity",
          id: ids.eventId(),
          tone: "info",
          activityKind: "runtime.warning",
          summary: truncateDetail(`Ingestion could not decode a provider event: ${message}`, 120),
          payload: {
            message: truncateDetail(message),
            detail: { eventType: (event as RuntimeEvent).type ?? null }
          },
          turnId: null,
          createdAt: occurredAt,
          updatedAt: occurredAt
        });
        state = warned;
      }
    }
    if (state !== null) {
      await commit(event.threadId, state);
    }
  }

  function translate(threadId: string, state: ThreadState, event: RuntimeEvent): void {
    const now = event.createdAt;
    const eventTurnId = event.turnId !== undefined ? String(event.turnId) : null;
    const isTerminalTurn = event.type === "turn.completed" || event.type === "turn.aborted";

    // History is replayed through the same translator, but it is NOT live: it
    // rebuilds the timeline and touches nothing else (E6).
    if (isHistorical(event)) {
      translateHistorical(threadId, state, event, now, eventTurnId);
      return;
    }

    // --- buffered content -------------------------------------------------
    if (event.type === "content.delta") {
      handleContentDelta(threadId, state, event, now, eventTurnId);
    }

    // --- mandatory flush points (§5.6) ------------------------------------
    // A `request.opened` and a BLOCKING `user-input.requested` flush and
    // finalise the buffered assistant and reasoning text for that turn BEFORE
    // the request activity is appended, or the approval banner appears above
    // text the agent had already produced.
    const pauseTurnId =
      event.type === "request.opened" ||
      (event.type === "user-input.requested" && event.payload.responseMode !== "message")
        ? eventTurnId
        : null;
    if (pauseTurnId !== null) {
      flushTurnBuffers(threadId, state, pauseTurnId);
      finalizeSegment(threadId, state, pauseTurnId, "reasoning", { cause: event, occurredAt: now });
      finalizeSegment(threadId, state, pauseTurnId, "assistant", { cause: event, occurredAt: now });
    }

    // A TOOL `item.started` closes the active reasoning segment, or post-tool
    // thinking is appended to a block that already sits above the tool row.
    // Gated on the same predicate the activity row is: a non-tool item never
    // produces a row, so it must not break a thinking block either.
    if (
      event.type === "item.started" &&
      eventTurnId !== null &&
      isToolLifecycleItemType(event.payload.itemType)
    ) {
      finalizeSegment(threadId, state, eventTurnId, "reasoning", {
        cause: event,
        occurredAt: now
      });
    }

    // --- the provider's assistant-message phase (§7.3 `messageKind`) -------
    if (
      (event.type === "item.started" ||
        event.type === "item.updated" ||
        event.type === "item.completed") &&
      event.payload.itemType === "assistant_message" &&
      event.itemId !== undefined
    ) {
      const phase = assistantPhaseFromDetail(event.payload.detail);
      if (phase !== null) {
        noteAssistantPhase(state, event.itemId, phase, eventTurnId);
      }
    }

    // A LIVE `user_message` item is the provider echoing back the prompt the
    // `/turn` command already appended (Codex does this, `items.ts` marks it
    // `timelineBypass`), so it is never a row — only the replayed one is (E6).

    // --- item completions that close a message ----------------------------
    if (event.type === "item.completed" && eventTurnId !== null) {
      if (event.payload.itemType === "reasoning") {
        handleReasoningCompletion(threadId, state, event, now, eventTurnId);
      } else if (event.payload.itemType === "assistant_message") {
        handleAssistantCompletion(threadId, state, event, now, eventTurnId);
      }
    }

    // --- proposals --------------------------------------------------------
    if (event.type === "turn.proposed.delta") {
      const planId = proposedPlanIdFromEvent(event, threadId);
      if (appendPlan(state, planId, event.payload.delta, now, eventTurnId, event.agentId)) {
        emitBufferedPlan(threadId, state, planId, event);
      }
    }
    if (event.type === "turn.proposed.completed") {
      finalizePlan(
        threadId,
        state,
        proposedPlanIdFromEvent(event, threadId),
        eventTurnId,
        event,
        event.payload.planMarkdown
      );
    }

    // --- turn end / session exit flush ------------------------------------
    // Text lands BEFORE the status change that settles the turn, so a
    // completion never arrives after the turn has been folded shut.
    if (isTerminalTurn && eventTurnId !== null) {
      finalizeTurn(threadId, state, eventTurnId, { cause: event, occurredAt: now });
    }
    if (event.type === "session.exited") {
      flushThreadState(threadId, state, { cause: event, occurredAt: now });
    }

    // --- session lifecycle ------------------------------------------------
    if (isSessionLifecycleEvent(event)) {
      // Ingestion's own memory is authoritative once it has seen the thread:
      // the head is written by W1 *from* these events, so re-reading it per
      // event would race a not-yet-applied `turn.started` and map the next
      // `session.started` to `ready` instead of `running`. The head is the
      // SEED only — `stateFor` takes it when the thread is first touched,
      // which is exactly the §3.3 post-restart case.
      const previous = state.session;
      const next = nextSessionState({ event, previous });
      // The provider's per-turn numbers ride the event that settles the turn
      // (E10): `turn.completed` is the only frame that carries them, and the
      // fold settles from session status, so anywhere else they would arrive
      // after the turn had already closed.
      const turnResult =
        (event.type === "turn.completed" || event.type === "turn.aborted") &&
        eventTurnId !== null &&
        (event.payload.tokenUsage !== undefined ||
          (event.type === "turn.completed" && event.payload.totalCostUsd !== undefined))
          ? {
              turnId: eventTurnId,
              ...(event.payload.tokenUsage !== undefined
                ? { tokenUsage: event.payload.tokenUsage }
                : {}),
              ...(event.type === "turn.completed" && event.payload.totalCostUsd !== undefined
                ? { totalCostUsd: event.payload.totalCostUsd }
                : {})
            }
          : undefined;
      if (!sameSessionState(previous, next) || turnResult !== undefined) {
        state.session = next;
        emit(state, threadId, event, now, "thread.session-set", {
          session: next,
          ...(turnResult !== undefined ? { turn: turnResult } : {})
        });
      } else {
        state.session = next;
      }
    }

    // --- title ------------------------------------------------------------
    if (event.type === "thread.metadata.updated") {
      const name = event.payload.name?.trim();
      if (name !== undefined && name.length > 0 && safeContext(threadId)?.titleManual !== true) {
        emit(state, threadId, event, now, "thread.meta-updated", { title: name });
      }
    }

    // --- placeholder checkpoint (§5.4) ------------------------------------
    if (event.type === "turn.diff.updated" && eventTurnId !== null) {
      handleProviderDiff(threadId, state, event, now, eventTurnId);
    }

    // --- background liveness (§3.1) ---------------------------------------
    if (
      event.type === "task.started" ||
      event.type === "task.progress" ||
      event.type === "task.updated" ||
      event.type === "task.completed"
    ) {
      try {
        options.liveness.observe(event);
      } catch (error) {
        logger?.warn("agent-chat/ingestion: liveness.observe failed", error);
      }
      const description =
        event.type === "task.started" || event.type === "task.progress"
          ? event.payload.description?.trim()
          : undefined;
      if (description !== undefined && description.length > 0) {
        state.taskTitles.set(event.payload.taskId, description);
      }
    }
    if (event.type === "session.exited") {
      try {
        options.liveness.clear(threadId);
      } catch (error) {
        logger?.warn("agent-chat/ingestion: liveness.clear failed", error);
      }
    }

    // --- account events are provider-snapshot facts, not thread facts ------
    if (event.type === "auth.status" || event.type === "account.rate-limits.updated") {
      try {
        options.onAccountEvent?.(event);
      } catch (error) {
        logger?.warn("agent-chat/ingestion: onAccountEvent failed", error);
      }
    }

    // --- activities -------------------------------------------------------
    const taskTitle =
      event.type === "task.completed" ? state.taskTitles.get(event.payload.taskId) : undefined;
    const activities = runtimeEventToActivities(
      event,
      taskTitle !== undefined ? { taskTitle } : {}
    );
    for (const activity of activities) {
      emitActivity(state, threadId, event, maybeSlim(activity));
    }

    // Segment state and buffered text die with the session (§5.1).
    if (event.type === "session.exited") {
      clearThreadState(state);
    }
  }

  /**
   * Rebuild the timeline of a thread whose provider replays nothing onto its
   * message stream (§4.5): every event here describes something that already
   * happened.
   *
   * What it deliberately does NOT do, because a replayed row must never look
   * live: no `thread.session-set` (the live session is untouched), no
   * liveness, no placeholder checkpoint, no retitle, no buffering — history is
   * complete text and arrives as finished `item.completed` rows.
   */
  function translateHistorical(
    threadId: string,
    state: ThreadState,
    event: RuntimeEvent,
    now: string,
    eventTurnId: string | null
  ): void {
    if (event.type === "turn.started" && eventTurnId !== null) {
      // Remembered, not written: the row is minted once, already settled, at
      // `turn.completed`, so a half-replayed transcript leaves no running turn.
      if (!state.historicalTurns.has(eventTurnId)) {
        state.historicalTurns.set(eventTurnId, { startedAt: now });
      }
      return;
    }

    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      if (eventTurnId === null) {
        return;
      }
      const turn = state.historicalTurns.get(eventTurnId);
      state.historicalTurns.delete(eventTurnId);
      const turnState =
        event.type === "turn.aborted" ? "interrupted" : (event.payload.state ?? "completed");
      emit(
        state,
        threadId,
        event,
        // The row's `requestedAt`/`startedAt` come from the envelope, so a
        // replayed turn keeps the duration the provider recorded.
        turn?.startedAt ?? now,
        "thread.turn-start-requested",
        {
          turnId: eventTurnId,
          messageId: turn?.userMessageId ?? "",
          interactionMode: DEFAULT_INTERACTION_MODE,
          settled: {
            state: turnState === "cancelled" ? "interrupted" : turnState,
            completedAt: now,
            ...(event.payload.tokenUsage !== undefined
              ? { tokenUsage: event.payload.tokenUsage }
              : {}),
            ...(turn?.assistantMessageId !== undefined
              ? { assistantMessageId: turn.assistantMessageId }
              : {})
          }
        }
      );
      return;
    }

    if (event.type !== "item.completed") {
      // Everything else a projection emits — tool rows, plans, warnings —
      // goes down the ordinary activity path below.
      emitHistoricalActivities(threadId, state, event);
      return;
    }

    const itemType = event.payload.itemType;
    const text = historicalItemText(event.payload);

    if (itemType === "user_message") {
      if (text === undefined) {
        return;
      }
      const turn = eventTurnId === null ? undefined : state.historicalTurns.get(eventTurnId);
      // One user message per turn: a provider that echoes the prompt as more
      // than one item must not produce a stack of identical bubbles.
      if (turn?.userMessageId !== undefined) {
        return;
      }
      const messageId = historicalUserMessageId(event);
      if (turn !== undefined) {
        turn.userMessageId = messageId;
      }
      emit(state, threadId, event, now, "thread.message-sent", {
        messageId,
        role: "user",
        text,
        // Complete by construction; history never streams.
        streaming: false,
        turnId: eventTurnId
        // No attachments and no context: the bytes are long gone and the
        // composer chips were never part of the provider's transcript.
      });
      return;
    }

    if (itemType === "assistant_message" || itemType === "reasoning") {
      if (text === undefined) {
        return;
      }
      const role = itemType === "reasoning" ? "reasoning" : "assistant";
      const baseKey = String(event.itemId ?? event.eventId);
      const messageId =
        role === "reasoning"
          ? segmentMessageId(`snapshot:${baseKey}`, 0, "reasoning")
          : segmentMessageId(baseKey, 0, "assistant");
      if (role === "assistant" && eventTurnId !== null) {
        const turn = state.historicalTurns.get(eventTurnId);
        if (turn !== undefined && turn.assistantMessageId === undefined) {
          turn.assistantMessageId = messageId;
        }
      }
      const kindFields =
        role === "assistant"
          ? { messageKind: assistantPhaseFromDetail(event.payload.detail) ?? "answer" }
          : {};
      emit(state, threadId, event, now, "thread.message-sent", {
        messageId,
        role,
        text,
        streaming: false,
        turnId: eventTurnId,
        ...kindFields
      });
      return;
    }

    // A tool-shaped item replays as the activity row it always was.
    emitHistoricalActivities(threadId, state, event);
  }

  function emitHistoricalActivities(
    threadId: string,
    state: ThreadState,
    event: RuntimeEvent
  ): void {
    for (const activity of runtimeEventToActivities(event)) {
      emitActivity(state, threadId, event, maybeSlim(activity));
    }
  }

  /**
   * §5.6: a `tool.updated` row is persisted **already slimmed**. Every other
   * row keeps its full payload on disk and is slimmed on the way to the wire.
   */
  function maybeSlim(activity: ThreadActivityItem): ThreadActivityItem {
    if (activity.activityKind !== "tool.updated") {
      return activity;
    }
    try {
      const slimmed = slim(activity.payload);
      return slimmed === activity.payload ? activity : { ...activity, payload: slimmed };
    } catch (error) {
      // W2 owns `slimActivityPayload`. A failure there must not cost the row.
      logger?.warn("agent-chat/ingestion: slimActivityPayload failed", error);
      return activity;
    }
  }

  function handleContentDelta(
    threadId: string,
    state: ThreadState,
    event: Extract<RuntimeEvent, { type: "content.delta" }>,
    now: string,
    eventTurnId: string | null
  ): void {
    const { streamKind, delta } = event.payload;
    if (typeof delta !== "string" || delta.length === 0) {
      return;
    }
    if (streamKind === "reasoning_text" || streamKind === "reasoning_summary_text") {
      const baseKey = reasoningSegmentBaseKeyFromEvent(event, streamKind);
      // Every SEGMENTED close path for a thinking block is keyed by turn. T3
      // drops a turnless reasoning delta for that reason, but §5.1 states the
      // rule unconditionally and grok really does emit one before
      // `turn.started` — so it is buffered under its own event-derived id
      // instead, exactly as turnless assistant text already was. It closes
      // from `flushThreadState`, which walks `messageTurn` rather than the
      // segment map (R5 #7).
      let messageId: string;
      if (eventTurnId === null) {
        messageId = segmentMessageId(baseKey, 0, "reasoning");
      } else {
        const open = state.segments.get(segmentKey(eventTurnId, "reasoning"));
        if (open?.activeMessageId != null && open.baseKey === baseKey) {
          messageId = open.activeMessageId;
        } else {
          if (open?.activeMessageId != null) {
            finalizeSegment(threadId, state, eventTurnId, "reasoning", {
              cause: event,
              occurredAt: now
            });
          }
          messageId = startSegment(state, eventTurnId, baseKey, "reasoning");
        }
      }
      rememberMessage(state, eventTurnId, messageId);

      // Codex splits a reasoning trace into indexed parts, summary and raw
      // alike. The index is the only signal that one part ended and the next
      // began, so the blank line that keeps them readable is inserted here.
      let text = delta;
      const partIndex = event.payload.summaryIndex ?? event.payload.contentIndex;
      if (partIndex !== undefined) {
        const last = state.reasoningPartIndex.get(messageId);
        if (last !== undefined && last >= 0 && last !== partIndex) {
          text = `\n\n${text}`;
        }
        state.reasoningPartIndex.set(messageId, partIndex);
      }
      const spill = state.messages.append(messageId, text, now);
      if (spill.length > 0) {
        emitMessageDelta(threadId, state, {
          key: messageId,
          text: spill,
          openedAt: state.messages.openedAt(messageId, now)
        });
      }
      return;
    }

    if (streamKind === "assistant_text") {
      // Visible text ends the thinking block that preceded it, so the next
      // block does not swallow this answer.
      if (eventTurnId !== null) {
        finalizeSegment(threadId, state, eventTurnId, "reasoning", {
          cause: event,
          occurredAt: now
        });
      }
      const messageId =
        eventTurnId === null
          ? segmentMessageId(segmentBaseKeyFromEvent(event), 0)
          : (activeSegmentId(state, eventTurnId, "assistant") ??
            startSegment(state, eventTurnId, segmentBaseKeyFromEvent(event), "assistant"));
      rememberMessage(state, eventTurnId, messageId);
      // The phase may have arrived on the item BEFORE the first delta.
      if (event.itemId !== undefined && !state.messageKind.has(messageId)) {
        const phase = state.assistantPhaseByItemId.get(event.itemId);
        if (phase !== undefined) {
          state.messageKind.set(messageId, phase);
        }
      }
      const spill = state.messages.append(messageId, delta, now);
      if (spill.length > 0) {
        emitMessageDelta(threadId, state, {
          key: messageId,
          text: spill,
          openedAt: state.messages.openedAt(messageId, now)
        });
      }
      return;
    }

    if (streamKind === "plan_text") {
      const planId = proposedPlanIdFromEvent(event, threadId);
      if (appendPlan(state, planId, delta, now, eventTurnId, event.agentId)) {
        emitBufferedPlan(threadId, state, planId, event);
      }
      return;
    }

    if (streamKind === "command_output" || streamKind === "file_change_output") {
      // §5.6: command and file-change output deltas use the same buffer,
      // keyed by item id.
      if (event.itemId === undefined) {
        return;
      }
      // §5.6: keyed by ITEM ID, so one item that emits both a command-output
      // and a file-change-output stream shares one 250 ms / 8 KB buffer and
      // one row rather than two interleaved ones (R5 #9).
      const key = toolOutputBufferKey(threadId, event.itemId);
      state.outputMeta.set(key, {
        toolUseId: event.itemId,
        streamKind,
        turnId: eventTurnId,
        ...(event.agentId !== undefined ? { agentId: event.agentId } : {})
      });
      const spill = state.toolOutput.append(key, delta, now);
      if (spill.length > 0) {
        emitToolOutput(threadId, state, {
          key,
          text: spill,
          openedAt: state.toolOutput.openedAt(key, now)
        });
      }
      return;
    }

    // `unknown` carries no renderable stream. Dropped, as in T3.
  }

  function handleReasoningCompletion(
    threadId: string,
    state: ThreadState,
    event: Extract<RuntimeEvent, { type: "item.completed" }>,
    now: string,
    turnId: string
  ): void {
    const active = activeSegmentId(state, turnId, "reasoning");
    const detail = event.payload.detail;
    if (active !== null) {
      // The item detail is a whole-block snapshot, so it may only stand in for
      // deltas that never arrived. Appending it to a streamed block would
      // print the reasoning twice.
      const streamed = state.projected.has(active) || state.messages.has(active);
      finalizeSegment(threadId, state, turnId, "reasoning", {
        cause: event,
        occurredAt: now,
        ...(!streamed && hasRenderableText(detail) ? { fallbackText: detail } : {})
      });
      return;
    }
    // Segment state outlives a closed block, so its presence means this turn
    // already streamed a trace and the snapshot would duplicate it.
    const alreadyStreamed = state.segments.has(segmentKey(turnId, "reasoning"));
    if (alreadyStreamed || !hasRenderableText(detail)) {
      return;
    }
    // A provider can report a whole block at once without streaming it. The id
    // is derived from the item so a repeated completion rewrites that row
    // instead of adding a copy.
    const snapshotId = segmentMessageId(
      `snapshot:${event.itemId ?? event.eventId}`,
      0,
      "reasoning"
    );
    // A whole-block snapshot arrived with no stream kind, so `reasoningKind`
    // stays absent and the row renders without a badge rather than guessing.
    emit(state, threadId, event, now, "thread.message-sent", {
      messageId: snapshotId,
      role: "reasoning",
      text: detail!,
      streaming: true,
      turnId
    });
    emit(state, threadId, event, now, "thread.message-sent", {
      messageId: snapshotId,
      role: "reasoning",
      text: "",
      streaming: false,
      turnId
    });
  }

  function handleAssistantCompletion(
    threadId: string,
    state: ThreadState,
    event: Extract<RuntimeEvent, { type: "item.completed" }>,
    now: string,
    turnId: string
  ): void {
    finalizeSegment(threadId, state, turnId, "reasoning", { cause: event, occurredAt: now });
    const active = activeSegmentId(state, turnId, "assistant");
    const messageId =
      active ??
      segmentMessageId(String(event.itemId ?? event.turnId ?? event.eventId), 0, "assistant");
    // A `detail` that IS the phase marker is metadata, not the message body,
    // and `data.text` wins where an adapter elides `detail` for the label.
    const detail = detailIsPhaseMarker(event.payload.detail)
      ? undefined
      : historicalItemText(event.payload);
    const streamed = state.projected.has(messageId) || state.messages.has(messageId);
    if (active === null && !streamed && !hasRenderableText(detail)) {
      // Nothing to complete: no stream ever opened and the completion is empty.
      return;
    }
    rememberMessage(state, turnId, messageId);
    const close = {
      cause: event,
      occurredAt: now,
      // The completion's detail is a whole-message snapshot: it may only stand
      // in for deltas that never arrived, or the text prints twice.
      ...(!streamed && hasRenderableText(detail) ? { fallbackText: detail } : {})
    };
    if (active !== null) {
      finalizeSegment(threadId, state, turnId, "assistant", close);
    } else {
      finalizeMessage(threadId, state, messageId, turnId, close);
    }
    state.segments.delete(segmentKey(turnId, "assistant"));
  }

  function handleProviderDiff(
    threadId: string,
    state: ThreadState,
    event: Extract<RuntimeEvent, { type: "turn.diff.updated" }>,
    now: string,
    turnId: string
  ): void {
    if (options.placeholderCheckpoint === undefined) {
      return;
    }
    let resolved: { turnCount: number } | null | undefined;
    try {
      resolved = options.placeholderCheckpoint({
        threadId,
        turnId,
        eventId: event.eventId,
        createdAt: now
      });
    } catch (error) {
      logger?.warn("agent-chat/ingestion: placeholderCheckpoint failed", error);
      return;
    }
    if (resolved === null || resolved === undefined) {
      return;
    }
    emit(state, threadId, event, now, "thread.turn-diff-completed", {
      turnCount: resolved.turnCount,
      turnId,
      ref: `provider-diff:${event.eventId}`,
      status: "missing",
      files: [],
      // The turn's REAL anchor, or null — never a synthesised one. The
      // `itemId` on a `turn.diff.updated` frame names the diff item, not an
      // assistant message, so `assistant:<diffItemId>` used to name a message
      // that never exists; the fold's `payload.assistantMessageId ??
      // turn.assistantMessageId` then made that phantom permanent, because
      // `stampAssistantMessage` only ever fills a null. Emitting null lets the
      // fold keep what it stamped from the real assistant message (R5 #3).
      assistantMessageId: activeSegmentId(state, turnId, "assistant"),
      completedAt: now
    });
  }

  function flushThreadState(
    threadId: string,
    state: ThreadState,
    input: { cause: RuntimeEvent | null; occurredAt: string }
  ): void {
    for (const turnId of [...state.turnMessageIds.keys()]) {
      finalizeTurn(threadId, state, turnId, input);
    }
    for (const messageId of [...state.messageTurn.keys()]) {
      finalizeMessage(threadId, state, messageId, state.messageTurn.get(messageId) ?? null, input);
    }
    for (const key of state.toolOutput.keys()) {
      const text = state.toolOutput.take(key);
      if (text.length > 0) {
        emitToolOutput(threadId, state, {
          key,
          text,
          openedAt: state.toolOutput.openedAt(key, input.occurredAt)
        });
      }
    }
    for (const planId of [...state.plans.keys()]) {
      finalizePlan(threadId, state, planId, null, input.cause);
    }
  }

  function clearThreadState(state: ThreadState): void {
    state.messages.clear();
    state.toolOutput.clear();
    state.segments.clear();
    state.turnMessageIds.clear();
    state.projected.clear();
    state.messageTurn.clear();
    state.reasoningPartIndex.clear();
    state.historicalTurns.clear();
    state.assistantPhaseByItemId.clear();
    state.messageKind.clear();
    state.plans.clear();
    state.planPacer.clear();
    state.taskTitles.clear();
    state.outputMeta.clear();
  }

  async function flushTurn(threadId: string, turnId: string | undefined): Promise<void> {
    const state = threads.get(threadId);
    if (state === undefined) {
      return;
    }
    const occurredAt = clock.nowIso();
    if (turnId === undefined) {
      flushThreadState(threadId, state, { cause: null, occurredAt });
    } else {
      finalizeTurn(threadId, state, turnId, { cause: null, occurredAt });
    }
    closeCoalesceWindow(threadId, state);
    await commit(threadId, state);
  }

  async function finalizeReasoning(threadId: string, turnId: string | undefined): Promise<void> {
    const state = threads.get(threadId);
    if (state === undefined) {
      return;
    }
    const occurredAt = clock.nowIso();
    const turnIds = turnId === undefined ? [...state.turnMessageIds.keys()] : [turnId];
    for (const id of turnIds) {
      finalizeSegment(threadId, state, id, "reasoning", { cause: null, occurredAt });
    }
    closeCoalesceWindow(threadId, state);
    await commit(threadId, state);
  }

  async function flushThread(threadId: string): Promise<void> {
    const state = threads.get(threadId);
    if (state === undefined) {
      return;
    }
    flushThreadState(threadId, state, { cause: null, occurredAt: clock.nowIso() });
    closeCoalesceWindow(threadId, state);
    await commit(threadId, state);
  }

  async function forget(threadId: string): Promise<void> {
    const state = threads.get(threadId);
    if (state === undefined) {
      return;
    }
    // Drop the entry first, so a buffer timer that fires during the awaited
    // chain cannot resurrect it through `stateFor`.
    threads.delete(threadId);
    cancelCoalesceWindow(state);
    state.pendingUpdates = [];
    state.outbox = [];
    clearThreadState(state);
    try {
      options.liveness.clear(threadId);
    } catch (error) {
      logger?.warn("agent-chat/ingestion: liveness.clear failed", error);
    }
    // Let an append already in flight settle, so the caller can delete the
    // thread directory knowing nothing else will write to it.
    await state.chain;
  }

  async function drain(): Promise<void> {
    // Deliver everything buffered without closing any message: a drain is a
    // synchronisation point, not a turn end.
    for (const [threadId, state] of [...threads]) {
      for (const messageId of [...state.messageTurn.keys()]) {
        const text = state.messages.take(messageId);
        if (hasRenderableText(text)) {
          emitMessageDelta(threadId, state, {
            key: messageId,
            text,
            openedAt: state.messages.openedAt(messageId, clock.nowIso())
          });
        }
      }
      for (const key of state.toolOutput.keys()) {
        const text = state.toolOutput.take(key);
        if (text.length > 0) {
          emitToolOutput(threadId, state, {
            key,
            text,
            openedAt: state.toolOutput.openedAt(key, clock.nowIso())
          });
        }
      }
      for (const planId of state.planPacer.keys()) {
        state.planPacer.take(planId);
        emitBufferedPlan(threadId, state, planId, null);
      }
      closeCoalesceWindow(threadId, state);
      await commit(threadId, state);
    }
    // A sink may itself have enqueued nothing; awaiting each chain twice is
    // cheap and covers a commit that landed while an earlier chain was awaited.
    await Promise.all([...threads.values()].map((state) => state.chain));
  }

  return { ingest, flushTurn, finalizeReasoning, flushThread, forget, drain };
}
