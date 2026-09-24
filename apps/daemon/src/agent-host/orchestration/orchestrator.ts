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
  ACTIVITY_RETENTION_LIMIT,
  AGENT_ACTIVITY_RETENTION_LIMIT,
  AGENT_ACTIVITY_TOTAL_LIMIT,
  COMMANDS_ALLOWED_IN_ERROR_STATE,
  DEFAULT_RUNTIME_MODE,
  GOAL_COMMAND_FAILED_ACTIVITY_KIND,
  GOAL_STATUS_ACTIVITY_KIND,
  IDENTITY_CHANGED_ACTIVITY_KIND,
  MAX_TURN_FILE_BYTES,
  MAX_TURN_IMAGE_BYTES,
  THREAD_HISTORY_DEFAULT_TURNS,
  THREAD_HISTORY_MAX_TURNS,
  THREAD_SEARCH_MAX_RESULTS,
  decodeHistoryCursor,
  deserializeFoldState,
  encodeHistoryCursor,
  isHistoricalRuntimeEvent,
  isUnfinishedGoal,
  SETTLED_TURN_STATES,
  slimActivityPayload,
  startedTurns,
  turnOrdinal,
  type AgentAdapterId,
  type AgentChatCommandName,
  type AgentChatGoalSummary,
  type AgentChatSessionSummaryFields,
  type AgentGoal,
  type AttachmentRef,
  type ComposerContextRecord,
  type DomainEvent,
  type HistoryCursor,
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
  type ThreadHistoryBounds,
  type ThreadHistoryPage,
  type ThreadHistoryTurn,
  type ThreadItem,
  type ThreadItemOutputResponse,
  type ThreadReadResponse,
  type ThreadSearchResponse,
  type ThreadSessionState,
  type ThreadSessionStatus,
  type ThreadSnapshotPayload,
  type Turn,
  AGENT_CHAT_REPLAY_MAX_EVENTS,
  AGENT_CHAT_REPLAY_PAYLOAD_BUDGET_BYTES
} from "@orquester/api/agent-chat";

import type { AccountHome } from "@orquester/api/agent-chat";

/**
 * The prefix the client puts on the turn it sends when the user clicks
 * Implement: one spelling in `@orquester/api/agent-chat`, shared with the UI
 * and the MCP, and read back only through `isPlanImplementationMessage`.
 * Re-exported so existing imports from this module keep working.
 */
import {
  isPlanImplementationMessage,
  PLAN_IMPLEMENTATION_PROMPT_PREFIX
} from "@orquester/api/agent-chat";
export { PLAN_IMPLEMENTATION_PROMPT_PREFIX };

import { stat } from "node:fs/promises";

import type {
  AdapterLogger,
  AgentAdapter,
  GoalCommandOptions,
  HostGoalCommand
} from "../adapter.ts";
import {
  CONTINUATION_FAILED_MESSAGE,
  CONTINUATION_PROMPT,
  CONTINUATION_SEND_FAILED_MESSAGE,
  COMPACTION_FAILED_MESSAGE,
  type CreateHostThreadRequest,
  type SetThreadIdentityRequest
} from "../host-protocol.ts";
import type {
  AppendableDomainEvent,
  AppendResult,
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
import type { IndexedItemPosition, IndexedTurn, ThreadIndex } from "../index/index.ts";
import { slimActivityEvent } from "../ingestion/coalesce.ts";
import { bindingResumeCursor } from "../store/binding.ts";
import { joinToolOutput } from "../store/tool-output.ts";
import { projectSnapshotActivities } from "../ingestion/index.ts";
import {
  AGENT_HOST_DEADLINES,
  GOAL_CONTINUATION_GRACE_MS,
  withDeadline
} from "../support/deadline.ts";
import { attachedFileLine } from "../adapters/attachment-lines.ts";
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
import { applyEventsChunked, DEFAULT_FOLD_OPS, type FoldOps } from "./fold-ops.ts";
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
  identitySwitchRefusal,
  modelSelectionEquals,
  type BoundSessionShape,
  type DesiredSessionShape
} from "./session-policy.ts";
import {
  blockedProviderCommandMessage,
  COMPACT_COMMAND_TEXT,
  isHostNativeCompact,
  parseHostGoalCommand,
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

/**
 * The store plus the three optional members W2's implementation adds beyond the
 * `ThreadStore` seam: the parse message for a thread that could not be read,
 * the backwards log scan that serves a `GET …/items/:id` for a row the fold's
 * retention window already dropped, and the join of a tool call's streamed
 * output that serves `GET …/items/:id/output`. Without the last two the
 * orchestrator reads `readAll` itself.
 */
export type HostThreadStore = ThreadStore & {
  threadError?(threadId: string): string | null;
  readItem?(threadId: string, itemId: string): Promise<ThreadItem | null>;
  /** One `readLog` joining a call's `tool.output` chunks (`store/tool-output.ts`). */
  readToolOutput?(threadId: string, itemId: string): Promise<ThreadItemOutputResponse | null>;
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
  /**
   * The host-wide thread index (design 2026-09-23, C): a disposable cache of
   * turn boundaries and full text, fed from `commit` strictly after the log.
   * Absent or `available: false`, history answers 503 `INDEX_UNAVAILABLE`,
   * search answers `indexed: false`, and nothing else changes.
   */
  index?: ThreadIndex;
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
   * Goals §5.5, head-only like {@link continueAfterRestart}: the handover
   * found this thread's goal continuing, so this host resumes its provider
   * session after the gate opens — and the summary keeps the goal
   * `continuing` until then.
   */
  resumeGoalAfterRestart: true | undefined;
  /**
   * When this host last started a provider session for the thread (epoch ms),
   * or null. A (re)started session is an idle point a provider continues its
   * goal from (Codex, right after a resume), so it opens the
   * {@link GOAL_CONTINUATION_GRACE_MS} window as a settled turn does.
   */
  sessionStartedAt: number | null;
  /**
   * `binding.json` — the durable provider-session binding (§3.3, §4.1) and the
   * AUTHORITY for the resume cursor. `null` until the thread has one; the head's
   * cursor is the fallback for a thread written before bindings existed (§8).
   */
  binding: ProviderSessionBinding | null;
  eventsSinceHeadSave: number;
  /**
   * Events committed since the last fold snapshot (`state.json`) was written
   * (design 2026-09-23, A2) — or folded at load on top of the one read back.
   */
  eventsSinceSnapshot: number;
  /** When this runtime last wrote `state.json` (epoch ms); 0 until it has. */
  lastSnapshotAt: number;
  /**
   * `revertedTo` and `titleManual` exactly as the LOG derives them, advanced
   * inside `commit` with every batch. This — not the live pair below — is what
   * a fold snapshot carries in `extras`: the live `revertedTo` is lifted by
   * the runtime `turn.started` and armed only after the revert's append
   * returns, and the live `titleManual` is set only after the rename commits,
   * so a snapshot written inside the very commit that moved them would carry
   * the old value and a restart would lose the manual title or the late-
   * capture guard. A reload from snapshot + tail must equal a reload from the
   * whole log, and this is the value the whole log gives.
   */
  logDerived: LogDerived;
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
   * Target of the most recent `thread.reverted`, until the next turn starts;
   * otherwise null.
   *
   * A capture that lands after a revert belongs to a turn the revert
   * truncated, and appending it raises `head.turnCount` past the target —
   * visibly undoing the rewind and leaving a checkpoint row with no turn. It
   * cannot be derived from the fold: after the revert the head's count and the
   * highest surviving checkpoint are equal again.
   *
   * The guard compares COUNTS, so it must end where the next genuine turn
   * begins: that turn is numbered `target + 1` (§5.5, turns count by order)
   * and would otherwise be dropped — and with it every turn after it, for the
   * life of the thread. A `turn.started` clears it (`consume`), and a host
   * restart re-derives it the same way (`advanceLogDerived`).
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
 * Inside a long turn a fold snapshot is written once at least this many
 * events AND {@link FOLD_SNAPSHOT_MIN_INTERVAL_MS} have passed since the last
 * one (design 2026-09-23, A2); every session transition writes one anyway.
 */
export const FOLD_SNAPSHOT_EVENT_INTERVAL = 200;

/**
 * The time half of the in-turn gate. Serializing a big thread's state blocks
 * the loop for ~160 ms (a 22 MiB `state.json`, measured on real logs), so a
 * subagent-heavy turn appending hundreds of events a minute must not write one
 * every 200 events — that is a loop-stalling, disk-churning loop.
 */
export const FOLD_SNAPSHOT_MIN_INTERVAL_MS = 30_000;

/** `ThreadRuntime.logDerived`: the two derivations a fold snapshot carries in `extras`. */
interface LogDerived {
  revertedTo: number | null;
  titleManual: boolean;
}

const EMPTY_LOG_DERIVED: LogDerived = { revertedTo: null, titleManual: false };

/**
 * §3.4's "bounded grace window" on a queued turn start. A `pending` turn older
 * than this on a host that is only now starting belongs to a send that never
 * happened; anything shorter would settle a turn that is merely slow to reach
 * the provider.
 */
export const PENDING_TURN_GRACE_MS = 5 * 60_000;


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
  /**
   * §3.4's account switch, applied on the thread's next message.
   *
   * Serialised on the thread's own command queue and receipt-tracked by
   * `commandId`, exactly like a §6.2 command, but it starts **no** session: the
   * `ensureSession` step on the next `/turn` sees the changed `accountKey`,
   * restarts with reason `"account"` and carries the resume cursor.
   */
  setIdentity(threadId: string, request: SetThreadIdentityRequest): Promise<{ seq: number }>;
  deleteThread(threadId: string): Promise<void>;

  command(
    threadId: string,
    name: AgentChatCommandName,
    body: unknown
  ): Promise<{ seq: number }>;

  readThread(threadId: string, afterSeq?: number): Promise<ThreadReadResponse>;
  /**
   * A page of turns OLDER than the retained window (design 2026-09-23, C):
   * their turn rows from the index, their items folded from exactly the log
   * bytes they span. Throws `INDEX_UNAVAILABLE` (503) without a usable index.
   */
  readHistory(
    threadId: string,
    query: { before?: string; turns?: number }
  ): Promise<ThreadHistoryPage>;
  /** Full-text search over every indexed thread; `indexed: false` without an index. */
  searchThreads(query: { q: string; limit: number; projectPath?: string }): ThreadSearchResponse;
  readItem(threadId: string, itemId: string): Promise<ThreadItem | null>;
  /**
   * `GET …/items/:itemId/output`: the streamed output of the tool call the item
   * belongs to, joined from the log; null when the item names no call.
   */
  readToolOutput(threadId: string, itemId: string): Promise<ThreadItemOutputResponse | null>;
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

  /**
   * `GET /health` — the drain-restart of §3.1 waits on `activeTurnThreadIds`
   * AND `backgroundWorkThreadIds`: a subagent fleet or a background shell that
   * outlives its turn is work a host restart would kill.
   */
  liveThreadIds(): string[];
  activeTurnThreadIds(): string[];
  backgroundWorkThreadIds(): string[];

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
  /**
   * The lazy boot (design 2026-09-23, A1): threads the §3.3 reconcile judged
   * NOT orphaned from `meta.json` alone, and therefore did not fold. The
   * stale-pending-turn settle the reconcile used to run on every one of them
   * at boot runs instead on the thread's first load, before anyone can see
   * it (`loadRuntime`).
   */
  const bootSettlePending = new Set<string>();
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
    // Goals §5.5: what the reconcile collected, after readiness — never on it.
    startGoalResumes();
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
      .then(async (runtime) => {
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
        // A1: the boot-time settle this thread was spared, run BEFORE the
        // runtime is published. Every concurrent caller awaits this same
        // promise, so the first thing anyone can see of the thread — a read,
        // a stream's snapshot, a command's decide — is already settled.
        if (bootSettlePending.delete(threadId)) {
          await settleOnFirstLoad(runtime);
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

  /**
   * One thread's fold state, off disk: `state.json` plus the log's tail when
   * the snapshot still matches the log, the whole log otherwise (design
   * 2026-09-23, A2). The log is the only authority — a snapshot that is
   * missing, corrupt, another version, another thread's, or no longer a
   * prefix of the log is discarded and the log is folded from the top. Either
   * way the fold yields to the event loop every 500 events (invariant 7).
   */
  const foldFromDisk = async (
    threadId: string
  ): Promise<{
    state: ThreadFoldState;
    derived: LogDerived;
    /** Events folded here — on top of the snapshot, or all of them. */
    folded: number;
    /** Byte length of the log the state covers; null when it is not known. */
    logBytes: number | null;
    truncated: boolean;
  }> => {
    const foldOnto = (state: ThreadFoldState, events: readonly DomainEvent[]) =>
      applyEventsChunked(state, events, { apply: fold.apply });

    const snapshot = await loadUsableSnapshot(threadId);
    if (snapshot !== null) {
      const tail = await store.readEventsFrom(threadId, {
        byteOffset: snapshot.logBytes,
        afterSeq: snapshot.seq
      });
      // A cut at the very line the snapshot points at, or a log that ends
      // exactly there but on another sequence, is a log that is not the one
      // the snapshot was taken of.
      const stale =
        tail.mismatch ||
        (tail.truncated && tail.events.length === 0) ||
        (tail.events.length === 0 && (await store.lastSeq(threadId)) !== snapshot.seq);
      if (!stale) {
        return {
          state: await foldOnto(snapshot.state, tail.events),
          derived: advanceLogDerived(snapshot.derived, tail.events),
          folded: tail.events.length,
          logBytes: tail.logBytes,
          truncated: tail.truncated
        };
      }
      logger.info("agent-host: the fold snapshot no longer matches the log; folding the log", {
        threadId,
        snapshotSeq: snapshot.seq
      });
    }

    const whole = await store.readEventsFrom(threadId, { byteOffset: 0, afterSeq: 0 });
    if (!whole.mismatch) {
      return {
        state: await foldOnto(fold.createEmpty(), whole.events),
        derived: advanceLogDerived(EMPTY_LOG_DERIVED, whole.events),
        folded: whole.events.length,
        logBytes: whole.logBytes,
        truncated: whole.truncated
      };
    }
    // A log that does not open on seq 1 cannot be read by position at all; it
    // is folded exactly as it always was, and never snapshotted.
    const tail = await store.readAll(threadId);
    return {
      state: await foldOnto(fold.createEmpty(), tail.events),
      derived: advanceLogDerived(EMPTY_LOG_DERIVED, tail.events),
      folded: tail.events.length,
      logBytes: null,
      truncated: tail.truncated
    };
  };

  /**
   * `state.json`, validated beyond what the store checks: the state must
   * deserialize field-wise, be this thread's, sit at the file's own `seq`, and
   * carry the orchestrator's `extras`. Anything else is a cache miss, never an
   * error — the log is folded instead.
   */
  const loadUsableSnapshot = async (
    threadId: string
  ): Promise<{ state: ThreadFoldState; seq: number; logBytes: number; derived: LogDerived } | null> => {
    let file: Awaited<ReturnType<ThreadStore["loadFoldSnapshot"]>>;
    try {
      file = await store.loadFoldSnapshot(threadId);
    } catch (error) {
      logger.warn(`agent-host: failed to read the fold snapshot of ${threadId}`, error);
      return null;
    }
    if (file === null) {
      return null;
    }
    const state = deserializeFoldState(file.state);
    const derived = parseLogDerived(file.extras);
    if (
      state === null ||
      derived === null ||
      state.seq !== file.seq ||
      state.head?.id !== threadId ||
      !Number.isSafeInteger(file.logBytes) ||
      file.logBytes < 0
    ) {
      logger.info("agent-host: discarding an unusable fold snapshot", { threadId });
      return null;
    }
    return { state, seq: file.seq, logBytes: file.logBytes, derived };
  };

  /**
   * Write `state.json` for the runtime as it stands, off the command path:
   * fire-and-forget on the store's own per-thread queue, a failure logged and
   * nothing else. `logBytes` must be the log's length right after the last
   * event `runtime.state` holds — the caller's append result, or the read it
   * folded.
   */
  const writeFoldSnapshot = (runtime: ThreadRuntime, logBytes: number): void => {
    runtime.eventsSinceSnapshot = 0;
    // A deleted thread's directory is about to go, and a headless state is no
    // thread at all.
    if (runtime.deleted || runtime.state.head === null) {
      return;
    }
    runtime.lastSnapshotAt = clock.now().getTime();
    const failed = (error: unknown): void => {
      logger.warn(`agent-host: failed to write the fold snapshot for ${runtime.id}`, error);
    };
    try {
      void store
        .saveFoldSnapshot({
          threadId: runtime.id,
          seq: runtime.state.seq,
          logBytes,
          state: runtime.state,
          extras: {
            revertedTo: runtime.logDerived.revertedTo,
            titleManual: runtime.logDerived.titleManual
          }
        })
        .catch(failed);
    } catch (error) {
      failed(error);
    }
  };

  const buildRuntime = async (threadId: string): Promise<ThreadRuntime> => {
    const loaded = await foldFromDisk(threadId);
    const state = loaded.state;
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
      resumeGoalAfterRestart: persistedHead?.resumeGoalAfterRestart === true ? true : undefined,
      sessionStartedAt: null,
      binding,
      eventsSinceHeadSave: 0,
      eventsSinceSnapshot: loaded.folded,
      // Nothing written yet by this runtime: the first write is never delayed.
      lastSnapshotAt: 0,
      logDerived: loaded.derived,
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
      // Both as the log leaves them (§5.1, §5.5): a restart re-derives them.
      revertedTo: loaded.derived.revertedTo,
      titleManual: loaded.derived.titleManual,
      checkpointsUnavailable: false,
      deleted: state.deleted
    };
    // A long fold is paid once: the next load of this thread starts from here,
    // even if it is never written to again — an idle open tab would otherwise
    // be folded from the top on every host restart (the upgrade to snapshots
    // starts with none at all). Never for a log cut at a malformed line.
    if (
      loaded.logBytes !== null &&
      !loaded.truncated &&
      loaded.folded >= FOLD_SNAPSHOT_EVENT_INTERVAL
    ) {
      writeFoldSnapshot(runtime, loaded.logBytes);
    }
    return runtime;
  };

  const headOf = (runtime: ThreadRuntime): ThreadHead | null => {
    const head = runtime.state.head;
    return head ? withHeadOnlyState(runtime, head) : null;
  };

  /** The two head-only markers, merged onto a projected head (§3.3, goals §5.5). */
  const withHeadOnlyState = (runtime: ThreadRuntime, head: ThreadHead): ThreadHead =>
    runtime.continueAfterRestart === undefined && runtime.resumeGoalAfterRestart === undefined
      ? head
      : {
          ...head,
          ...(runtime.continueAfterRestart !== undefined
            ? { continueAfterRestart: runtime.continueAfterRestart }
            : {}),
          ...(runtime.resumeGoalAfterRestart === true ? { resumeGoalAfterRestart: true } : {})
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
    runtime.logDerived = advanceLogDerived(runtime.logDerived, result.events);
    runtime.eventsSinceHeadSave += result.events.length;
    runtime.eventsSinceSnapshot += result.events.length;
    observeIndex(runtime, result);
    publish(runtime, result.events);
    // Rewritten every 50 events and on every head-shaped change (§5.1). A
    // session transition always writes: the §3.3 reconcile reads `meta.json`
    // alone, so a head that lagged behind the log would make a live turn look
    // settled on the next boot.
    const headChanged = result.events.some((event) => HEAD_WRITING_EVENTS.has(event.type));
    // A2: `state.json` on every session transition — the same head-shaped
    // changes, a turn settling above all — so a restart right after a long
    // turn folds almost nothing; inside a long turn only once both 200 events
    // and 30 s have passed, because serializing a big state stalls the loop.
    // Never awaited: the store writes it on the thread's own queue.
    const snapshotDue =
      headChanged ||
      (runtime.eventsSinceSnapshot >= FOLD_SNAPSHOT_EVENT_INTERVAL &&
        clock.now().getTime() - runtime.lastSnapshotAt >= FOLD_SNAPSHOT_MIN_INTERVAL_MS);
    if (result.events.length > 0 && snapshotDue) {
      writeFoldSnapshot(runtime, result.logBytes);
    }
    if (runtime.eventsSinceHeadSave >= HEAD_SAVE_EVENT_INTERVAL || headChanged) {
      await saveHeadNow(runtime);
    }
    return result;
  };

  /**
   * C: hand the index what just landed, with the byte positions the store
   * wrote it at. Strictly after the append returned — the index is a cache of
   * the log and may lag it after a crash, never lead it (invariant 4) — and
   * never allowed to fail the command whose events are already on disk.
   */
  const observeIndex = (runtime: ThreadRuntime, result: AppendResult): void => {
    const index = options.index;
    const head = runtime.state.head;
    if (index === undefined || head === null || result.events.length === 0) {
      return;
    }
    try {
      index.observe({
        threadId: runtime.id,
        projectPath: head.projectPath,
        title: head.title,
        events: result.events,
        positions: result.positions
      });
    } catch (error) {
      logger.warn(`agent-host: the thread index could not take ${runtime.id}'s events`, error);
    }
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

  /**
   * Goals §5.5: the thread's goal is CONTINUING — `active` in the fold, on an
   * adapter whose provider starts its next turn by itself
   * (`goals.continuesAcrossTurns`, Codex) — so the gaps between its turns are
   * not idle. Whether a provider process is there to start that turn is each
   * caller's own question ({@link sessionIsLive}).
   */
  const goalContinues = (runtime: ThreadRuntime, adapter: AgentAdapter | undefined): boolean =>
    runtime.state.goal?.status === "active" &&
    adapter?.capabilities.goals?.continuesAcrossTurns === true;

  /**
   * A provider session this host serves for the thread — the child is there
   * and the head does not say `stopped` or `error`, whatever the provider
   * still holds.
   */
  const sessionIsLive = (
    runtime: ThreadRuntime,
    head: ThreadHead,
    adapter: AgentAdapter | undefined
  ): boolean =>
    adapter !== undefined &&
    adapter.hasSession(runtime.id) &&
    head.session.status !== "stopped" &&
    head.session.status !== "error";

  /**
   * Goals §4.7, §5.5: the goal is CONTINUING right now — the summary's
   * `continuing`, and the one expression the account-switch gate and the
   * `/compact` advice read too, so none of them can disagree with what the
   * tab shows. The goal continues ({@link goalContinues}), and either
   * - a restart's resume is still owed (the mark), whatever the session says; or
   * - a provider session is live, AND a turn is running or the provider is
   *   still inside {@link GOAL_CONTINUATION_GRACE_MS} of an idle point it
   *   continues from — its last turn settling, or its session (re)starting.
   *
   * The grace is what keeps a continuation that never starts from reading as
   * "working" forever. Read against the clock on every call: the summary poll
   * sees it end with no event.
   */
  const goalContinuingNow = (
    runtime: ThreadRuntime,
    head: ThreadHead,
    adapter: AgentAdapter | undefined
  ): boolean => {
    if (!goalContinues(runtime, adapter)) return false;
    if (runtime.resumeGoalAfterRestart === true) return true;
    if (!sessionIsLive(runtime, head, adapter)) return false;
    if (turnIsActive(runtime)) return true;
    const idleSince = lastContinuationPoint(runtime);
    return idleSince !== null && clock.now().getTime() - idleSince < GOAL_CONTINUATION_GRACE_MS;
  };

  /** The latest idle point a provider continues a goal from, or null (epoch ms). */
  const lastContinuationPoint = (runtime: ThreadRuntime): number | null => {
    const turns = runtime.state.turns ?? [];
    const settledAt = Date.parse(turns[turns.length - 1]?.completedAt ?? "");
    const points = [settledAt, runtime.sessionStartedAt ?? Number.NaN].filter((point) =>
      Number.isFinite(point)
    );
    return points.length === 0 ? null : Math.max(...points);
  };

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
      return startSession(runtime, head, desired, cursor, pendingTurnStart, {
        // goals §5.3: the goal may live in the OLD account's home (Codex's
        // `goals_1.sqlite`), which the new session cannot see.
        carryGoal: decision.reasons.includes("account")
      });
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
      pendingTurnStart,
      { carryGoal: accountMovedSinceLastSession(runtime, desired) }
    );
  };

  /**
   * goals §5.3, for a start with no live session to compare against: the
   * account switch of §3.4 is applied on the next message, and the session it
   * restarts may already be gone by then — stopped, crashed, or a host
   * restarted in between. The binding still names the identity the last
   * session ran under (`providerInstanceId`, written by every start), so a
   * start under another identity is exactly an account switch. A binding that
   * never recorded one says nothing.
   */
  const accountMovedSinceLastSession = (
    runtime: ThreadRuntime,
    desired: DesiredSessionShape
  ): boolean => {
    const previous = runtime.binding?.providerInstanceId ?? null;
    return previous !== null && previous !== desired.accountKey;
  };

  /**
   * goals §5.3: the goal the fold holds, as an adapter compares it — without
   * the row stamp, which is the host's and not the provider's. `null` when the
   * thread has none, so an adapter can tell "no goal" from "not told".
   */
  const knownGoalOf = (runtime: ThreadRuntime): AgentGoal | null => {
    const goal = runtime.state.goal ?? null;
    if (goal === null) return null;
    const { updatedAt: _updatedAt, ...known } = goal;
    void _updatedAt;
    return known;
  };

  const startSession = async (
    runtime: ThreadRuntime,
    head: ThreadHead,
    desired: DesiredSessionShape,
    resumeCursor: unknown,
    pendingTurnStart: boolean,
    goal: { carryGoal: boolean } = { carryGoal: false }
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
      ...(resumeCursor !== undefined ? { resumeCursor } : {}),
      // goals §5.3: on EVERY start, so an adapter emits only real changes — a
      // resumed provider repeating the goal the thread already shows is not one.
      knownGoal: knownGoalOf(runtime),
      ...(goal.carryGoal ? { carryGoal: true } : {})
    });
    runtime.bound = { ...desired, session };
    runtime.sessionStartedAt = clock.now().getTime();
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
    // Goals §5.5: a session the user stopped is not a goal to resume — the
    // Stop wins over a handover's mark the boot has not acted on yet.
    if (runtime.resumeGoalAfterRestart === true) {
      runtime.resumeGoalAfterRestart = undefined;
      await saveHeadNow(runtime);
    }
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
      // goals §5.2, for every adapter: an active goal can be silent far past a
      // turn's idle window (Grok's verifiers), so the window is the goal's.
      isGoalActive: () => runtime.state.goal?.status === "active",
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
    // Every path that sends — a direct turn, a steer, a turn queued behind a
    // compaction, a message-mode answer — lands here, so this is where each
    // attachment is resolved and held to §6.3's bounds against the file the
    // host STAT'd. A refusal is a timeline row, and nothing is captured,
    // started or sent for it.
    let attachments: AttachmentRef[];
    try {
      attachments = await resolveTurnAttachments(runtime.id, turn.attachments);
    } catch (error) {
      await appendActivity(runtime, {
        kind: "provider.turn.start.failed",
        summary: "Attachment rejected",
        detail: describeFailure(error),
        requestId: turn.messageId
      });
      return;
    }
    // The pre-turn baseline, BEFORE the session is ensured and before the
    // provider is asked (§5.4; T3 captures it from the domain turn-start for
    // the same reason). Waiting on `turn.started` would fold everything the
    // agent writes in the meantime — and anything a provider writes on session
    // start — into the baseline, and the turn's numstat would under-report it.
    await captureBaseline(runtime, { turnCount: dispatchBaselineTurnCount(runtime) });
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
        input: providerInputFor(turn.input),
        // Each carries the STAT'd size; the adapter names in an
        // `Attached files:` block whatever it does not ingest natively (§4.1).
        attachments,
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

  /**
   * goals §5.1: run a host-parsed `/goal …` against the provider. The session
   * is ensured first, exactly as a turn ensures it — after a host restart or a
   * crash the thread has no live provider until something starts one.
   *
   * The result is at most one row: the adapter's non-empty summary as a
   * visible `goal.status`, or the failure as a `goal.command.failed`. Never an
   * HTTP error and never the session's error state: the command was already
   * recorded, and a refused goal command leaves the conversation usable. The
   * goal ITSELF moves only through the adapter's `thread.goal.updated` events.
   */
  const goalCommandEffect = async (
    runtime: ThreadRuntime,
    command: HostGoalCommand,
    goalOptions: GoalCommandOptions
  ): Promise<void> => {
    const head = headOf(runtime);
    if (!head) return;
    try {
      const adapter = adapterFor(head.adapter);
      if (!adapter.goalCommand) {
        throw new Error(`${head.adapter} cannot run goal commands.`);
      }
      await ensureSession(runtime);
      const result = await adapter.goalCommand(runtime.id, command, goalOptions);
      if (typeof result.summary === "string" && result.summary.length > 0) {
        await appendActivity(runtime, {
          kind: GOAL_STATUS_ACTIVITY_KIND,
          tone: "info",
          summary: result.summary
        });
      }
    } catch (error) {
      await appendActivity(runtime, {
        kind: GOAL_COMMAND_FAILED_ACTIVITY_KIND,
        tone: "error",
        summary: "Goal command failed",
        detail: describeFailure(error)
      });
    }
  };

  /**
   * Goals §5.5, §6.2.4: a Stop on a thread whose goal continues pauses the goal
   * FIRST — before any open card is cancelled. On Codex a `cancel` ends the
   * turn by itself, and a goal still active starts the next turn at once,
   * before the adapter's own pause-then-interrupt inside `interruptTurn` gets
   * to run. The adapter skips its own pause only once this pause's
   * notification has reached it; when the notification trails the reply, the
   * adapter pauses a second time — harmless, the goal is already paused.
   *
   * A courtesy in front of the interrupt, never a gate on it: bounded by
   * {@link AGENT_HOST_DEADLINES.goalPauseMs}, and a failure or a timeout is
   * logged and the Stop goes on. No row either way — the user asked to stop,
   * and the goal's own update tells the timeline it is paused.
   */
  const pauseContinuingGoal = async (
    runtime: ThreadRuntime,
    adapter: AgentAdapter
  ): Promise<void> => {
    if (!goalPauseApplies(runtime, adapter)) {
      return;
    }
    try {
      await withDeadline(() => adapter.goalCommand!(runtime.id, { kind: "pause" }), {
        timeoutMs: AGENT_HOST_DEADLINES.goalPauseMs,
        label: `goal-pause:${adapter.id}`
      });
    } catch (error) {
      logger.warn(`agent-host: could not pause ${runtime.id}'s goal before a Stop`, {
        threadId: runtime.id,
        error: describeFailure(error)
      });
    }
  };

  /** A continuing goal the provider can be asked to pause (goals §5.5). */
  const goalPauseApplies = (runtime: ThreadRuntime, adapter: AgentAdapter): boolean =>
    adapter.goalCommand !== undefined && goalContinues(runtime, adapter);

  /**
   * A turn the fold recorded through its provider-initiated path — no user
   * message started it: a goal's continuation, a turn after a resume. A turn
   * row that cannot be found is treated as the user's, and protected.
   */
  const isProviderInitiatedTurn = (runtime: ThreadRuntime, turnId: string): boolean => {
    const turn = (runtime.state.turns ?? []).find((entry) => entry.turnId === turnId);
    return turn !== undefined && turn.userMessageId === undefined;
  };

  /** Cards first, then the provider (§4.1); a refusal is a row, never an HTTP error. */
  const interruptTurnNow = async (
    runtime: ThreadRuntime,
    adapter: AgentAdapter,
    turnId: string | undefined
  ): Promise<void> => {
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

  /**
   * Goals §5.5: a Stop on a thread whose goal CONTINUES. The goal is paused
   * first, then the turn to stop is read AGAIN — the provider may have ended
   * the Stop's turn and started its next goal turn before the Stop, or while
   * the pause was being asked:
   * - no turn named, or the named turn still running → it is interrupted, as
   *   any Stop interrupts;
   * - the named turn is over → the staleness guard's case: the turn running
   *   now is interrupted when the provider started it by itself (no user
   *   message behind it), and left alone when the user started it — the
   *   guard's protection of the user's own next turn holds. With nothing
   *   running, the pause was the whole Stop.
   * Either way in the normal order: pause, then cards, then the interrupt.
   */
  const stopContinuingGoal = async (
    runtime: ThreadRuntime,
    adapter: AgentAdapter,
    turnId: string | undefined
  ): Promise<void> => {
    await pauseContinuingGoal(runtime, adapter);
    const activeTurnId = currentSession(runtime).activeTurnId;
    if (turnId === undefined || activeTurnId === turnId) {
      await interruptTurnNow(runtime, adapter, turnId);
      return;
    }
    if (activeTurnId !== null && isProviderInitiatedTurn(runtime, activeTurnId)) {
      await interruptTurnNow(runtime, adapter, activeTurnId);
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
    const live =
      adapter !== undefined && adapter.hasSession(runtime.id) && session.status !== "stopped";
    if (live && goalPauseApplies(runtime, adapter)) {
      await stopContinuingGoal(runtime, adapter, turnId);
      return;
    }
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
    if (!live) {
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
    await interruptTurnNow(runtime, adapter, turnId);
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
   * each question's attachments follow as `Attached file: <name> (<path>)`
   * lines — T3 `decider.ts:1642-1660`. The echo is not decoration: the provider
   * parked no request, so the agent receives this as an ordinary user turn and
   * has nothing but the text to tell it which question was answered. The old
   * shape dropped the question whenever there was exactly one, which reads as
   * a bare "yes" arriving from nowhere in a transcript the agent resumes
   * later. A multi-select answer is joined with commas.
   *
   * The line names the absolute host path (`pathById`), where T3's printed the
   * id, which means nothing to an agent: the steer carries the same refs, and
   * the adapters' `Attached files:` block (§4.5) then finds every path already
   * named and appends nothing — so the echo says both which question a file
   * belongs to and where it is. An image gets the same line: Claude, Codex and
   * OpenCode ingest it natively as well; Grok ingests nothing and reads the
   * path. `decide` refuses an answer whose file no longer resolves before this
   * runs, so every line names a real path.
   */
  const answerMessageText = (
    questions: readonly { id: string; question: string }[],
    answers: Record<string, unknown>,
    attachmentsByQuestionId?: Record<string, AttachmentRef[]>,
    pathById: Record<string, string> = {}
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
        lines.push(attachedFileLine(attachment.name, pathById[attachment.id]));
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
    // §6.2: attachments are folded into the answer by the host, so the adapter
    // interface stays free of a second attachment channel — as the
    // `Attached file: <name> (<absolute path>)` lines a message-mode echo
    // prints, after the answer. `decide` refused any file that did not
    // resolve; "(not available)" covers one that vanished since, rather than
    // a bare name the agent cannot tell from prose.
    const folded: Record<string, unknown> = { ...answers };
    for (const [questionId, attachments] of Object.entries(attachmentsByQuestionId ?? {})) {
      if (attachments.length === 0) continue;
      const lines: string[] = [];
      for (const attachment of attachments) {
        let path: string | undefined;
        try {
          path = await store.resolveAttachment(runtime.id, attachment.id);
        } catch {
          path = undefined;
        }
        lines.push(attachedFileLine(attachment.name, path));
      }
      // A multi-select answer stays an array, its lines one more entry after
      // the selections: every adapter matches each selection to its option
      // (Grok reads anything unmatched as a free-text note), so joining them
      // into one string would lose them as selections. A single answer is text.
      const answer = folded[questionId];
      const block = lines.join("\n");
      folded[questionId] = Array.isArray(answer)
        ? [...answer.filter((item): item is string => typeof item === "string"), block]
        : typeof answer === "string" && answer.length > 0
          ? `${answer}\n\n${block}`
          : block;
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
   *
   * Resolves every ref of a turn, in order, against the thread's attachments
   * dir and stamps the STAT'd size on it: that size is what the adapter judges
   * native ingestion on (OpenCode's 20 MiB file-part cap). Throws
   * `INVALID_COMMAND` for the first attachment that is gone or over its bound.
   */
  const resolveTurnAttachments = async (
    threadId: string,
    refs: readonly AttachmentRef[]
  ): Promise<AttachmentRef[]> => {
    const resolved: AttachmentRef[] = [];
    for (const ref of refs) {
      let path: string;
      try {
        path = await store.resolveAttachment(threadId, ref.id);
      } catch {
        throw invalidCommand(`Attachment '${ref.name}' is not available.`);
      }
      let sizeBytes: number;
      try {
        sizeBytes = (await stat(path)).size;
      } catch {
        throw invalidCommand(`Attachment '${ref.name}' is not available.`);
      }
      const limit = ref.type === "image" ? MAX_TURN_IMAGE_BYTES : MAX_TURN_FILE_BYTES;
      if (sizeBytes > limit) {
        throw invalidCommand(
          `Attachment '${ref.name}' is ${sizeBytes} bytes, over the ${limit}-byte limit.`
        );
      }
      resolved.push({ ...ref, sizeBytes });
    }
    return resolved;
  };

  /**
   * The highest checkpoint count the fold holds. NOT the thread's turn count:
   * turns count by ORDER (§5.5, `startedTurns`), and the checkpoint list is
   * sparse wherever git was absent, a capture failed or history was resumed.
   * Only the diff route's range check and the placeholder's no-ordinal
   * fallback still read it.
   */
  const maxCheckpointTurnCount = (runtime: ThreadRuntime): number =>
    (runtime.state.checkpoints ?? []).reduce(
      (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
      0
    );

  /**
   * §5.5, cut by turn ORDER. `targetTurnCount` is the number of started turns
   * kept; the rest are named to the adapter by id (`RollbackTarget`), and
   * their checkpoints are pruned by their own counts as well as by `> target`
   * — a thread checkpointed before the counts followed the turns can hold a
   * dropped turn's ref far below the target.
   */
  const revertEffect = async (runtime: ThreadRuntime, targetTurnCount: number): Promise<void> => {
    const head = headOf(runtime);
    if (!head) return;
    try {
      // §5.5 step 2, before anything on disk, in the ref store or in the
      // provider is touched.
      checkpoints.assertRollbackSupported(head.adapter);
      const started = startedTurns(runtime.state.turns ?? []);
      const dropped = started.slice(targetTurnCount);
      const retained = started.slice(0, targetTurnCount);
      const droppedTurnIds = dropped.map((turn) => turn.turnId);
      if (dropped.length > 0) {
        await adapterFor(head.adapter).rollbackThread(runtime.id, dropped.length, {
          firstRemovedTurnId: dropped[0]!.turnId,
          droppedTurnIds,
          retainedTurnIds: retained.map((turn) => turn.turnId)
        });
      }
      const droppedIds = new Set(droppedTurnIds);
      const droppedTurnCounts = [
        ...new Set(
          (runtime.state.checkpoints ?? [])
            .filter(
              (checkpoint) => checkpoint.turnId !== null && droppedIds.has(checkpoint.turnId)
            )
            .map((checkpoint) => checkpoint.checkpointTurnCount)
        )
      ];
      await checkpoints.pruneAbove({
        threadId: runtime.id,
        cwd: head.cwd,
        targetTurnCount,
        droppedTurnCounts
      });
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
    // A compaction in flight, or turns queued behind one, is named first — it
    // ends by itself, and a goal command waits for it too (the account-switch
    // gate names it first for the same reason).
    if (runtime.compacting || runtime.queuedTurns.length > 0) {
      throw compactionUnavailable(
        "Context compaction is unavailable while a provider turn is running."
      );
    }
    if (session.status === "starting" || session.status === "running" || turnIsActive(runtime)) {
      // Goals §5.5: under a continuing goal, waiting for the turn to finish is
      // useless advice — the provider starts the next one by itself.
      const head = headOf(runtime);
      throw compactionUnavailable(
        head !== null && goalContinuingNow(runtime, head, options.adapters.get(head.adapter))
          ? "Pause the goal before compacting."
          : "Context compaction is unavailable while a provider turn is running."
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

  /**
   * goals §5.1: a `/goal …` the host parsed is a goal command, not a turn.
   *
   * The user's text is committed as their message — on the running turn when
   * there is one, exactly like a steer's — and **no
   * `thread.turn-start-requested`**: the host starts no turn, so no pending
   * row opens for one. Any turn Codex then starts by itself (a goal set active
   * continues at once) arrives as a provider-initiated turn and is recorded by
   * the fold's adoption path like any other.
   *
   * Refused, before anything is committed, while a compaction runs or turns
   * are queued behind one — the same moment `decideCompaction` refuses at: the
   * effect queue would otherwise run the command after messages the user sent
   * later, or after a compaction that failed and dropped them.
   */
  const decideGoalCommand = (
    runtime: ThreadRuntime,
    head: ThreadHead,
    commandId: string,
    request: {
      input: string;
      command: HostGoalCommand;
      context: ComposerContextRecord[] | undefined;
      modelSelection: ModelSelection | undefined;
    }
  ): Decision => {
    if (runtime.compacting || runtime.queuedTurns.length > 0) {
      throw invalidCommand("Wait for the compaction to finish before changing the goal.");
    }
    const { input, command, context, modelSelection } = request;
    const occurredAt = clock.nowIso();
    const events: AppendableDomainEvent[] = [];
    // A model picked together with the command is recorded exactly as a turn
    // records it, so the next turn Orquester starts runs on it — AND handed to
    // the goal command: the provider starts a goal's turns by itself (Codex),
    // on the thread's own settings, and the adapter applies the new model
    // before the goal request so those turns run on it too.
    const changedModel =
      modelSelection !== undefined && !modelSelectionEquals(modelSelection, head.modelSelection)
        ? modelSelection
        : undefined;
    if (changedModel !== undefined) {
      events.push(
        buildEvent(
          runtime.id,
          "thread.meta-updated",
          { modelSelection: changedModel },
          { commandId, occurredAt }
        )
      );
    }
    events.push(
      buildEvent(
        runtime.id,
        "thread.message-sent",
        {
          messageId: ids.messageId("user:"),
          role: "user",
          // As typed: the command is the provider's business, the bubble the user's.
          text: input,
          streaming: false,
          turnId: currentSession(runtime).activeTurnId,
          ...(context !== undefined ? { context } : {})
        },
        { commandId, occurredAt }
      )
    );
    return {
      events,
      schedule: () => {
        void runEffect(runtime, () =>
          goalCommandEffect(
            runtime,
            command,
            changedModel !== undefined ? { modelSelection: changedModel } : {}
          )
        );
      }
    };
  };

  /**
   * Async for one branch only: a message-mode `answer` resolves its attachment
   * paths before its events are built, because the text naming them commits
   * together with the resolved activity (§6.2). Safe because `command` calls
   * this inside the thread's command queue — the queue every `commit` and
   * `append` takes — so nothing can move `runtime.state` across the await.
   * That guarantee stops at the command queue: the fields the effect queue
   * writes (`bound`, `compacting`, `queuedTurns`, …) are not covered, so read
   * them before the await or in `schedule`.
   */
  const decide = async (
    runtime: ThreadRuntime,
    name: AgentChatCommandName,
    raw: unknown,
    commandId: string
  ): Promise<Decision> => {
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
        // goals §5.1: where goals are the HOST's to parse (Codex), `/goal …` is
        // a goal command and never reaches the model as text (T3 #13252). A
        // malformed one is refused here, before anything is committed (R2-7).
        if (options.adapters.get(head.adapter)?.capabilities.goals?.command === "host") {
          const goalCommand = parseHostGoalCommand(input, attachments);
          if (goalCommand !== null) {
            if ("error" in goalCommand) {
              throw invalidCommand(goalCommand.error);
            }
            return decideGoalCommand(runtime, head, commandId, {
              input,
              command: goalCommand,
              context,
              modelSelection
            });
          }
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
        // the host STAT'd: `sendTurnEffect` re-checks it on EVERY path that
        // sends, including a turn queued behind a compaction and a message-mode
        // answer, which a check here would miss.
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
        // Every attachment must still resolve. An answer naming a file the host
        // no longer has is refused HERE, before anything is committed, so the
        // card stays open instead of closing on an answer that can never reach
        // the agent intact (§6.3). The paths name each file in a message-mode
        // echo.
        const pathById: Record<string, string> = {};
        for (const attachment of Object.values(attachmentsByQuestionId ?? {}).flat()) {
          try {
            pathById[attachment.id] = await store.resolveAttachment(runtime.id, attachment.id);
          } catch {
            throw invalidCommand(`Attachment '${attachment.name}' is not available.`);
          }
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
          const text = answerMessageText(
            question.questions,
            answers,
            attachmentsByQuestionId,
            pathById
          );
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
        // Turns count by ORDER (§5.5) — never by the checkpoint list, which a
        // non-git project, a failed capture or a resumed history leaves sparse.
        const current = startedTurns(runtime.state.turns ?? []).length;
        if (targetTurnCount > current) {
          throw commandRejected(
            `Cannot rewind to turn ${targetTurnCount}: this thread has ` +
              `${current} turn${current === 1 ? "" : "s"}.`
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
          decision = await decide(runtime, name, body, commandId);
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

  /**
   * §3.4's "account changed", for a thread that already exists.
   *
   * **`launch.json` is rewritten before the head is.** `main.ts`'s `buildEnv`
   * and `resolveHome` both prefer the launch config over the head's account —
   * they have to, it is the daemon's resolved answer — so a head that moved
   * first would name the new account while every relaunch kept the old home's
   * credentials, silently billing the wrong identity. If the append then fails
   * the launch config is rolled back, because the reverse (a launch config
   * ahead of the head) is the same bug mirrored.
   *
   * Nothing is started here: the next `/turn` runs `ensureSession`, which sees
   * the changed `accountKey`, restarts with reason `"account"` and carries the
   * resume cursor. A thread with no live session simply starts under the new
   * identity — the same rule `/mode` follows.
   */
  const applyIdentity = async (
    runtime: ThreadRuntime,
    request: SetThreadIdentityRequest,
    commandId: string
  ): Promise<{ seq: number }> => {
    const head = requireHead(runtime);
    const accountId = typeof request.accountId === "string" ? request.accountId : undefined;
    if (accountId === undefined) {
      throw invalidCommand("accountId is required.");
    }
    const home = request.home;
    if (home !== "system" && home !== "account" && home !== "cliproxy") {
      throw invalidCommand("home must be system, account or cliproxy.");
    }
    if (home === "account" && accountId.length === 0) {
      throw invalidCommand("An account home needs an account id.");
    }
    // One live session per thread, and OpenCode's is shared by every thread of
    // the project and runs under the server's own identity (§3.2) — there is
    // no per-thread account to move.
    if (head.adapter === "opencode") {
      throw invalidCommand("OpenCode threads always run under the server's own identity.");
    }
    // A thread's home KIND is a function of its registry entry, which never
    // changes; crossing this boundary would also cross the resume cursor's
    // home, and a cliproxy home does not share `projects/` with the rest.
    if ((head.home === "cliproxy") !== (home === "cliproxy")) {
      throw invalidCommand(
        "This agent's launcher cannot move between the model proxy and a direct account."
      );
    }

    if (accountId === head.accountId && home === head.home) {
      // Unchanged: still a receipt and still a `{seq}`, so a retry of the same
      // `commandId` is free — but no event, no activity and no restart.
      const unchanged = await commit(runtime, [], { commandId, status: "accepted" });
      return { seq: unchanged.seq };
    }

    const session = currentSession(runtime);
    const pending = runtime.state.pending ?? { approvals: [], userInputs: [] };
    const refusal = identitySwitchRefusal({
      status: session.status,
      activeTurnId: session.activeTurnId,
      hasUnsettledTurn: turnIsActive(runtime),
      pendingRequestCount: pending.approvals.length + pending.userInputs.length,
      queuedTurnCount: runtime.queuedTurns.length,
      compacting: runtime.compacting,
      backgroundLive: liveness.liveness(runtime.id) !== null,
      // Goals §5.5, in the summary's sense: only a goal continuing NOW blocks
      // the switch. A stopped or errored session may switch — pausing a
      // stopped Codex session would itself resume it and start a goal turn —
      // and `carryGoal` re-creates the goal on the new account; except one
      // whose resume mark is still pending (after a handover it may read
      // `stopped` or `error`), which reads as continuing and is refused.
      goalContinuing: goalContinuingNow(runtime, head, options.adapters.get(head.adapter))
    });
    if (refusal !== null) {
      throw commandRejected(refusal);
    }

    const previousLaunch = runtime.launch;
    const launch = launchConfigFromRequest(request);
    try {
      await launchConfigs.save(runtime.id, launch);
    } catch (error) {
      // Refused, not warned: an unwritten launch config means the next child
      // launches under the OLD credentials while the user is told otherwise.
      throw commandRejected(
        `Could not record the new account for this thread: ${describeFailure(error)}`
      );
    }
    runtime.launch = launch;

    const occurredAt = clock.nowIso();
    const previousAccountId = head.accountId;
    try {
      const result = await commit(
        runtime,
        [
          buildEvent(
            runtime.id,
            "thread.meta-updated",
            { accountId, home },
            { commandId, occurredAt }
          ),
          buildEvent(
            runtime.id,
            "thread.activity-appended",
            {
              activity: makeActivity({
                id: ids.eventId(),
                tone: "info",
                activityKind: IDENTITY_CHANGED_ACTIVITY_KIND,
                summary: "Switched account",
                payload: {
                  accountId,
                  home,
                  ...(previousAccountId.length > 0 ? { previousAccountId } : {})
                },
                turnId: null,
                createdAt: occurredAt
              })
            },
            { occurredAt }
          )
        ],
        { commandId, status: "accepted" }
      );
      await saveHeadNow(runtime);
      return { seq: result.seq };
    } catch (error) {
      runtime.launch = previousLaunch;
      if (previousLaunch !== null) {
        await launchConfigs.save(runtime.id, previousLaunch).catch((writeError: unknown) => {
          logger.warn(
            `agent-host: failed to roll the launch config back for ${runtime.id}`,
            writeError
          );
        });
      }
      throw error;
    }
  };

  const setIdentity = async (
    threadId: string,
    request: SetThreadIdentityRequest
  ): Promise<{ seq: number }> =>
    whenReady(async () => {
      const runtime = await loadRuntime(threadId);
      return runtime.commands.run(async () => {
        const body = requireBody(request);
        const commandId = requireCommandId(body);
        // Receipt first, exactly as `command` does: a receipt only ever proves
        // that one command was handled.
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
        try {
          return await applyIdentity(runtime, request, commandId);
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
      // The index's rows are a cache of a log that no longer exists (C). The
      // `thread.deleted` above already reached it through `commit`; this is
      // the idempotent backstop for a thread whose head could not be read.
      try {
        options.index?.deleteThread(threadId);
      } catch (error) {
        logger.warn(`agent-host: the thread index could not drop ${threadId}`, error);
      }
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
    // §5.6: the full payload is persisted and slimmed on the way to the wire.
    // This is the snapshot half of the choke point (`stream.ts` is the live
    // half); `GET …/items/:itemId` stays unslimmed and is what "load full
    // output" reads.
    const items = slimItemsForRead(payload.items);
    const head = withHeadOnlyState(runtime, payload.head);
    return { ...payload, head, items, history: historyBoundsOf(runtime) };
  };

  /**
   * C: where the retained window ends and the indexed history begins, stamped
   * on every snapshot — the activity the window begins at (`windowBoundary`),
   * and whether the index holds any activity older than it.
   */
  const historyBoundsOf = (runtime: ThreadRuntime): ThreadHistoryBounds => {
    const index = options.index;
    if (index === undefined || !index.available) {
      return {
        indexed: false,
        hasOlder: false,
        beforeCursor: null,
        oldestRetainedOrdinal: null,
        totalTurns: 0
      };
    }
    try {
      const totalTurns = index.totalTurns(runtime.id);
      const boundary = windowBoundary(runtime.state, index, runtime.id);
      const anchor = boundary === null ? null : anchorTurnOf(index, runtime.id, boundary.seq);
      if (boundary === null || anchor === null) {
        return {
          indexed: true,
          hasOlder: false,
          beforeCursor: null,
          oldestRetainedOrdinal: anchor?.ordinal ?? null,
          totalTurns
        };
      }
      const hasOlder = index.hasItemsBefore(runtime.id, boundary.seq);
      return {
        indexed: true,
        hasOlder,
        beforeCursor: hasOlder
          ? encodeHistoryCursor(blockCursor(runtime.id, anchor, boundary.seq))
          : null,
        oldestRetainedOrdinal: anchor.ordinal,
        totalTurns
      };
    } catch (error) {
      logger.warn(`agent-host: the thread index could not bound ${runtime.id}'s history`, error);
      return {
        indexed: false,
        hasOlder: false,
        beforeCursor: null,
        oldestRetainedOrdinal: null,
        totalTurns: 0
      };
    }
  };

  const indexUnavailable = (): AgentChatCommandError =>
    new AgentChatCommandError(
      "INDEX_UNAVAILABLE",
      "Older history is not available on this host right now."
    );

  /**
   * One block of history (design 2026-09-23, C, "History page"): the
   * `HISTORY_PAGE_ACTIVITIES` activities below the cursor — or below the
   * retained window, for a request without a usable one — with everything the
   * log holds between them, folded. Pages are blocks of the LOG, not of turns:
   * a subagent fleet's single turn runs to thousands of events, and is walked
   * in blocks like any other stretch. `turns` in the answer is information
   * about the block; a turn can span two blocks.
   */
  const readHistory = async (
    threadId: string,
    query: { before?: string; turns?: number }
  ): Promise<ThreadHistoryPage> =>
    whenReady(async () => {
      const runtime = await loadRuntime(threadId);
      requireHead(runtime);
      const index = options.index;
      if (index === undefined || !index.available) {
        throw indexUnavailable();
      }
      const seq = runtime.state.seq;
      const empty: ThreadHistoryPage = {
        threadId,
        turns: [],
        items: [],
        checkpoints: [],
        page: { beforeCursor: null },
        seq
      };
      let plan: HistoryBlock | null;
      try {
        plan = planHistoryBlock(runtime, index, query);
      } catch (error) {
        logger.warn(`agent-host: the thread index could not page ${threadId}`, error);
        throw indexUnavailable();
      }
      if (plan === null) {
        return empty;
      }
      const range = await store.readEventRange(threadId, {
        fromByte: plan.fromByte,
        toByte: plan.toByte
      });
      if (range.truncated) {
        // Positions the log no longer honours: an index behind a rewritten
        // log, or a line that does not decode. Nothing is served rather than
        // a block with a hole in it; the catch-up re-derives the positions.
        logger.warn("agent-host: a history block does not read back whole; serving none", {
          threadId,
          fromByte: plan.fromByte,
          toByte: plan.toByte
        });
        return empty;
      }
      const events = eventsOutsideRevertCuts(range.events, plan.turns, plan.firstTurnSeq);
      const state = await applyEventsChunked(fold.createEmpty(), events, { apply: fold.apply });
      return {
        threadId,
        turns: plan.turns.map((turn) => historyTurnOf(index, threadId, turn)),
        items: slimItemsForRead(state.items ?? []),
        checkpoints: state.checkpoints ?? [],
        page: {
          beforeCursor: plan.beforeCursor,
          endItemId: await rowAtSeq(threadId, index, plan.endSeq)
        },
        seq
      };
    });

  /**
   * The row whose line sits at `seq` — an activity's line or a message's
   * chunk — read off the log itself, because the index positions lines, not
   * rows. Null for any other line, and for a line the log no longer honours.
   */
  const rowAtSeq = async (
    threadId: string,
    index: ThreadIndex,
    seq: number
  ): Promise<string | null> => {
    const position = index.eventPositionBySeq(threadId, seq);
    if (position === null) return null;
    const line = await store.readEventRange(threadId, {
      fromByte: position.byteOffset,
      toByte: position.byteOffset + position.byteLength
    });
    const event = line.truncated ? undefined : line.events[0];
    if (event === undefined || event.seq !== seq) return null;
    if (event.type === "thread.activity-appended") return event.payload.activity.id;
    if (event.type === "thread.message-sent") return event.payload.messageId;
    return null;
  };

  /**
   * Where a block starts and ends, in seqs and in bytes, and the cursor of
   * the block below it. Every boundary is a line start the index recorded —
   * an activity's latest line, a message's first chunk, or the log's first
   * byte — and never falls inside a streamed message, so consecutive blocks
   * meet exactly: nothing is skipped, no message is split across two, and
   * only an activity rewritten under the same id can repeat. Null when there
   * is nothing below.
   */
  const planHistoryBlock = (
    runtime: ThreadRuntime,
    index: ThreadIndex,
    query: { before?: string; turns?: number }
  ): HistoryBlock | null => {
    const threadId = runtime.id;
    // The END — the request's cursor, else the snapshot's own (the window's
    // boundary). A malformed, foreign or no-longer-known cursor is a first-
    // page request.
    const cursor =
      query.before !== undefined && query.before.length > 0
        ? decodeHistoryCursor(query.before, threadId)
        : null;
    let end = cursor === null ? null : endOfCursor(index, threadId, cursor);
    if (end === null) {
      const boundary = windowBoundary(runtime.state, index, threadId);
      end = boundary === null ? null : { seq: boundary.seq, byteOffset: boundary.byteOffset };
    }
    if (end === null) {
      return null;
    }
    // An end inside a streamed message moves to where the message began: the
    // block above — or the window — holds it whole, so none of its chunks
    // belong here.
    const endSeq = outsideMessages(index, threadId, end.seq);
    if (endSeq !== end.seq) {
      const moved = index.eventPositionBySeq(threadId, endSeq);
      if (moved === null) {
        return null;
      }
      end = { seq: endSeq, byteOffset: moved.byteOffset };
    }

    // The START — HISTORY_PAGE_ACTIVITIES activities back...
    let startSeq = index.activitySeqBefore(threadId, {
      beforeSeq: end.seq,
      count: HISTORY_PAGE_ACTIVITIES
    });
    if (startSeq === null) {
      return null;
    }
    // ...but, as a soft cap, never before the start of the `turns`-th turn
    // back, and never past the newest activity below the end: every block
    // carries at least one activity, or paging could stall.
    if (query.turns !== undefined) {
      const cap = capTurnOf(index, threadId, end, clampHistoryTurns(query.turns));
      if (cap !== null && cap.firstSeq > startSeq) {
        const newest = index.activitySeqBefore(threadId, { beforeSeq: end.seq, count: 1 });
        startSeq = newest !== null && cap.firstSeq > newest ? newest : cap.firstSeq;
      }
    }
    // ...and never inside a streamed message: the block takes it whole.
    startSeq = outsideMessages(index, threadId, startSeq);

    // Bytes. The oldest block reaches back to the log's first byte, so the
    // first prompt and anything before the first activity are served too.
    const older = index.hasItemsBefore(threadId, startSeq);
    let fromByte = 0;
    if (older) {
      const position = index.eventPositionBySeq(threadId, startSeq);
      if (position === null) {
        return null;
      }
      fromByte = position.byteOffset;
    }
    if (end.byteOffset <= fromByte) {
      return null;
    }

    let beforeCursor: string | null = null;
    if (older) {
      const anchor = anchorTurnOf(index, threadId, startSeq);
      beforeCursor =
        anchor === null ? null : encodeHistoryCursor(blockCursor(threadId, anchor, startSeq));
    }
    return {
      fromByte,
      toByte: end.byteOffset,
      endSeq: end.seq,
      turns: index.turnsInSeqRange(threadId, { fromSeq: older ? startSeq : 0, toSeq: end.seq }),
      firstTurnSeq: index.turnByOrdinal(threadId, 1)?.firstSeq ?? null,
      beforeCursor
    };
  };

  const historyTurnOf = (
    index: ThreadIndex,
    threadId: string,
    turn: IndexedTurn
  ): ThreadHistoryTurn => {
    let rewindable = false;
    try {
      rewindable = index.rewindable(threadId, turn);
    } catch (error) {
      // Withheld, never offered: a rewind across a compaction is one the
      // provider cannot honour (§5.5).
      logger.warn(`agent-host: the thread index could not judge a rewind on ${threadId}`, error);
    }
    return {
      turnId: turn.turnId,
      ordinal: turn.ordinal,
      userMessageId: turn.userMessageId,
      requestedAt: turn.requestedAt,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      rewindable
    };
  };

  const searchThreads = (query: {
    q: string;
    limit: number;
    projectPath?: string;
  }): ThreadSearchResponse => {
    const text = query.q;
    const index = options.index;
    if (index === undefined || !index.available) {
      return { query: text, hits: [], truncated: false, indexed: false };
    }
    if (text.trim().length === 0) {
      return { query: text, hits: [], truncated: false, indexed: true };
    }
    const limit = Math.min(
      THREAD_SEARCH_MAX_RESULTS,
      Math.max(1, Number.isFinite(query.limit) ? Math.floor(query.limit) : THREAD_SEARCH_MAX_RESULTS)
    );
    try {
      const hits = index.search({
        q: text,
        limit,
        ...(query.projectPath !== undefined ? { projectPath: query.projectPath } : {})
      });
      return { query: text, hits, truncated: hits.length >= limit, indexed: true };
    } catch (error) {
      logger.warn("agent-host: a thread search failed", error);
      return { query: text, hits: [], truncated: false, indexed: false };
    }
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

  const readToolOutput = async (
    threadId: string,
    itemId: string
  ): Promise<ThreadItemOutputResponse | null> =>
    whenReady(async () => {
      const runtime = await loadRuntime(threadId);
      requireHead(runtime);
      // The LOG, as for `readItem`: a call's streamed chunks are the rows the
      // per-agent windows evict first, and the wire caps each one (§5.6).
      if (store.readToolOutput) {
        return store.readToolOutput(threadId, itemId);
      }
      return joinToolOutput((await store.readAll(threadId)).events, itemId);
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
      chatSessionStatus: head.session.status,
      goal: goalSummaryOf(runtime, head)
    };
  };

  /**
   * goals §4.7, §5.5: the thread's unfinished goal for every ambient surface,
   * or `null`. `continuing` ({@link goalContinuingNow}) says the provider will
   * start the next turn by itself, which is what keeps a settled turn, and the
   * gap across a deploy, from reading as "finished" between two of those
   * turns — for as long as that is still believable.
   */
  const goalSummaryOf = (runtime: ThreadRuntime, head: ThreadHead): AgentChatGoalSummary | null => {
    const goal = runtime.state.goal ?? null;
    if (goal === null || !isUnfinishedGoal(goal)) {
      return null;
    }
    return {
      objective: goal.objective,
      status: goal.status,
      continuing: goalContinuingNow(runtime, head, options.adapters.get(head.adapter))
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
    // The running turn's own ordinal (§5.5) — the count its completion
    // checkpoint will take. The checkpoint-derived rule survives only for a
    // turn the fold cannot place.
    return {
      turnCount: turnOrdinalOf(runtime, input.turnId) ?? maxCheckpointTurnCount(runtime) + 1
    };
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

  /** A turn's 1-based position among the thread's started turns (§5.5), or null. */
  const turnOrdinalOf = (runtime: ThreadRuntime, turnId: string | null): number | null =>
    turnId === null ? null : turnOrdinal(runtime.state.turns ?? [], turnId);

  /**
   * The dispatch-time baseline's count (§5.4, §5.5): the ordinal of the turn
   * about to start, minus one — i.e. how many turns have started so far.
   *
   * A steer is the exception. It joins the RUNNING turn rather than starting
   * one, so its baseline is that turn's own, already captured; counting the
   * running turn in would name its COMPLETION ref and capture it mid-turn.
   */
  const dispatchBaselineTurnCount = (runtime: ThreadRuntime): number => {
    const running = turnOrdinalOf(runtime, currentSession(runtime).activeTurnId);
    return running !== null ? running - 1 : startedTurns(runtime.state.turns ?? []).length;
  };

  /**
   * Awaitable on purpose (§5.4, R5 #6): the baseline must be "the tree as it
   * was before the turn", so the `/turn` dispatch path waits for it. The
   * `turn.started` call site stays fire-and-forget — by then it is only the
   * idempotent backstop, and `checkpoints.captureBaseline` answers `ready`
   * without touching the tree once the ref exists.
   *
   * `turnCount` is the baseline's own count — the ordinal of the turn it
   * precedes, minus one (§5.5); omitted, the service derives it from the
   * checkpoints as it always did.
   */
  const captureBaseline = (
    runtime: ThreadRuntime,
    input: { turnId?: string | null; turnCount?: number | null } = {}
  ): Promise<void> => {
    const head = headOf(runtime);
    if (!head) return Promise.resolve();
    const { turnId, turnCount } = input;
    return runtime.captures
      .run(async () => {
        const result = await checkpoints.captureBaseline({
          threadId: runtime.id,
          cwd: head.cwd,
          checkpoints: runtime.state.checkpoints ?? [],
          ...(turnId === undefined ? {} : { turnId }),
          ...(typeof turnCount === "number" ? { turnCount } : {})
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

  /**
   * `turnCount` is the completing turn's ordinal (§5.5), read when the turn
   * ended — not when the capture queue gets to it, by which time a revert may
   * have truncated the row. Omitted, the service falls back to a placeholder's
   * count and then to its own derivation.
   */
  const captureTurnEnd = (
    runtime: ThreadRuntime,
    turnId: string | null,
    turnCount: number | null
  ): void => {
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
          activeTurnId: currentSession(runtime).activeTurnId,
          ...(turnCount !== null ? { turnCount } : {})
        });
        if (!summary) return;
        // A capture that lands after a revert belongs to a turn the revert
        // truncated; appending it raises `head.turnCount` past the target and
        // visibly undoes the rewind (the checkpoint list keeps a row with no
        // matching turn). The guard is lifted by the next `turn.started`, so a
        // genuinely new turn — numbered `target + 1` — is never mistaken for
        // one of these.
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
            // §3.1 for EVERY live turn. A turn the provider starts by itself —
            // a goal's continuation, the turn Codex starts for a host `/goal`,
            // one after a create-time or a goals §5.5 boot resume — never went
            // through `sendTurnEffect`, so nothing armed a watchdog for it: its
            // first `turn.started` does. The explicit arms stay. A replayed
            // turn is the past and is never watched.
            if (
              event.type === "turn.started" &&
              runtime.watchdog === null &&
              !isHistoricalRuntimeEvent(event)
            ) {
              watchdogFor(runtime);
            }
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
            // capture reads its `assistantMessageId` from — and the row
            // carries the provider's id, which is what places the turn in the
            // thread's ORDER (§5.5): its ordinal is the checkpoint's count.
            const turnId = event.turnId ?? null;
            if (event.type === "turn.started") {
              // A new turn after a rewind legitimately advances the count past
              // the target, so the late-capture guard ends here (§5.5).
              if (!isHistoricalRuntimeEvent(event)) {
                runtime.revertedTo = null;
              }
              // Backstop for turns the host did not dispatch itself (a
              // continuation, an adapter-initiated turn). The turn id is
              // recorded with it, so a stale abort for another turn cannot
              // mint a checkpoint later (§5.4).
              const ordinal = turnOrdinalOf(runtime, turnId);
              void captureBaseline(runtime, {
                turnId,
                turnCount: ordinal === null ? null : ordinal - 1
              });
            } else if (event.type === "turn.completed" || event.type === "turn.aborted") {
              persistCursorAtTurnEnd(runtime);
              captureTurnEnd(runtime, turnId, turnOrdinalOf(runtime, turnId));
              // A replayed turn is the past: its questions were settled when it
              // happened, and there is no live provider to strand.
              if (!isHistoricalRuntimeEvent(event)) {
                await settleStrandedQuestions(runtime, turnId);
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
    // The intentional stop begins here: a goal resume that has not reached
    // the provider yet must not start a child now (goals §5.5).
    handoverStarted = true;
    const marked: string[] = [];
    // `/stop` is the deploy handover's critical path. Most production threads
    // are idle and some have 40-100 MB histories, so loading all of them here
    // folded every log on disk before the host could acknowledge its stop —
    // the cost the lazy boot (A1) took out of startup, moved to shutdown,
    // where a deploy's drain-restart waits on it. Only a thread that can be
    // running is loaded: every thread this host serves, every thread with a
    // live provider session, and an unloaded thread only when its `meta.json`
    // (read alone, never the log) says a turn is running — and the project
    // opted in, and a cursor exists, the two predicates repeated after the
    // load — or when it cannot be read at all, the same rule the reconcile
    // applies. `binding.json` is small too and stays the cursor authority, so
    // a head written by an older version still works. A continuing goal
    // (goals §5.5) needs no rule of its own here: it has a live session, so
    // its thread is a candidate already.
    const candidates = new Set<string>(runtimes.keys());
    const liveSessions = new Set<string>();
    for (const adapter of options.adapters.values()) {
      for (const session of adapter.listSessions()) {
        liveSessions.add(session.threadId);
      }
    }
    for (const threadId of await store.listThreads()) {
      if (candidates.has(threadId)) continue;
      if (liveSessions.has(threadId)) {
        candidates.add(threadId);
        continue;
      }
      try {
        const persistedHead = await store.loadHead(threadId, { seedRuntime: false });
        if (persistedHead !== null) {
          const persistedSession = persistedHead.session;
          if (persistedSession.status !== "running" || persistedSession.activeTurnId === null) {
            continue;
          }
          if ((await options.continuationEnabled?.(persistedHead.projectPath)) !== true) continue;
          const persistedBinding = await store.loadBinding(threadId).catch(() => null);
          if (
            (bindingResumeCursor(persistedBinding) ?? persistedSession.resumeCursor) === undefined
          ) {
            continue;
          }
        }
      } catch {
        // Undecidable from the small files: the fold below decides, and logs.
      }
      candidates.add(threadId);
    }
    for (const threadId of candidates) {
      try {
        // The authoritative fold, for the small set of candidates: every
        // predicate is repeated on it, in case the turn settled since.
        const runtime = await loadRuntime(threadId);
        const head = headOf(runtime);
        if (!head || runtime.deleted) continue;
        const { activeTurnId, status } = head.session;
        // Only threads with a usable cursor (§3.3). The cursor is read from
        // the BINDING: a marker is only ever written for a thread that really
        // can be resumed, and the head's copy is a projection that an event may
        // already have replaced.
        if (persistedResumeCursor(runtime, head) === undefined) continue;
        // A running turn is continued only where the project opted in.
        // Continuation is opt-in per project over a host-wide default that is
        // OFF, so a marker written for an opted-out thread would make the next
        // boot resume it — the reconcile trusts a marker on its own, exactly
        // because the stop path is supposed to be the place that filter is
        // applied.
        const turnToContinue =
          status === "running" &&
          activeTurnId !== null &&
          (await options.continuationEnabled?.(head.projectPath)) === true
            ? activeTurnId
            : null;
        // Goals §5.5: a goal the provider continues by itself is resumed
        // WITHOUT that opt-in — setting the goal was the user's opt-in to
        // autonomous work. Only one that IS continuing, on a live session: a
        // goal whose session the user stopped must not be revived by a deploy.
        const adapter = options.adapters.get(head.adapter);
        const resumeGoal = goalContinues(runtime, adapter) && sessionIsLive(runtime, head, adapter);
        if (turnToContinue === null && !resumeGoal) continue;
        if (resumeGoal) {
          runtime.resumeGoalAfterRestart = true;
        }
        await writeMarker(
          runtime,
          turnToContinue !== null ? { turnId: turnToContinue } : runtime.continueAfterRestart
        );
        marked.push(threadId);
      } catch (error) {
        logger.warn(`agent-host: failed to mark ${threadId} for continuation`, error);
      }
    }
    return marked;
  };

  const clearContinuationMarkers = async (threadIds: readonly string[]): Promise<void> => {
    // The stop was aborted. No resume is restarted from here — this path runs
    // when a teardown failed part-way, and a goal a resume skipped keeps its
    // mark on disk for the next boot.
    handoverStarted = false;
    for (const threadId of threadIds) {
      const runtime = runtimes.get(threadId);
      if (!runtime) continue;
      try {
        // Both kinds: a cancelled restart must not resume anything next boot.
        runtime.resumeGoalAfterRestart = undefined;
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

  /**
   * A1: the settle a thread the reconcile did not fold is owed, on its first
   * load. Best-effort, exactly as it was at boot — a failure is logged and the
   * thread still loads, rather than a transient write error making it
   * unreadable.
   */
  const settleOnFirstLoad = async (runtime: ThreadRuntime): Promise<void> => {
    try {
      await settleStalePendingTurns(runtime);
    } catch (error) {
      logger.warn(`agent-host: failed to settle ${runtime.id} on its first load`, error);
    }
  };

  const reconcile = async (): Promise<void> => {
    // The head is the startup index. A deploy waits for the old host to drain,
    // so almost every persisted thread is idle and needs no reconciliation at
    // all. Loading a runtime for each one used to call `readAll()` and fold its
    // complete NDJSON history before the readiness gate opened; a handful of
    // long-lived 40-100 MB threads turned an ordinary deploy into a multi-
    // minute outage. `reconcileThread` inspects the small atomic head first
    // and cold-folds only a thread that can actually be orphaned.
    //
    // Never blocks or fails startup on one bad thread: every candidate is
    // handled and settled individually, and a failure of the whole pass is
    // logged (§3.3).
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
    // Goals §5.5: a no-op before the gate — `openGate` starts them then.
    startGoalResumes();
  };

  /**
   * Goals §5.5: threads whose persisted head asks for their continuing goal's
   * provider session back, as the reconcile found them from `meta.json` alone.
   * Resumed only once the gate is open — never on the readiness path.
   */
  const goalResumePending = new Set<string>();
  /** The resume pass in flight; `drain` waits on it (§9). */
  let goalResumes: Promise<void> = Promise.resolve();

  /**
   * The intentional stop has begun: `/stop` runs `markThreadsForContinuation`
   * first, before any adapter is torn down, so this is the earliest this host
   * can know it is going away. Reset only when that stop is aborted
   * (`clearContinuationMarkers`).
   */
  let handoverStarted = false;

  /**
   * This host is going away — the handover pass has begun, or the orchestrator
   * itself is stopping. A goal resume cut short by it keeps its mark: the next
   * host owes the resume, and a provider child started now would outlive
   * `stopAll`.
   */
  const hostStopping = (): boolean => stopped || handoverStarted;

  const startGoalResumes = (): void => {
    if (!gateOpen || hostStopping() || goalResumePending.size === 0) {
      return;
    }
    const threadIds = [...goalResumePending];
    goalResumePending.clear();
    goalResumes = goalResumes
      // A macrotask later, so the health answer the gate just released goes
      // out first.
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      // Side by side: each resume is bounded by its own session-open deadline,
      // and one wedged provider must not hold every other goal back.
      .then(() => Promise.all(threadIds.map((threadId) => resumeGoalSession(threadId))))
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.warn("agent-host: the goal resume pass failed", error);
      });
  };

  /**
   * Goals §5.5: bring back the provider session of a thread whose goal was
   * continuing when the previous host stopped — through the same ensure-session
   * path a turn uses, and WITHOUT sending a turn: the provider continues the
   * goal by itself once its session is back (Codex, §3.2). The mark is then
   * cleared, success or not; a failure is logged and never retried.
   *
   * Except when a stop cut the resume short ({@link hostStopping}, checked
   * before the provider is asked and again once it has answered): the mark is
   * KEPT for the next host, and a session the resume did start is stopped
   * again — `stopAll` may already have run, and nothing else would stop it.
   */
  const resumeGoalSession = async (threadId: string): Promise<void> => {
    if (hostStopping()) return;
    let runtime: ThreadRuntime;
    try {
      runtime = await loadRuntime(threadId);
    } catch (error) {
      if (hostStopping()) return;
      logger.warn(`agent-host: could not load ${threadId} to resume its goal`, error);
      await clearGoalResumeMarkOnDisk(threadId);
      return;
    }
    await runEffect(runtime, async () => {
      // Cleared since — the user's own Stop, an aborted handover: nothing owed.
      if (runtime.resumeGoalAfterRestart !== true) return;
      let keepMark = false;
      try {
        const head = headOf(runtime);
        if (!head || runtime.deleted) return;
        // A closed tab's thread is settled, never continued (§3.3).
        if ((await options.isThreadClosed?.(threadId)) === true) {
          logger.info("agent-host: not resuming the goal of a closed tab", { threadId });
          return;
        }
        if (persistedResumeCursor(runtime, head) === undefined) {
          logger.warn(`agent-host: ${threadId}'s goal has no resume cursor; not resuming it`);
          return;
        }
        if (hostStopping()) {
          keepMark = true;
          return;
        }
        await ensureSession(runtime);
        if (hostStopping()) {
          keepMark = true;
          await stopResumedSession(runtime);
          return;
        }
        logger.info("agent-host: resumed a continuing goal's session after a restart", {
          threadId
        });
      } catch (error) {
        if (hostStopping()) {
          // Most likely the stop itself tore the starting child down.
          keepMark = true;
          await stopResumedSession(runtime);
          return;
        }
        logger.warn(`agent-host: could not resume ${threadId}'s goal session after a restart`, error);
      } finally {
        if (!keepMark) {
          runtime.resumeGoalAfterRestart = undefined;
          if (!runtime.deleted) {
            await saveHeadNow(runtime);
          }
        }
      }
    });
  };

  /**
   * Take back a session the goal resume started after the host began to stop.
   * The head's session state is left as it was: the kept mark, not the head,
   * is what the next host acts on.
   */
  const stopResumedSession = async (runtime: ThreadRuntime): Promise<void> => {
    runtime.watchdog?.stop();
    runtime.watchdog = null;
    runtime.bound = null;
    releaseProviderThreads(runtime.id);
    const adapterId = runtime.state.head?.adapter;
    const adapter = adapterId === undefined ? undefined : options.adapters.get(adapterId);
    if (adapter === undefined || !adapter.hasSession(runtime.id)) return;
    try {
      await adapter.stopSession(runtime.id);
    } catch (error) {
      logger.warn(`agent-host: could not stop ${runtime.id}'s resumed session during a stop`, error);
    }
  };

  /**
   * The mark of a thread this host cannot even load: the resume failed, so the
   * mark goes, once (goals §5.5). Off `meta.json` itself — the read the
   * reconcile found it with — since there is no runtime to clear it on.
   */
  const clearGoalResumeMarkOnDisk = async (threadId: string): Promise<void> => {
    try {
      const persisted = await store.loadHead(threadId, { seedRuntime: false });
      if (persisted === null || persisted.resumeGoalAfterRestart !== true) return;
      const { resumeGoalAfterRestart: _resumed, ...cleared } = persisted;
      void _resumed;
      await store.saveHead(cleared);
    } catch (error) {
      logger.warn(`agent-host: could not clear ${threadId}'s goal resume mark`, error);
    }
  };

  const reconcileThread = async (threadId: string, live: Set<string>): Promise<void> => {
    // Anything the host can see running is excluded first, so an adopted host
    // is not reconciled against itself.
    if (live.has(threadId)) return;
    // A1 (design 2026-09-23): orphaned-or-not is decided from `meta.json`
    // alone — `commit` rewrites it on every session transition for exactly
    // this reader — and only an orphan is folded here. An idle thread is left
    // on disk; the settle it is owed runs on its first load. A thread already
    // in memory keeps the full path (it costs nothing), and a head that cannot
    // be read decides nothing: that thread is folded, as every thread was.
    // Metadata only (`seedRuntime: false`): deciding that a thread needs
    // nothing must not read its `events.ndjson` either.
    if (!runtimes.has(threadId) && !loadingRuntimes.has(threadId)) {
      const persistedHead = await store
        .loadHead(threadId, { seedRuntime: false })
        .catch(() => null);
      if (persistedHead !== null && !isOrphanedHead(persistedHead)) {
        bootSettlePending.add(threadId);
        // Goals §5.5, decided off the same `meta.json` read: the handover
        // marked this thread's continuing goal for a resume after the gate.
        if (persistedHead.resumeGoalAfterRestart === true) {
          goalResumePending.add(threadId);
        }
        return;
      }
    }
    const runtime = await loadRuntime(threadId);
    const head = headOf(runtime);
    if (!head) {
      // A thread directory that fails to parse marks that thread `error`; it
      // never affects other threads or host startup (§5.1).
      return;
    }
    // Goals §5.5 on the full path too: an orphan the handover also marked (a
    // manual stop mid-turn), or a thread already in memory.
    if (head.resumeGoalAfterRestart === true) {
      goalResumePending.add(threadId);
    }
    const session = head.session;
    const marker = head.continueAfterRestart;
    const orphaned = isOrphanedHead(head);
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
    await goalResumes;
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
    setIdentity,
    deleteThread,
    command,
    readThread,
    readHistory,
    searchThreads,
    readItem,
    readToolOutput,
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
    // Both buckets count: an agent fleet ("working") is hours of real work,
    // and a watch loop ("monitoring") loses its output the same way. The
    // registry's own TTL bounds a silent watch loop, so a dev server left
    // running cannot defer a deploy for longer than that window.
    backgroundWorkThreadIds: () =>
      [...runtimes.values()]
        .filter((runtime) => liveness.liveness(runtime.id) !== null)
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
 * §3.3's orphan predicate: a turn was in flight, or a continuation was
 * prepared and never sent. One expression for both of its readers — the boot
 * decision off `meta.json` (A1) and the full path off the folded head — so the
 * two can never disagree on what "orphaned" means.
 */
function isOrphanedHead(head: ThreadHead): boolean {
  const session = head.session;
  return (
    session.status === "starting" ||
    session.status === "running" ||
    session.activeTurnId !== null ||
    (session.status === "ready" && head.continueAfterRestart?.prepared === true)
  );
}

/**
 * `ThreadRuntime.revertedTo` and `titleManual` as the log leaves them, advanced
 * over `events` — the one derivation a cold fold, a snapshot's tail and every
 * `commit` share, so a reload from `state.json` + tail equals a reload from the
 * whole log.
 *
 * `revertedTo` is the target of the last `thread.reverted`, unless a turn
 * started after it — the rule the live path applies on `turn.started`, read
 * off the `thread.session-set` that names a running turn. Without the second
 * half a host restart would re-arm a guard the running host had already
 * lifted, and drop the next capture of a turn that is not a truncated one at
 * all.
 *
 * `titleManual` is set by a `thread.meta-updated` that carries a title AND a
 * `commandId` — the user's own rename (§5.1); a provider retitle is appended
 * with `commandId: null`.
 */
function advanceLogDerived(from: LogDerived, events: readonly DomainEvent[]): LogDerived {
  let { revertedTo, titleManual } = from;
  for (const event of events) {
    if (event.type === "thread.reverted") {
      revertedTo = event.payload.turnCount;
    } else if (
      revertedTo !== null &&
      event.type === "thread.session-set" &&
      event.payload.session.status === "running" &&
      event.payload.session.activeTurnId !== null
    ) {
      revertedTo = null;
    } else if (
      !titleManual &&
      event.type === "thread.meta-updated" &&
      event.payload.title !== undefined &&
      event.commandId !== null
    ) {
      titleManual = true;
    }
  }
  return revertedTo === from.revertedTo && titleManual === from.titleManual
    ? from
    : { revertedTo, titleManual };
}

/**
 * A fold snapshot's `extras`, validated field-wise (it is read from disk):
 * null unless both derivations are present and well-formed, in which case the
 * snapshot is not used at all rather than half-trusted.
 */
function parseLogDerived(extras: unknown): LogDerived | null {
  if (extras === null || typeof extras !== "object" || Array.isArray(extras)) {
    return null;
  }
  const record = extras as Record<string, unknown>;
  const { revertedTo, titleManual } = record;
  if (typeof titleManual !== "boolean") {
    return null;
  }
  if (
    revertedTo !== null &&
    !(typeof revertedTo === "number" && Number.isSafeInteger(revertedTo) && revertedTo >= 0)
  ) {
    return null;
  }
  return { revertedTo, titleManual };
}

/**
 * §5.6's read-time projection of a timeline, shared by the snapshot and a
 * history page: a superseded `tool.updated` and a stale
 * `context-window.updated` are dropped, and every activity payload is slimmed
 * on its way to the wire. `GET …/items/:itemId` stays unslimmed.
 */
function slimItemsForRead(items: readonly ThreadItem[]): ThreadItem[] {
  const kept = new Set(
    projectSnapshotActivities(
      items.filter((item): item is ThreadActivityItem => item.kind === "activity")
    ).map((activity) => activity.id)
  );
  return items
    .filter((item) => item.kind !== "activity" || kept.has(item.id))
    .map((item) => {
      if (item.kind !== "activity") return item;
      const slimmed = slimActivityPayload(item.payload);
      return slimmed === item.payload ? item : { ...item, payload: slimmed };
    });
}

/**
 * Activities per history block (design 2026-09-23, C, "History page") — below
 * the fold's 500-row window, so folding a block never evicts one of its rows.
 */
export const HISTORY_PAGE_ACTIVITIES = 400;

/** One planned history block (`planHistoryBlock`). */
interface HistoryBlock {
  fromByte: number;
  toByte: number;
  /** The seq of the line at `toByte`: the first line the block does not hold. */
  endSeq: number;
  /** The turns whose ranges meet the block, in ordinal order. */
  turns: IndexedTurn[];
  /** The first turn's opening seq: what lies before it is the thread's preamble, not a revert's cut. */
  firstTurnSeq: number | null;
  beforeCursor: string | null;
}

/**
 * The activity the retained window begins at — where the history below it
 * starts — as the index positions it; null when the index knows none.
 *
 * Not simply the oldest activity the fold holds: retention keeps a few rows
 * out of age order (an agent's launch and end, a compaction marker, an open
 * question), and it evicts per class — the parent timeline's 500 rows, each
 * agent's own 200, 2 000 across agents. An anchor kept from the first turn
 * would put the boundary there, and every block would start below it while
 * the rows evicted after it were never served; a fleet whose agents lost
 * their early rows while the parent's few rows survived would read as having
 * nothing older at all. So each FULL class's window is found where retention
 * would find it — its last `limit` rows — and the boundary is the newest of
 * their first rows: everything evicted lies below it.
 *
 * Only once the fold has evicted an activity at all (`state.evicted`). Under
 * batch retention (design 2026-09-23 fold performance) a class grows to its
 * limit + slack before a trim, so "at least `limit` rows" no longer means
 * "lost rows": a thread holding 501–550 parent rows that never trimmed would
 * report older history and serve a first page the window already shows.
 * After a trim the positional windows stay right, just conservative: a class
 * holding up to its slack past its limit puts its boundary at or after the
 * true cut, so the first page may repeat that many of the window's oldest
 * rows, which the client renders once. With nothing evicted, the oldest
 * activity the index knows is the boundary.
 */
function windowBoundary(
  state: ThreadFoldState,
  index: ThreadIndex,
  threadId: string
): IndexedItemPosition | null {
  const activities = state.activities ?? [];
  const parentRows: ThreadActivityItem[] = [];
  const agentRows: ThreadActivityItem[] = [];
  const rowsByAgent = new Map<string, ThreadActivityItem[]>();
  for (const activity of activities) {
    const owner =
      typeof activity.agentId === "string" && activity.agentId.length > 0 ? activity.agentId : null;
    if (owner === null) {
      parentRows.push(activity);
      continue;
    }
    agentRows.push(activity);
    const rows = rowsByAgent.get(owner);
    if (rows) rows.push(activity);
    else rowsByAgent.set(owner, [activity]);
  }
  const windows: ThreadActivityItem[][] = [];
  const addWindow = (rows: readonly ThreadActivityItem[], limit: number): void => {
    if (rows.length >= limit) windows.push(rows.slice(rows.length - limit));
  };
  if (state.evicted?.activities === true) {
    addWindow(parentRows, ACTIVITY_RETENTION_LIMIT);
    for (const rows of rowsByAgent.values()) {
      addWindow(rows, AGENT_ACTIVITY_RETENTION_LIMIT);
    }
    // The ceiling across every agent keeps the newest rows by time — compared
    // as plain strings, exactly as the fold's trim orders them.
    addWindow(
      [...agentRows].sort((left, right) =>
        left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0
      ),
      AGENT_ACTIVITY_TOTAL_LIMIT
    );
  }

  const firstKnown = (rows: readonly ThreadActivityItem[]): IndexedItemPosition | null => {
    for (const activity of rows) {
      const position = index.itemPosition(threadId, activity.id);
      if (position !== null) return position;
    }
    return null;
  };
  if (windows.length === 0) {
    return firstKnown(activities);
  }
  let boundary: IndexedItemPosition | null = null;
  for (const window of windows) {
    const position = firstKnown(window);
    if (position !== null && (boundary === null || position.seq > boundary.seq)) {
      boundary = position;
    }
  }
  return boundary;
}

/**
 * The turn a block boundary is named after in a cursor: the one whose range
 * holds `seq`, or the first turn for a row older than every turn. Its id and
 * anchor are information once the cursor carries `beforeSeq`.
 */
function anchorTurnOf(index: ThreadIndex, threadId: string, seq: number): IndexedTurn | null {
  return index.turnOfSeq(threadId, seq) ?? index.turnByOrdinal(threadId, 1);
}

/** The cursor of the block that ends just below the activity line at `seq`. */
function blockCursor(threadId: string, turn: IndexedTurn, seq: number): HistoryCursor {
  return {
    threadId,
    beforeAnchorAt: turn.requestedAt,
    beforeTurnId: turn.turnId,
    beforeSeq: seq
  };
}

/**
 * Where a cursor's block ends: just below the line it names (`beforeSeq` — an
 * activity's line or a message's first chunk), or at the start of the turn it
 * names. Null when the cursor names nothing the index still knows — a first-
 * page request, then.
 *
 * A `beforeSeq` goes stale when its activity is rewritten under the same id
 * (the index follows its latest line): the block then ends just past the
 * activity below it, so at most that gap's non-activity rows go unserved —
 * never an activity, and never a row twice.
 */
function endOfCursor(
  index: ThreadIndex,
  threadId: string,
  cursor: HistoryCursor
): { seq: number; byteOffset: number } | null {
  if (cursor.beforeSeq !== undefined) {
    const position = index.eventPositionBySeq(threadId, cursor.beforeSeq);
    if (position !== null) {
      return { seq: position.seq, byteOffset: position.byteOffset };
    }
    const below = index.activitySeqBefore(threadId, { beforeSeq: cursor.beforeSeq, count: 1 });
    const belowAt = below === null ? null : index.itemPositionBySeq(threadId, below);
    // Nothing below it at all: the block is empty, not the first page again.
    return belowAt === null
      ? { seq: cursor.beforeSeq, byteOffset: 0 }
      : { seq: cursor.beforeSeq, byteOffset: belowAt.byteOffset + belowAt.byteLength };
  }
  const turn = index.turnById(threadId, cursor.beforeTurnId);
  return turn === null ? null : { seq: turn.firstSeq, byteOffset: turn.firstByte };
}

/**
 * `seq`, moved back past every streamed message it would split: a message
 * whose first chunk lies below `seq` and whose later chunks do not. Moving to
 * such a message's first chunk may land inside an older one, so it repeats —
 * bounded, since each step only moves back.
 */
function outsideMessages(index: ThreadIndex, threadId: string, seq: number): number {
  let bound = seq;
  for (let round = 0; round < 8; round += 1) {
    const spanning = index.messagesSpanning(threadId, bound);
    if (spanning.length === 0) {
      return bound;
    }
    const earliest = Math.min(...spanning.map((message) => message.firstSeq));
    if (earliest >= bound) {
      return bound;
    }
    bound = earliest;
  }
  return bound;
}

/**
 * The `turns` soft cap: the turn a block ending at `end` may reach back to —
 * the `turns`-th started turn back, counting the end's own turn when the end
 * falls inside it. Null when the thread has fewer turns than that.
 */
function capTurnOf(
  index: ThreadIndex,
  threadId: string,
  end: { seq: number },
  turns: number
): IndexedTurn | null {
  const endTurn = index.turnOfSeq(threadId, end.seq);
  if (endTurn === null) {
    return null;
  }
  const ordinal = endTurn.ordinal - turns + (end.seq > endTurn.firstSeq ? 1 : 0);
  return ordinal >= 1 ? index.turnByOrdinal(threadId, ordinal) : null;
}

/**
 * A block's events without a revert's cut: the index's turn ranges tile the
 * log except where a revert removed turns — those turns' lines and the
 * `thread.reverted` itself belong to no turn — so only events inside some
 * turn's `[firstSeq, lastSeq]`, or before the first turn (the thread's
 * preamble), are folded. Folding the cut would bring back the removed turns
 * and apply a `turnCount` counted from the thread's first turn, not the
 * block's. `turns` are the block's own, in ordinal order.
 */
function eventsOutsideRevertCuts(
  events: readonly DomainEvent[],
  turns: readonly IndexedTurn[],
  firstTurnSeq: number | null
): DomainEvent[] {
  if (firstTurnSeq === null) {
    return [...events];
  }
  const kept: DomainEvent[] = [];
  let turn = 0;
  for (const event of events) {
    if (event.seq < firstTurnSeq) {
      kept.push(event);
      continue;
    }
    while (turn < turns.length && event.seq > turns[turn]!.lastSeq) {
      turn += 1;
    }
    if (turn < turns.length && event.seq >= turns[turn]!.firstSeq) {
      kept.push(event);
    }
  }
  return kept;
}

/** `turns` of a history request: an integer in `[1, THREAD_HISTORY_MAX_TURNS]`. */
function clampHistoryTurns(turns: number | undefined): number {
  if (typeof turns !== "number" || !Number.isFinite(turns)) {
    return THREAD_HISTORY_DEFAULT_TURNS;
  }
  return Math.min(THREAD_HISTORY_MAX_TURNS, Math.max(1, Math.floor(turns)));
}

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
    if (item.kind === "message" && item.role === "user" && isPlanImplementationMessage(item.text)) {
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
