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
  MAX_TURN_FILE_BYTES,
  MAX_TURN_IMAGE_BYTES,
  isHistoricalRuntimeEvent,
  SETTLED_TURN_STATES,
  slimActivityPayload,
  type AgentAdapterId,
  type AgentChatCommandName,
  type AgentChatSessionSummaryFields,
  type AttachmentRef,
  type DomainEvent,
  type InteractionMode,
  type ModelSelection,
  type PendingApproval,
  type PendingUserInput,
  type ProviderSession,
  type ProviderSessionBinding,
  type ProviderSessionBindingPatch,
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

import { stat } from "node:fs/promises";

import type { AdapterLogger, AgentAdapter } from "../adapter.ts";
import {
  CONTINUATION_FAILED_MESSAGE,
  CONTINUATION_PROMPT,
  CONTINUATION_SEND_FAILED_MESSAGE,
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
import { slimActivityEvent } from "../ingestion/coalesce.ts";
import { bindingResumeCursor } from "../store/binding.ts";
import { projectSnapshotActivities } from "../ingestion/index.ts";
import { AGENT_HOST_DEADLINES, withDeadline } from "../support/deadline.ts";
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
  createMemoryLaunchConfigStore,
  launchConfigFromRequest,
  type LaunchConfigStore,
  type ThreadLaunchConfig
} from "./launch-config.ts";
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
import {
  blockedProviderCommandMessage,
  COMPACT_COMMAND_TEXT,
  isHostNativeCompact,
  providerInputFor
} from "./slash.ts";
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
/** The snapshot registry, plus the change flag `agent.providers.changed` needs. */
export type HostProviderSnapshotRegistry = ProviderSnapshotRegistry & {
  /** §7.7: an `auth.status {error}` from a turn must reach the snapshot. */
  applyAuthStatus?(adapterId: AgentAdapterId, event: RuntimeEvent): void;
  /** Monotonic; lets the daemon notice a host-triggered change (§6.4). */
  changeCount?(): number;
  refreshDetailed?(
    adapterId: AgentAdapterId,
    input?: { cwd?: string }
  ): Promise<{ snapshot: ProviderSnapshot; changed: boolean }>;
};

export type HostThreadStore = ThreadStore & {
  threadError?(threadId: string): string | null;
  readItem?(threadId: string, itemId: string): Promise<ThreadItem | null>;
};

export interface OrchestratorOptions {
  store: HostThreadStore;
  ingestion: Ingestion;
  checkpoints: CheckpointService;
  liveness: LivenessRegistry;
  snapshots: HostProviderSnapshotRegistry;
  /** Acquired before the command gate opens (§3.1) — never lazily imported (§8). */
  adapters: ReadonlyMap<AgentAdapterId, AgentAdapter>;
  logger: AdapterLogger;
  hostInstanceId: string;
  /** Registry id (`claude`, `claudex`, `codex`, …) → adapter id, from the catalog. */
  adapterForRefId(refId: string): AgentAdapterId | null;
  /** Absolute home dir for a thread's account (§3.1). Host-side only. */
  resolveHome(input: {
    /** So the resolver can consult that thread's §6.1 `homePath`. */
    threadId: string;
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
  /**
   * The registry entry's own launch args, handed to `startSession` so an
   * adapter that folds a flag into its protocol (Claude's `--permission-mode`)
   * sees what the entry declares.
   */
  launchArgsForRefId?(refId: string): readonly string[];
  /**
   * Where the §6.1 `launchEnv`/`unsetEnv`/`homePath`/`proxyRefId` are kept. The
   * daemon sends them once, at create; a session may be started much later by
   * lazy recovery or by the reconcile, so they must survive a host restart.
   */
  launchConfigs?: LaunchConfigStore;
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
  /**
   * `binding.json` — the durable provider-session binding (§3.3, §4.1) and the
   * AUTHORITY for the resume cursor. `null` until the thread has one; the head's
   * cursor is the fallback for a thread written before bindings existed (§8).
   */
  binding: ProviderSessionBinding | null;
  eventsSinceHeadSave: number;
  compacting: boolean;
  queuedTurns: QueuedTurn[];
  /**
   * The interaction mode of the last `/turn` (§6.2: client-local, re-sent
   * with every turn). A message-mode answer starts or steers a turn without a
   * body of its own, so it inherits this rather than inventing a mode.
   */
  lastInteractionMode: InteractionMode;
  bound: BoundSessionShape | null;
  watchdog: TurnWatchdog | null;
  subscribers: Set<ThreadSubscription>;
  /**
   * §5.1: a thread directory that fails to parse marks **that thread** `error`
   * with the parse message; it never affects another thread or host startup.
   */
  parseError: string | null;
  /**
   * §5.1: a manual rename is NEVER overwritten by a provider retitle. A client
   * `PUT` carries a `commandId`; a provider retitle is appended by ingestion
   * with `commandId: null`, which is the discriminator.
   */
  titleManual: boolean;
  /** The §6.1 launcher env, loaded once with the thread. */
  launch: ThreadLaunchConfig | null;
  /**
   * E6: this thread resumes a conversation and has nothing of its own yet, so
   * the provider's history is still owed.
   *
   * Decided when the thread is loaded or created — NOT at session start: by
   * then the `/turn` that triggered the start has already appended its user
   * message, and an items-based test would never fire.
   */
  historyPending: boolean;
  /**
   * Target of the most recent `thread.reverted`, or null.
   *
   * A capture that lands after a revert belongs to a turn the revert
   * truncated, and appending it raises `head.turnCount` past the target —
   * visibly undoing the rewind and leaving a checkpoint row with no turn. It
   * cannot be derived from the fold: after the revert the head's count and the
   * highest surviving checkpoint are equal again.
   */
  revertedTo: number | null;
  /**
   * Set once `captureBaseline` answers `null` — a non-git project skips
   * checkpoints silently (§5.4), and no placeholder may be written for it.
   */
  checkpointsUnavailable: boolean;
  deleted: boolean;
}

const HEAD_SAVE_EVENT_INTERVAL = 50;

/**
 * §3.4's "bounded grace window" on a queued turn start. A `pending` turn older
 * than this on a host that is only now starting belongs to a send that never
 * happened; anything shorter would settle a turn that is merely slow to reach
 * the provider.
 */
const PENDING_TURN_GRACE_MS = 5 * 60_000;


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
  /**
   * `input.seed` marks a client auto-seeded title (§7.7): it is written like
   * any other, but leaves `titleManual` false so a provider retitle may still
   * replace it (§5.1). Only a title the USER typed is manual.
   */
  updateThread(threadId: string, input: { title?: string; seed?: boolean }): Promise<{ seq: number }>;
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
  summary(threadId: string): HostThreadSummary | null;

  subscribe(threadId: string, subscription: ThreadSubscription): Promise<() => void>;

  providers(): ProviderSnapshot[];
  /**
   * Monotonic counter of snapshot changes. The daemon polls it to publish
   * `agent.providers.changed` for a change the HOST noticed on its own — a CLI
   * upgraded underneath it, a login gone stale — which no client request would
   * otherwise reveal.
   */
  providersChangeCount(): number;
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
   * `IngestionOptions.threadContext` (§5.1 title rule, §3.3 restart): the
   * head's session state, plus whether the user renamed the thread.
   */
  threadContext(threadId: string): { session?: ThreadSessionState; titleManual?: boolean } | null;
  /**
   * `IngestionOptions.placeholderCheckpoint` (§5.4): the turn count a
   * `turn.diff.updated` placeholder would take, or `null` when there is no git
   * repo, a real checkpoint already covers the turn, or the turn is not the
   * running one.
   */
  placeholderCheckpoint(input: {
    threadId: string;
    turnId: string;
  }): { turnCount: number } | null;
  /**
   * `IngestionOptions.onAccountEvent` (§5.1): `auth.status` and
   * `account.rate-limits.updated` are not thread facts — they update the
   * provider snapshot. The adapter is resolved from the thread's head.
   */
  onAccountEvent(event: RuntimeEvent): void;
  /** The adapter serving a thread, or null when it is not loaded. */
  adapterForThread(threadId: string): AgentAdapterId | null;
  /**
   * The §6.1 launcher env for a loaded thread. `main.ts` reads it when it
   * builds a provider child's environment (§3.1).
   */
  launchConfig(threadId: string): ThreadLaunchConfig | null;
  /**
   * The launcher env of a loaded thread in this project or working directory.
   *
   * OpenCode runs **one server per project**, shared by its threads (§3.2), so
   * the child that needs the env belongs to no single thread. Every thread of
   * one project launches from the same registry entry, so any of their configs
   * is the right one; the newest is used so a re-created tab wins.
   */
  launchConfigForCwd(cwd: string): ThreadLaunchConfig | null;
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
  const launchConfigs = options.launchConfigs ?? createMemoryLaunchConfigStore();
  const { store, ingestion, checkpoints, liveness, snapshots, logger } = options;

  const runtimes = new Map<string, ThreadRuntime>();
  /**
   * §6.1 / E5: which thread owns a provider conversation.
   *
   * Two tabs resuming one provider thread would advance one cursor from two
   * processes — the invariant §3.1 spends a whole paragraph on. The provider's
   * own id is only knowable once a session announces it (`thread.started`), so
   * the map is fed from there and cleared when the thread stops or is deleted.
   * In memory only: after a host restart nothing is live, which is correct.
   */
  const providerThreadOwners = new Map<string, string>();
  /** In-flight `loadRuntime` calls, memoised so two never build two runtimes. */
  const loadingRuntimes = new Map<string, Promise<ThreadRuntime>>();
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

  /**
   * One runtime per thread, even under concurrent first-touches.
   *
   * The normal tab-open flow issues `GET …/thread` and `GET …/events`
   * together, and the stream's `subscribe` runs concurrently with the read. If
   * both miss the cache and both build a runtime, the second `runtimes.set`
   * discards the first — and with it the `subscribers` set the stream just
   * registered on, so that tab renders its snapshot and never updates again.
   * The loser's command queue is also no longer the serialising one, which
   * lets two `commit()`s interleave on one thread.
   *
   * So the in-flight promise is memoised **synchronously**, before the first
   * await — the same shape `ProviderSnapshotRegistry.ensureWorkspaceSnapshot`
   * uses. The entry is dropped in a `finally`, on success and failure alike:
   * the resolved runtime is in `runtimes` by then, and a transient read error
   * must not poison the thread for the life of the host.
   */
  const loadRuntime = (threadId: string): Promise<ThreadRuntime> => {
    const existing = runtimes.get(threadId);
    if (existing) {
      return Promise.resolve(existing);
    }
    const inFlight = loadingRuntimes.get(threadId);
    if (inFlight) {
      return inFlight;
    }
    const load = buildRuntime(threadId)
      .then((runtime) => {
        // `deleteThread` evicts the in-flight entry as its last act, so an
        // entry that is no longer ours means the thread was deleted while this
        // read was in flight. Caching it now would resurrect a runtime whose
        // store directory is gone — the class V1 §10 #5 names. The caller still
        // gets its object; it is simply not published.
        //
        // Defensive, deliberately: `deleteThread` holds the runtime in
        // `runtimes` across all of its awaits, so today every concurrent
        // `loadRuntime` hits the cache and no load is actually in flight at the
        // eviction — which is also why this has no test that could fail without
        // it. It costs one comparison and closes the class if that ordering
        // ever changes.
        if (loadingRuntimes.get(threadId) !== load) {
          return runtime;
        }
        runtimes.set(threadId, runtime);
        return runtime;
      })
      .finally(() => {
        loadingRuntimes.delete(threadId);
      });
    loadingRuntimes.set(threadId, load);
    return load;
  };

  const buildRuntime = async (threadId: string): Promise<ThreadRuntime> => {
    const tail = await store.readAll(threadId);
    const state = fold.foldAll(tail.events);
    const persistedHead = await store.loadHead(threadId).catch(() => null);
    const binding = await store.loadBinding(threadId).catch(() => null);
    const launch = await launchConfigs.load(threadId).catch(() => null);
    const runtime: ThreadRuntime = {
      id: threadId,
      commands: createSerialQueue(),
      effects: createSerialQueue(),
      captures: createSerialQueue(),
      state,
      continueAfterRestart: persistedHead?.continueAfterRestart,
      binding,
      eventsSinceHeadSave: 0,
      compacting: false,
      queuedTurns: [],
    lastInteractionMode: "default",
      bound: null,
      watchdog: null,
      subscribers: new Set(),
      parseError: store.threadError?.(threadId) ?? null,
      launch,
      // A resumed thread with no timeline of its own still owes its history —
      // including after a host restart, when nothing replayed it the first time.
      historyPending:
        (state.items ?? []).length === 0 &&
        (bindingResumeCursor(binding) ?? state.head?.session.resumeCursor) !== undefined,
      revertedTo: tail.events.reduce<number | null>(
        (target, event) =>
          event.type === "thread.reverted" ? event.payload.turnCount : target,
        null
      ),
      titleManual: tail.events.some(
        (event) =>
          event.type === "thread.meta-updated" &&
          event.payload.title !== undefined &&
          event.commandId !== null
      ),
      checkpointsUnavailable: false,
      deleted: state.deleted
    };
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

  /**
   * §5.1: between a `/turn` command and the provider's first `turn.started` the
   * turn exists as a **pending row**, and that row is *adopted* when the id
   * arrives — never settled. A `ready` session state published in that window
   * settles it (`settledTurnStateForSessionStatus("ready") === "completed"`),
   * so one user message grows two turn rows and every ambient surface reads
   * `completed` milliseconds after the user pressed send.
   *
   * `startSession` already maps its own `ready` to `starting` for exactly this
   * reason; this applies the same rule to every writer, including the events
   * ingestion translates from the adapter's own `session.state.changed`.
   */
  const coerceSessionForPendingTurn = (
    runtime: ThreadRuntime,
    session: ThreadSessionState
  ): ThreadSessionState => {
    if (session.status !== "ready" || session.activeTurnId !== null) {
      return session;
    }
    const hasUnstartedTurn = (runtime.state.turns ?? []).some(
      (turn) => turn.state === "pending" && turn.startedAt === null
    );
    return hasUnstartedTurn ? { ...session, status: "starting" } : session;
  };

  const sessionStateEquals = (left: ThreadSessionState, right: ThreadSessionState): boolean =>
    left.status === right.status &&
    left.activeTurnId === right.activeTurnId &&
    (left.lastError ?? null) === (right.lastError ?? null) &&
    (left.providerThreadId ?? null) === (right.providerThreadId ?? null) &&
    left.resumeCursor === right.resumeCursor;

  const persistSession = async (
    runtime: ThreadRuntime,
    session: ThreadSessionState
  ): Promise<void> => {
    const next = coerceSessionForPendingTurn(runtime, session);
    // An unchanged republish is pure noise on every open stream, and it is the
    // republish — not a real transition — that produced the phantom row above.
    if (sessionStateEquals(currentSession(runtime), next)) {
      return;
    }
    await append(runtime, [buildEvent(runtime.id, "thread.session-set", { session: next })]);
  };

  const currentSession = (runtime: ThreadRuntime): ThreadSessionState =>
    runtime.state.head?.session ?? { status: "idle", activeTurnId: null };

  // -------------------------------------------------------------------------
  // The provider session binding (§3.3, §4.1) — the cursor's real home
  // -------------------------------------------------------------------------

  /**
   * The ONE way this process writes the binding. Field-wise by construction:
   * whatever the patch omits is left exactly as it was persisted, so a caller
   * that knows nothing about the cursor cannot erase it — which is precisely
   * what `thread.session-set` did to the head.
   *
   * Never throws: a binding that cannot be written costs at worst one resume
   * (the head's carried-forward cursor is still there), and failing a turn over
   * it would be strictly worse.
   *
   * *T3: `ProviderService.ts:1053-1076` (`upsertSessionBinding`).*
   */
  const upsertBinding = async (
    runtime: ThreadRuntime,
    patch: ProviderSessionBindingPatch
  ): Promise<void> => {
    const adapter = runtime.state.head?.adapter ?? runtime.binding?.adapter;
    if (adapter === undefined) return;
    try {
      runtime.binding = await store.upsertSessionBinding({
        threadId: runtime.id,
        adapter,
        patch
      });
    } catch (error) {
      logger.warn(`agent-host: failed to persist the session binding for ${runtime.id}`, error);
    }
  };

  /**
   * The cursor to resume from: the binding's, else the head's.
   *
   * The fallback is the §8 rollback boundary in one expression — a thread
   * written before `binding.json` existed, or one whose binding could not be
   * read, still resumes from what `meta.json` recorded. It is also why nothing
   * here ever writes `resumeCursor: null`: a binding that says "no cursor" and
   * a binding that has not learned one yet must not be told apart by the read
   * path, or a status-only write would strand a thread that has a head cursor.
   *
   * *T3: `ProviderService.ts:1462-1466` — `input.resumeCursor ?? persistedBinding.resumeCursor`.*
   */
  const persistedResumeCursor = (runtime: ThreadRuntime, head: ThreadHead): unknown =>
    bindingResumeCursor(runtime.binding) ?? head.session.resumeCursor;

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
        ? (bound.session.resumeCursor ?? persistedResumeCursor(runtime, head))
        : undefined;
      return startSession(runtime, head, desired, cursor, pendingTurnStart);
    }

    await stopStaleSessions(runtime, head.adapter);
    // Lazy recovery (§4.1): a crashed, OOM-killed or restarted session is
    // indistinguishable from a fresh one — start from the persisted cursor,
    // which comes off the BINDING (§3.3): the head's copy is a projection an
    // event can replace, the binding's is only ever merged field-wise.
    return startSession(
      runtime,
      head,
      desired,
      persistedResumeCursor(runtime, head),
      pendingTurnStart
    );
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
      threadId: runtime.id,
      adapter: head.adapter,
      refId: head.refId,
      accountId: head.accountId,
      home: head.home
    });
    const launchArgs = options.launchArgsForRefId?.(head.refId) ?? [];
    const session = await adapter.startSession({
      threadId: runtime.id,
      // R4-6: the PROJECT ROOT, not the thread's `cwd`. OpenCode pools one
      // `opencode serve` per project (§3.2) and keys that pool on this field;
      // it is optional on the seam, so omitting it silently keys the pool on
      // `cwd` and a thread opened on a subdirectory spawns a second server for
      // the same checkout. `tsc` cannot catch the omission — the test does.
      projectPath: head.projectPath,
      cwd: head.cwd,
      home,
      title: head.title,
      modelSelection: head.modelSelection,
      runtimeMode: head.runtimeMode,
      ...(launchArgs.length > 0 ? { launchArgs } : {}),
      ...(resumeCursor !== undefined ? { resumeCursor } : {})
    });
    runtime.bound = { ...desired, session };
    // The binding is written BEFORE the session is announced and before any
    // history replay: a host that dies between the provider handing back a
    // cursor and `thread.session-set` landing must still find that cursor on
    // the next boot (§3.3).
    await upsertBinding(runtime, {
      adapter: head.adapter,
      adapterKey: head.refId,
      runtimeMode: head.runtimeMode,
      providerInstanceId: `${head.home}:${head.accountId}`,
      status: session.status,
      ...(session.resumeCursor !== undefined
        ? { resumeCursor: session.resumeCursor }
        : resumeCursor !== undefined
          ? { resumeCursor }
          : {})
    });
    // E6: a resumed thread whose log is empty must show the conversation it is
    // resuming. Before the session is announced, not after — otherwise the
    // first live frames interleave with history and the timeline is scrambled.
    if (resumeCursor !== undefined) {
      await projectHistoryIfEmpty(runtime, adapter);
    }
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
   * Replay the provider's own history into the thread, once, for a thread that
   * resumes from a cursor and has nothing of its own (§4.1 `readThread`).
   *
   * Everything it produces is stamped {@link HISTORICAL_RAW_SOURCE}, so it is
   * persisted and rendered but ignored by anything that reacts to new work.
   * Failure is never fatal: a thread that cannot show its history is still a
   * usable thread, so the reason lands as one activity row.
   */
  const projectHistoryIfEmpty = async (
    runtime: ThreadRuntime,
    adapter: AgentAdapter
  ): Promise<void> => {
    if (!runtime.historyPending) return;
    runtime.historyPending = false;
    const head = requireHead(runtime);
    if (!adapter.projectHistory) {
      await appendActivity(runtime, {
        kind: "runtime.warning",
        tone: "info",
        summary: "History not available for this provider",
        detail:
          "This conversation was resumed, but the agent cannot replay what was said before. New messages appear here as usual."
      });
      return;
    }
    try {
      const snapshot = await withDeadline(() => adapter.readThread(runtime.id), {
        timeoutMs: AGENT_HOST_DEADLINES.sessionOpenMs,
        label: `history:${adapter.id}`
      });
      const events = stampHistoryTimes(adapter.projectHistory(snapshot), head.createdAt);
      for (const event of events) {
        if (!isHistoricalRuntimeEvent(event)) {
          logger.warn("agent-host: a projected history event was not marked historical", {
            threadId: runtime.id,
            type: event.type
          });
        }
        await ingestion.ingest(event);
      }
      await ingestion.flushThread(runtime.id);
    } catch (error) {
      await appendActivity(runtime, {
        kind: "runtime.warning",
        tone: "info",
        summary: "History not available for this provider",
        detail: describeFailure(error)
      });
    }
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

  /**
   * §6.2: **a terminal turn cannot accept native-callback answers.**
   *
   * When a turn ends with a protocol-callback question still open, nothing
   * will ever answer it: the provider's request died with the turn, but the
   * card stays on screen, the thread stays `waiting` and the composer stays
   * blocked. Force-resolve those — and only those.
   *
   * **A message-mode question may outlive its turn** and still accept a later
   * user message, which is the whole point of `delivery: "async"`; dismissing
   * it here would delete a question the user is still meant to answer.
   *
   * *T3: `ProviderRuntimeIngestion.ts:2330-2360`* — same filter
   * (`kind === "user-input.requested" && activity.turnId === turnId &&
   * payload.responseMode !== "message"`), same "User input dismissed" summary.
   *
   * The drain is load-bearing: ingestion batches, so the request that opened
   * moments ago may still be in its buffer when the terminal event arrives,
   * and the fold this reads would not yet know about it.
   */
  const settleStrandedQuestions = async (
    runtime: ThreadRuntime,
    turnId: string | null
  ): Promise<void> => {
    if (turnId === null) return;
    await ingestion.drain();
    const stranded = (runtime.state.pending?.userInputs ?? []).filter(
      (question) => question.responseMode !== "message" && question.turnId === turnId
    );
    if (stranded.length === 0) return;
    const createdAt = clock.nowIso();
    await append(
      runtime,
      stranded.map((question) =>
        buildEvent(
          runtime.id,
          "thread.activity-appended",
          {
            activity: makeActivity({
              id: `turn-end-dismiss:${turnId}:${question.requestId}`,
              tone: "info",
              activityKind: "user-input.resolved",
              summary: "User input dismissed",
              payload: { requestId: question.requestId },
              turnId,
              createdAt
            })
          },
          { occurredAt: createdAt, metadata: { requestId: question.requestId } }
        )
      )
    );
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
    releaseProviderThreads(runtime.id);
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
    // The pre-turn baseline, BEFORE the session is ensured and before the
    // provider is asked (§5.4; T3 captures it from the domain turn-start for
    // the same reason). Waiting on `turn.started` would fold everything the
    // agent writes in the meantime — and anything a provider writes on session
    // start — into the baseline, and the turn's numstat would under-report it.
    await captureBaseline(runtime);
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
      // §4.1 "Cursor per turn": persisted every time, not only when it changed
      // — into the binding first, because that is the copy a restart reads.
      await upsertBinding(runtime, {
        status: "running",
        ...(result.resumeCursor !== undefined ? { resumeCursor: result.resumeCursor } : {})
      });
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
      const detail = describeFailure(error);
      await appendActivity(runtime, {
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail,
        requestId: turn.messageId
      });
      // `ensureSession` persisted `starting` for the pending turn start. The
      // provider produced no frames, so nothing else will ever settle it: left
      // alone the tab spins on "starting" forever, `/compact` is refused by its
      // `status === "starting"` guard and the error-state recovery carve-out
      // (`/session/stop`, `/revert`) does not apply either.
      await persistSession(runtime, {
        ...currentSession(runtime),
        status: "error",
        activeTurnId: null,
        lastError: detail
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
    // Interrupt is turn-scoped (§4.1): a Stop the client aimed at a turn that
    // is no longer the active one must not kill the next turn. Enforced here so
    // no adapter can forget it.
    if (
      turnId !== undefined &&
      session.activeTurnId !== null &&
      session.activeTurnId !== turnId
    ) {
      logger.debug("agent-host: dropping a stale interrupt", {
        threadId: runtime.id,
        turnId,
        activeTurnId: session.activeTurnId
      });
      return;
    }
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

  /**
   * The prose a message-mode answer becomes.
   *
   * **Every question is echoed before its answer**, joined by blank lines, and
   * each question's attachments follow as `Attached file: <name> (<id>)` lines
   * — T3 `decider.ts:1642-1660`. The echo is not decoration: the provider
   * parked no request, so the agent receives this as an ordinary user turn and
   * has nothing but the text to tell it which question was answered. The old
   * shape dropped the question whenever there was exactly one, which reads as
   * a bare "yes" arriving from nowhere in a transcript the agent resumes
   * later. A multi-select answer is joined with commas.
   */
  const answerMessageText = (
    questions: readonly { id: string; question: string }[],
    answers: Record<string, unknown>,
    attachmentsByQuestionId?: Record<string, AttachmentRef[]>
  ): string => {
    const parts: string[] = [];
    for (const entry of questions) {
      const raw = answers[entry.id];
      const value = Array.isArray(raw)
        ? raw.filter((item): item is string => typeof item === "string").join(", ")
        : typeof raw === "string"
          ? raw
          : "";
      const attachments = attachmentsByQuestionId?.[entry.id] ?? [];
      if (value.trim().length === 0 && attachments.length === 0) continue;
      const lines = [`${entry.question}\n${value.trim()}`.trimEnd()];
      for (const attachment of attachments) {
        lines.push(`Attached file: ${attachment.name} (${attachment.id})`);
      }
      parts.push(lines.join("\n"));
    }
    return parts.join("\n\n");
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

  /**
   * §6.3: "the bounds are checked against the file the host stat'd, not against
   * what the client claimed". The upload hop checks the stat against the
   * *declared* mime and the command hop checks the *declared* size, so neither
   * alone closes the gap — this is the one place both are known.
   */
  const assertAttachmentWithinBounds = async (
    threadId: string,
    attachment: AttachmentRef
  ): Promise<void> => {
    let path: string;
    try {
      path = await store.resolveAttachment(threadId, attachment.id);
    } catch {
      throw invalidCommand(`Attachment '${attachment.name}' is not available.`);
    }
    let sizeBytes: number;
    try {
      sizeBytes = (await stat(path)).size;
    } catch {
      throw invalidCommand(`Attachment '${attachment.name}' is not available.`);
    }
    const limit = attachment.type === "image" ? MAX_TURN_IMAGE_BYTES : MAX_TURN_FILE_BYTES;
    if (sizeBytes > limit) {
      throw invalidCommand(
        `Attachment '${attachment.name}' is ${sizeBytes} bytes, over the ${limit}-byte limit.`
      );
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
      runtime.revertedTo = targetTurnCount;
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
        runtime.lastInteractionMode = interactionMode;
        const modelSelection =
          body.modelSelection === undefined
            ? undefined
            : parseModelSelection(body.modelSelection);
        if (input.length === 0 && attachments.length === 0) {
          throw invalidCommand("A turn needs input or at least one attachment.");
        }
        // R2-7: refuse BEFORE anything is committed. The adapter throws for the
        // same text, but that happens in the turn effect — after the user's
        // message is on disk and rendered, which is the bug.
        const blocked = blockedProviderCommandMessage(head.adapter, input);
        if (blocked !== null) {
          throw invalidCommand(blocked);
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

        // The upload cap keyed on the mime the CLIENT declared at upload time,
        // and the command bounds key on the size it declares here — so a
        // 40 MiB file uploaded as `application/octet-stream` could be sent as a
        // 1 KB "image". §6.3's rule is that the bounds hold against the file
        // the host STAT'd, so the resolve path re-checks it.
        const verifyAttachments = async (): Promise<void> => {
          for (const attachment of attachments) {
            await assertAttachmentWithinBounds(runtime.id, attachment);
          }
        };

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
            void runEffect(runtime, async () => {
              try {
                await verifyAttachments();
              } catch (error) {
                await appendActivity(runtime, {
                  kind: "provider.turn.start.failed",
                  summary: "Attachment rejected",
                  detail: describeFailure(error),
                  requestId: queuedTurn.messageId
                });
                return;
              }
              await sendTurnEffect(runtime, queuedTurn);
            });
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
        const responseRequested = buildEvent(
          runtime.id,
          "thread.user-input-response-requested",
          {
            requestId,
            answers,
            ...(Object.keys(questionTextById).length > 0 ? { questionTextById } : {})
          },
          { commandId, metadata: { requestId } }
        );
        // §4.5's second question path (Codex `delivery: "async"`, T3
        // `decider.ts:1629-1702`): the provider parked NO request, so there is
        // nothing to reply to over RPC — the answer IS an ordinary message,
        // steered into the running turn (or starting one), and the card
        // closes with the same deterministic activity a dismissal writes.
        //
        // **Resolution and message are ONE command sequence.** T3 commits them
        // with a single `decideCommandSequence([activity.append,
        // turn.start])`, and the reason is an invariant rather than a tidiness
        // preference: the card must not be able to close without the message
        // being committed, nor the message be committed while the card stays
        // open. Here that is one `events` array on one decision — every event
        // below reaches `append` together or not at all — with the steer as the
        // decision's ONLY effect.
        if (question?.responseMode === "message") {
          const text = answerMessageText(question.questions, answers, attachmentsByQuestionId);
          if (text.length === 0) {
            throw invalidCommand("An answer needs some text.");
          }
          const occurredAt = clock.nowIso();
          // Deterministic, like the activity's own id (T3 mints
          // `async-answer:<requestId>` for both): a replayed command writes the
          // same message id rather than a duplicate.
          const messageId = `async-answer:${requestId}`;
          const attachments = Object.values(attachmentsByQuestionId ?? {}).flat();
          const events: AppendableDomainEvent[] = [
            responseRequested,
            buildEvent(
              runtime.id,
              "thread.activity-appended",
              {
                activity: makeActivity({
                  id: `async-answer:${requestId}`,
                  tone: "info",
                  activityKind: "user-input.resolved",
                  summary: "User input answered",
                  payload: {
                    requestId,
                    responseMode: "message",
                    answers,
                    ...(attachmentsByQuestionId !== undefined
                      ? { attachmentsByQuestionId }
                      : {})
                  },
                  turnId: session.activeTurnId,
                  createdAt: occurredAt
                })
              },
              { commandId, occurredAt, metadata: { requestId } }
            ),
            buildEvent(
              runtime.id,
              "thread.message-sent",
              {
                messageId,
                role: "user",
                text,
                streaming: false,
                turnId: session.activeTurnId,
                ...(attachments.length > 0 ? { attachments } : {})
              },
              { commandId, occurredAt }
            )
          ];
          if (session.activeTurnId === null) {
            events.push(
              buildEvent(
                runtime.id,
                "thread.turn-start-requested",
                { turnId: null, messageId, interactionMode: runtime.lastInteractionMode },
                { commandId, occurredAt }
              )
            );
          }
          const queuedTurn: QueuedTurn = {
            messageId,
            input: text,
            attachments,
            interactionMode: runtime.lastInteractionMode
          };
          return {
            events,
            schedule: () => {
              if (runtime.compacting || runtime.queuedTurns.length > 0) {
                runtime.queuedTurns.push(queuedTurn);
                return;
              }
              void runEffect(runtime, () => sendTurnEffect(runtime, queuedTurn));
            }
          };
        }
        return {
          events: [responseRequested],
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
        // Dismiss is legal ONLY for a message-mode question (T3
        // `decider.ts:1769-1775`): a native callback leaves the provider
        // blocked until it gets a reply, so it still needs an answer or an
        // interrupted turn.
        if (question.responseMode !== "message") {
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

      case "background": {
        // The user's Ctrl+B (§4.5). Refused, not ignored, where the provider
        // cannot do it — the button is gated on the same capability, so a
        // refusal here means a stale client, and it should hear so.
        const adapter = options.adapters.get(head.adapter);
        if (!adapter?.backgroundTasks || adapter.capabilities.supportsBackgroundTasks !== true) {
          throw commandRejected(`${head.adapter} cannot move a running command to the background.`);
        }
        if (session.activeTurnId === null) {
          throw commandRejected("Nothing is running.");
        }
        const toolUseId =
          typeof body.toolUseId === "string" && body.toolUseId.length > 0
            ? body.toolUseId
            : undefined;
        const createdAt = clock.nowIso();
        return {
          events: [
            buildEvent(
              runtime.id,
              "thread.activity-appended",
              {
                activity: makeActivity({
                  id: `background:${commandId}`,
                  tone: "info",
                  activityKind: "background.requested",
                  summary: toolUseId ? "Moved the command to the background" : "Moved running work to the background",
                  payload: toolUseId ? { toolUseId } : {},
                  turnId: session.activeTurnId,
                  createdAt
                })
              },
              { commandId, occurredAt: createdAt }
            )
          ],
          effect: async () => {
            if (!adapter.hasSession(runtime.id)) {
              await appendActivity(runtime, {
                kind: "provider.background.failed",
                summary: "Could not move the command to the background",
                detail: "No active provider session is bound to this thread."
              });
              return;
            }
            try {
              const moved = await adapter.backgroundTasks!(runtime.id, toolUseId);
              if (!moved) {
                await appendActivity(runtime, {
                  kind: "provider.background.failed",
                  summary: "Nothing to move to the background",
                  detail: "The command had already finished."
                });
              }
            } catch (error) {
              await appendActivity(runtime, {
                kind: "provider.background.failed",
                summary: "Could not move the command to the background",
                detail: describeFailure(error)
              });
            }
          }
        };
      }

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
        // E5: the conversation may already be open in another tab. Resuming it
        // there too would advance one provider cursor from two processes, and
        // what the user actually saw was a silent FRESH thread that remembered
        // nothing. Refuse by name unless the adapter can fork it.
        const owner = ownerOfProviderThread(request.resume.conversationId);
        if (owner !== null && owner !== threadId) {
          const canFork =
            options.adapters.get(adapterId)?.capabilities.supportsSessionFork === true;
          if (!canFork) {
            const ownerTitle = headOf(runtimes.get(owner)!)?.title ?? owner;
            throw new AgentChatCommandError(
              "COMMAND_REJECTED",
              `That conversation is already open in "${ownerTitle}". Close that tab first, or open a new conversation.`,
              { code: "RESUME_UNAVAILABLE", ownerThreadId: owner }
            );
          }
          logger.info("agent-host: forking a conversation already open elsewhere", {
            threadId,
            ownerThreadId: owner
          });
        }
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
      // Persisted BEFORE the thread exists on the wire: the very first turn
      // may start a session, and it must already see the launcher env.
      const launch = launchConfigFromRequest(request);
      runtime.launch = launch;
      await launchConfigs.save(threadId, launch).catch((error: unknown) => {
        logger.warn(`agent-host: failed to persist the launch config for ${threadId}`, error);
      });
      await runtime.commands.run(() => commit(runtime, events));
      runtime.historyPending = resumeCursor !== undefined;
      await saveHeadNow(runtime);
      if (resumeCursor !== undefined) {
        // §6.1 create-time resume: the binding is seeded here, not at the first
        // session start, so a host that dies before the eager start still has
        // the cursor the tab was opened with.
        await upsertBinding(runtime, {
          adapter: adapterId,
          adapterKey: request.refId,
          runtimeMode,
          providerInstanceId: `${home}:${request.accountId}`,
          status: "stopped",
          resumeCursor
        });
      }
      if (resumeCursor !== undefined) {
        // E2E R2-2: open the session NOW rather than on the first turn. History
        // can only be read through a live provider session, so a lazy start
        // left a resumed tab blank until the user typed — and then replayed the
        // old conversation UNDER the new prompt, because the `/turn` had
        // already committed its message. Queued on `effects`, so it neither
        // delays this response nor races a later turn's session start.
        void runtime.effects
          .run(() => ensureSession(runtime))
          .catch((error: unknown) => {
            // A resume that cannot open its session is reported by the turn
            // that needs it; opening early is an optimisation, not a contract.
            logger.info("agent-host: eager resume session did not open", {
              threadId,
              error: describeFailure(error)
            });
          });
      }
      return requireHead(runtime);
    });

  const updateThread = async (
    threadId: string,
    input: { title?: string; seed?: boolean }
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
        // A client-minted `rename:` id marks the user's OWN rename, which a
        // provider retitle may never overwrite (§5.1). The client's auto-seed
        // from the first message travels this same route but is not a rename
        // (§7.7): it carries no such id and leaves `titleManual` alone, so the
        // provider's generated name can still land. Without this split every
        // real thread — they all get seeded — froze at the seed forever.
        const seeded = input.seed === true;
        const result = await commit(runtime, [
          buildEvent(
            threadId,
            "thread.meta-updated",
            { title: input.title.trim() },
            seeded ? {} : { commandId: `rename:${ids.uuid()}` }
          )
        ]);
        if (!seeded) {
          runtime.titleManual = true;
        }
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
      if (head) {
        // One last frame for anything still watching this thread, before the
        // log it would replay from stops existing.
        await append(runtime, [
          buildEvent(threadId, "thread.deleted", { deletedAt: clock.nowIso() })
        ]).catch(() => undefined);
      }
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
      // The `thread.deleted` event above is the last frame every open stream
      // gets; detach them so a stream that outlives this call cannot be
      // published into, and free the per-thread ingestion state — nothing else
      // ever tells ingestion a thread is gone.
      runtime.subscribers.clear();
      runtime.watchdog?.stop();
      await ingestion.forget(threadId);
      releaseProviderThreads(threadId);
      runtimes.delete(threadId);
      loadingRuntimes.delete(threadId);
    });

  // -------------------------------------------------------------------------
  // Reads (§6.3)
  // -------------------------------------------------------------------------

  const snapshotOf = (runtime: ThreadRuntime): ThreadSnapshotPayload => {
    const payload = fold.snapshot(runtime.state);
    // §5.6's two snapshot-time drops are not applied on the write path, so the
    // read applies them: a superseded `tool.updated` and a stale
    // `context-window.updated` never reach a client that loads the thread cold.
    const kept = new Set(
      projectSnapshotActivities(
        payload.items.filter((item): item is ThreadActivityItem => item.kind === "activity")
      ).map((activity) => activity.id)
    );
    // §5.6: the full payload is persisted and slimmed on the way to the wire.
    // This is the snapshot half of the choke point (`stream.ts` is the live
    // half); `GET …/items/:itemId` stays unslimmed and is what "load full
    // output" reads.
    const items = payload.items
      .filter((item) => item.kind !== "activity" || kept.has(item.id))
      .map((item) => {
        if (item.kind !== "activity") return item;
        const slimmed = slimActivityPayload(item.payload);
        return slimmed === item.payload ? item : { ...item, payload: slimmed };
      });
    const head =
      runtime.continueAfterRestart === undefined
        ? payload.head
        : { ...payload.head, continueAfterRestart: runtime.continueAfterRestart };
    return { ...payload, head, items };
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
    // `seq` is per thread and increments by one per event, so the head minus
    // the cursor IS the row count. Checking it before the read keeps an
    // oversized range from being loaded just to be discarded.
    if (runtime.state.seq - afterSeq > AGENT_CHAT_REPLAY_MAX_EVENTS) {
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
    const replay: DomainEvent[] = [];
    for (const event of tail.events) {
      if (event.type === "thread.created" || event.type === "thread.reverted") {
        // A recreated thread, or a revert truncation below `after`.
        return null;
      }
      // R5-1: a replay is a READ, so §5.6 slimming applies to it exactly as it
      // does to the snapshot and the live stream — this is the third arm of
      // the same choke point. Without it a reconnect ships the full persisted
      // payload (a 32 KiB `tool.completed` went out at ~33 KB) and, worse,
      // arrives with `truncated` unset, so the client can never offer "load
      // full output" for a row it received on this path.
      const slimmed = slimActivityEvent(event);
      // Row count alone is not a bound: a handful of events with large tool
      // payloads decode to far more than their number suggests, which is why
      // the byte budget is measured before the replay is used. Measured on the
      // SLIMMED row, because the budget bounds what goes on the wire — sizing
      // the persisted payload would force a snapshot for a range that fits.
      bytes += serializedSize(slimmed);
      if (bytes > AGENT_CHAT_REPLAY_PAYLOAD_BUDGET_BYTES) {
        return null;
      }
      replay.push(slimmed);
    }
    return replay;
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

  const summary = (threadId: string): HostThreadSummary | null => {
    const runtime = runtimes.get(threadId);
    const head = runtime ? headOf(runtime) : null;
    if (!runtime || !head) return null;
    const pending = runtime.state.pending ?? { approvals: [], userInputs: [] };
    const turns = runtime.state.turns ?? [];
    const latest = turns.length > 0 ? turns[turns.length - 1]! : null;
    return {
      hasPendingApprovals: pending.approvals.length > 0,
      hasPendingUserInput: pending.userInputs.length > 0,
      // The ids and labels the daemon's `agentChat.pending` needs (§6.4): the
      // booleans say that something is pending, not which.
      pendingRequests: [
        ...pending.approvals.map((approval) => ({
          requestId: approval.requestId,
          kind: "approval" as const,
          title: approvalTitle(approval)
        })),
        ...pending.userInputs.map((question) => ({
          requestId: question.requestId,
          kind: "question" as const,
          title: questionTitle(question)
        }))
      ],
      hasActionableProposedPlan: hasActionableProposedPlan(runtime),
      backgroundLiveness: liveness.liveness(threadId),
      latestTurn: latest
        ? {
            turnId: latest.turnId,
            state: latest.state,
            startedAt: latest.startedAt,
            completedAt: latest.completedAt,
            // Forwarded so the daemon can carry it on `agentChat.turn` (§6.4)
            // without a second read; absent until the fold stamps it.
            ...(latest.tokenUsage !== undefined ? { tokenUsage: latest.tokenUsage } : {})
          }
        : null,
      chatSessionStatus: head.session.status
    };
  };

  const threadContext = (
    threadId: string
  ): { session?: ThreadSessionState; titleManual?: boolean } | null => {
    const runtime = runtimes.get(threadId);
    if (!runtime) return null;
    const head = headOf(runtime);
    return {
      ...(head ? { session: head.session } : {}),
      titleManual: runtime.titleManual
    };
  };

  const placeholderCheckpoint = (input: {
    threadId: string;
    turnId: string;
  }): { turnCount: number } | null => {
    const runtime = runtimes.get(input.threadId);
    if (!runtime || runtime.checkpointsUnavailable) {
      return null;
    }
    // Only the session's running turn may open a placeholder.
    if (currentSession(runtime).activeTurnId !== input.turnId) {
      return null;
    }
    const existing = (runtime.state.checkpoints ?? []).find(
      (checkpoint) => checkpoint.turnId === input.turnId
    );
    if (existing) {
      // A real checkpoint already covers this turn; §5.4 reuses its own count.
      return null;
    }
    return { turnCount: maxCheckpointTurnCount(runtime) + 1 };
  };

  const launchConfig = (threadId: string): ThreadLaunchConfig | null =>
    runtimes.get(threadId)?.launch ?? null;

  const launchConfigForCwd = (cwd: string): ThreadLaunchConfig | null => {
    let best: { launch: ThreadLaunchConfig; updatedAt: string } | null = null;
    for (const runtime of runtimes.values()) {
      const head = headOf(runtime);
      if (!head || runtime.deleted || !runtime.launch) continue;
      if (head.cwd !== cwd && head.projectPath !== cwd) continue;
      if (best === null || head.updatedAt > best.updatedAt) {
        best = { launch: runtime.launch, updatedAt: head.updatedAt };
      }
    }
    return best?.launch ?? null;
  };

  const adapterForThread = (threadId: string): AgentAdapterId | null => {
    const runtime = runtimes.get(threadId);
    const head = runtime ? headOf(runtime) : null;
    if (head) return head.adapter;
    for (const [id, adapter] of options.adapters) {
      if (adapter.hasSession(threadId)) return id;
    }
    return null;
  };

  const onAccountEvent = (event: RuntimeEvent): void => {
    const adapterId = adapterForThread(event.threadId);
    if (!adapterId) return;
    // Two different facts arrive on this hook: a rate-limit window and an auth
    // failure. `applyUsageLimits` ignores everything but the former, so the
    // latter needs its own sink or it is dropped on the floor and §7.7's toast
    // never fires.
    snapshots.applyUsageLimits(adapterId, event);
    snapshots.applyAuthStatus?.(adapterId, event);
  };

  const subscribe = async (
    threadId: string,
    subscription: ThreadSubscription
  ): Promise<() => void> =>
    // Through the gate like every other entry point: a stream that loaded a
    // runtime before the gate opened would race the §3.3 reconcile for it.
    whenReady(async () => {
      const runtime = await loadRuntime(threadId);
      runtime.subscribers.add(subscription);
      return () => {
        runtime.subscribers.delete(subscription);
      };
    });

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

  /**
   * Awaitable on purpose (§5.4, R5 #6): the baseline must be "the tree as it
   * was before the turn", so the `/turn` dispatch path waits for it. The
   * `turn.started` call site stays fire-and-forget — by then it is only the
   * idempotent backstop, and `checkpoints.captureBaseline` answers `null`
   * without touching the tree once the ref exists.
   */
  const captureBaseline = (runtime: ThreadRuntime, turnId?: string | null): Promise<void> => {
    const head = headOf(runtime);
    if (!head) return Promise.resolve();
    return runtime.captures
      .run(async () => {
        const result = await checkpoints.captureBaseline({
          threadId: runtime.id,
          cwd: head.cwd,
          checkpoints: runtime.state.checkpoints ?? [],
          ...(turnId === undefined ? {} : { turnId })
        });
        // A non-git project skips silently — and stops the ingestion
        // placeholder of §5.4 being written for it at all.
        if (!result) {
          runtime.checkpointsUnavailable = true;
          return;
        }
        runtime.checkpointsUnavailable = false;
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
        // A capture that lands after a revert belongs to a turn the revert
        // truncated; appending it raises `head.turnCount` past the target and
        // visibly undoes the rewind (the checkpoint list keeps a row with no
        // matching turn).
        const revertedTo = runtime.revertedTo;
        if (revertedTo !== null && summary.turnCount > revertedTo) {
          logger.info("agent-host: dropping a checkpoint for a reverted turn", {
            threadId: runtime.id,
            turnCount: summary.turnCount,
            revertedTo
          });
          return;
        }
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
            if (event.type === "thread.started") {
              providerThreadOwners.set(event.payload.providerThreadId, event.threadId);
            }
          }
          // `auth.status` and `account.rate-limits.updated` are not thread
          // facts: ingestion hands them to `onAccountEvent`, which routes them
          // to the snapshot registry (§5.1). One path, not two.
          await ingestion.ingest(event);
          if (runtime) {
            // After ingestion, so the fold already holds the turn row the
            // capture reads its `assistantMessageId` from.
            if (event.type === "turn.started") {
              // Backstop for turns the host did not dispatch itself (a
              // continuation, an adapter-initiated turn). The turn id is
              // recorded with it, so a stale abort for another turn cannot
              // mint a checkpoint later (§5.4).
              void captureBaseline(runtime, event.turnId ?? null);
            } else if (event.type === "turn.completed" || event.type === "turn.aborted") {
              persistCursorAtTurnEnd(runtime);
              captureTurnEnd(runtime, event.turnId ?? null);
              // A replayed turn is the past: its questions were settled when it
              // happened, and there is no live provider to strand.
              if (!isHistoricalRuntimeEvent(event)) {
                await settleStrandedQuestions(runtime, event.turnId ?? null);
              }
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

  /** The thread that currently owns a provider conversation, if any is live. */
  const ownerOfProviderThread = (providerThreadId: string): string | null => {
    const owner = providerThreadOwners.get(providerThreadId);
    if (owner === undefined) return null;
    // An owner whose session is gone no longer owns anything.
    const runtime = runtimes.get(owner);
    const head = runtime ? headOf(runtime) : null;
    const live =
      head !== null &&
      head.session.status !== "stopped" &&
      head.session.status !== "idle" &&
      (options.adapters.get(head.adapter)?.hasSession(owner) ?? false);
    if (!live) {
      providerThreadOwners.delete(providerThreadId);
      return null;
    }
    return owner;
  };

  const releaseProviderThreads = (threadId: string): void => {
    for (const [providerThreadId, owner] of [...providerThreadOwners]) {
      if (owner === threadId) providerThreadOwners.delete(providerThreadId);
    }
  };

  /**
   * Claude refreshes its cursor mid-turn; keep the bound copy current — and the
   * binding with it. The bound copy is process state and dies with the host;
   * the binding is the only thing the next one can read.
   */
  const trackSessionCursor = (runtime: ThreadRuntime, event: RuntimeEvent): void => {
    if (event.type === "thread.started") {
      void upsertBinding(runtime, { providerThreadId: event.payload.providerThreadId });
      return;
    }
    if (event.type !== "session.started") return;
    const resume = event.payload.resume;
    if (resume === undefined) return;
    void upsertBinding(runtime, { resumeCursor: resume });
    if (!runtime.bound) return;
    runtime.bound = {
      ...runtime.bound,
      session: { ...runtime.bound.session, resumeCursor: resume }
    };
  };

  /**
   * A turn ending is the other moment a provider's native boundary moves, and
   * for a turn the host did not dispatch (a background turn, a continuation)
   * there is no `sendTurn` result to record it from. Read the adapter's live
   * session and save the cursor before anything can checkpoint the turn.
   *
   * *T3: `ProviderService.ts:1104-1129` — the same hook on
   * `turn.completed` / `turn.aborted`.*
   */
  const persistCursorAtTurnEnd = (runtime: ThreadRuntime): void => {
    const head = runtime.state.head;
    if (!head) return;
    const adapter = options.adapters.get(head.adapter);
    const session = adapter?.listSessions().find((entry) => entry.threadId === runtime.id);
    if (session?.resumeCursor === undefined) return;
    void upsertBinding(runtime, { resumeCursor: session.resumeCursor });
  };

  /** The sink `createIngestion` writes translated domain events into. */
  const ingestionSink = async (
    threadId: string,
    events: AppendableDomainEvent[]
  ): Promise<void> => {
    if (events.length === 0) return;
    const runtime = runtimes.get(threadId) ?? (await loadRuntime(threadId));
    // The pending-turn rule is the host's, not any one writer's: an adapter
    // that reports `ready` while a turn start is in flight must not settle the
    // row the command opened.
    const guarded = events.map((event) => {
      if (event.type !== "thread.session-set") return event;
      const session = coerceSessionForPendingTurn(runtime, event.payload.session);
      return session === event.payload.session
        ? event
        : { ...event, payload: { ...event.payload, session } };
    });
    await append(runtime, guarded);
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
        // The cursor is read from the BINDING (§3.3): a marker is only ever
        // written for a thread that really can be resumed, and the head's copy
        // is a projection that an event may already have replaced.
        if (persistedResumeCursor(runtime, head) === undefined) continue;
        // …and only where the project opted in. Continuation is opt-in per
        // project over a host-wide default that is OFF, so a marker written
        // for an opted-out thread would make the next boot resume it — the
        // reconcile trusts a marker on its own, exactly because the stop path
        // is supposed to be the place that filter is applied.
        if ((await options.continuationEnabled?.(head.projectPath)) !== true) continue;
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
    // The binding follows the session (`status`), never the cursor: a thread
    // that could not be continued is still resumable by hand from the same
    // cursor, so clearing it here would throw away the conversation the user
    // is about to send into (*T3: `serverRuntimeStartup.ts:588-604`*).
    await upsertBinding(runtime, { status: "stopped" });
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

  /**
   * A `pending` turn belongs to a `/turn` whose effect never ran — the host
   * died between the commit and the send. Nothing on the live path settles it
   * (the provider produced no frames at all), so the reconcile does, bounded
   * by {@link PENDING_TURN_GRACE_MS} so a turn that is merely slow to start on
   * a live session is left alone.
   */
  const settleStalePendingTurns = async (runtime: ThreadRuntime): Promise<void> => {
    const head = headOf(runtime);
    if (!head) return;
    const now = clock.now().getTime();
    const stale = (runtime.state.turns ?? []).some((turn) => {
      if (turn.state !== "pending") return false;
      const requestedAt = Date.parse(turn.requestedAt);
      return !Number.isFinite(requestedAt) || now - requestedAt > PENDING_TURN_GRACE_MS;
    });
    if (!stale) return;
    await appendActivity(runtime, {
      kind: "provider.turn.start.failed",
      summary: "Queued message was not sent",
      detail: CONTINUATION_FAILED_MESSAGE
    });
    // Settling is by session status (§5.1): `stopped` folds the pending turn
    // to `interrupted` without claiming the session itself failed.
    await persistSession(runtime, {
      ...currentSession(runtime),
      status: "stopped",
      activeTurnId: null
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
      await settleStalePendingTurns(runtime);
      return;
    }

    // §3.4's bounded grace window. A `/turn` commits its message and its
    // pending turn row BEFORE the effect runs, so a host that dies in that
    // window leaves a `pending` turn with an idle head: not "orphaned" by the
    // filter above, but `deriveLatestTurn` reports it forever and the status
    // line shows the thread working with nothing behind it.
    await settleStalePendingTurns(runtime);

    const closed = runtime.deleted || (await options.isThreadClosed?.(threadId)) === true;
    const markerMatches =
      marker !== undefined &&
      (session.activeTurnId === null || marker.turnId === session.activeTurnId);
    const optIn = (await options.continuationEnabled?.(head.projectPath)) === true;
    const hasCursor = persistedResumeCursor(runtime, head) !== undefined;
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
    // Durable first, dispatched second: the marker and the binding's
    // `starting` both reach disk BEFORE any send, so a host that dies between
    // resuming and sending is recovered by the next boot rather than looking
    // like a settled thread (*T3: `serverRuntimeStartup.ts:655-690`*).
    try {
      await writeMarker(runtime, { turnId, prepared: true });
      await upsertBinding(runtime, { status: "starting" });
      await persistSession(runtime, { ...session, status: "starting", activeTurnId: null });
    } catch (error) {
      // A prepare that cannot reach disk must not be followed by a send: the
      // turn would then be running with nothing durable saying so
      // (*T3: `serverRuntimeStartup.ts:684-693`*).
      logger.warn(`agent-host: failed to prepare the continuation of ${threadId}`, error);
      await settleAsError(runtime, CONTINUATION_FAILED_MESSAGE);
      return;
    }

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
        await upsertBinding(runtime, {
          status: "running",
          ...(result.resumeCursor !== undefined ? { resumeCursor: result.resumeCursor } : {})
        });
        await persistSession(runtime, {
          ...currentSession(runtime),
          status: "running",
          activeTurnId: result.turnId,
          ...(result.resumeCursor !== undefined ? { resumeCursor: result.resumeCursor } : {})
        });
        // The continuation is the one send that bypasses `sendTurnEffect`, and
        // a turn resumed from a cursor is the case most likely to wedge — arm
        // the §3.1 watchdog for it too, or it has no liveness bound at all.
        watchdogFor(runtime);
        // 4. Clear the marker on success.
        await writeMarker(runtime, undefined);
      } catch (error) {
        logger.warn(`agent-host: failed to continue ${threadId} after a restart`, error);
        // A continuation that was ATTEMPTED and failed says so; the orphan
        // message above is for a thread that was never eligible (§3.3 step 4).
        await settleAsError(runtime, CONTINUATION_SEND_FAILED_MESSAGE);
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

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    // A second caller awaits the first rather than returning to a half-stopped
    // host.
    stopping ??= runStop();
    return stopping;
  };

  const runStop = async (): Promise<void> => {
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
    threadContext,
    launchConfig,
    launchConfigForCwd,
    placeholderCheckpoint,
    onAccountEvent,
    adapterForThread,
    providers: () => snapshots.all(),
    providersChangeCount: () => snapshots.changeCount?.() ?? 0,
    refreshProvider: async (adapterId, input) => {
      if (snapshots.refreshDetailed) {
        const { snapshot, changed } = await snapshots.refreshDetailed(adapterId, input);
        return { provider: snapshot, changed };
      }
      // An identical configuration short-circuits to the cached value, so a
      // registry without the detailed call reports "changed" by identity.
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

/**
 * The §6.4 fields plus the open requests behind two of the booleans. Declared
 * here rather than on `AgentChatSessionSummaryFields`, which is the shared
 * client-facing contract; this shape never leaves the host↔daemon socket.
 */
export interface HostThreadSummary extends AgentChatSessionSummaryFields {
  pendingRequests: Array<{
    requestId: string;
    kind: "approval" | "question";
    title: string;
  }>;
}

/**
 * The prefix the client puts on the turn it sends when the user clicks
 * Implement. Mirrors `PLAN_IMPLEMENTATION_PROMPT_PREFIX` in
 * `packages/ui/src/lib/agent-chat/entries.logic.ts`; the host cannot import
 * from the UI package, so the literal is pinned here and in a test.
 */
export const PLAN_IMPLEMENTATION_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:\n";

/**
 * §6.4 / §7.3: `hasActionableProposedPlan` is `implementedAt === null` for the
 * **latest** proposed plan — not "a plan was ever proposed". Without the
 * second half the flag is sticky-true for as long as that one row survives
 * retention, so every surface reading it shows a permanent "Plan Ready" and
 * §6.4's ranking puts it above Monitoring forever.
 */
function hasActionableProposedPlan(runtime: ThreadRuntime): boolean {
  const items = runtime.state.items ?? [];
  let latestPlanIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "activity" && item.activityKind === "turn.proposed.completed") {
      latestPlanIndex = index;
      break;
    }
  }
  if (latestPlanIndex < 0) {
    return false;
  }
  for (let index = latestPlanIndex + 1; index < items.length; index += 1) {
    const item = items[index]!;
    if (
      item.kind === "message" &&
      item.role === "user" &&
      item.text.startsWith(PLAN_IMPLEMENTATION_PROMPT_PREFIX)
    ) {
      return false;
    }
  }
  return true;
}

const REQUEST_KIND_TITLES: Readonly<Record<string, string>> = {
  command: "Run a command",
  "file-read": "Read a file",
  "file-change": "Change a file",
  "mcp-elicitation": "Answer an MCP request",
  permission: "Grant a permission"
};

/** A short, safe label — never the tool payload, which can be the repository. */
function approvalTitle(approval: PendingApproval): string {
  return REQUEST_KIND_TITLES[approval.requestKind] ?? "Approve a request";
}

function questionTitle(question: PendingUserInput): string {
  const first = question.questions[0];
  const text = first?.header?.trim() || first?.question?.trim();
  return text && text.length > 0 ? text : "Answer a question";
}

const sizeCache = new WeakMap<object, number>();

/**
 * An event's serialized size is measured once and cached by identity, since one
 * event object is shared by every stream watching that thread (§6.3).
 */
/**
 * Give every projected history row a time that sorts BEFORE the thread's own
 * first row (E2E R2-2).
 *
 * An adapter that reads a real timestamp out of its transcript keeps it — that
 * is the honest answer and the only one that survives a sort. An adapter that
 * stamps `now` (all of them did at first) would otherwise render a year-old
 * conversation as having happened after the prompt the user just typed, so
 * those rows are laid out on a monotonic ramp of one millisecond each, ending
 * just before the thread was created. Order within the projection is the
 * adapter's, and is preserved either way.
 *
 * A stamp that is merely unparseable is treated as missing, not as a reason to
 * drop the row: history that renders at an approximate time beats no history.
 */
export function stampHistoryTimes<TEvent extends { createdAt?: string }>(
  events: readonly TEvent[],
  createdAt: string
): TEvent[] {
  const anchorMs = Date.parse(createdAt);
  if (!Number.isFinite(anchorMs)) {
    return [...events];
  }
  return events.map((event, index) => {
    const ownMs = event.createdAt === undefined ? NaN : Date.parse(event.createdAt);
    if (Number.isFinite(ownMs) && ownMs < anchorMs) {
      return event;
    }
    return { ...event, createdAt: new Date(anchorMs - (events.length - index)).toISOString() };
  });
}

export function serializedSize(value: object): number {
  const cached = sizeCache.get(value);
  if (cached !== undefined) {
    return cached;
  }
  const bytes = Buffer.byteLength(JSON.stringify(value));
  sizeCache.set(value, bytes);
  return bytes;
}
