/**
 * Agent chat — the per-thread zustand slice (spec §7.2, §6.6).
 *
 * **A zustand slice per open thread, created on tab open and dropped on tab
 * close.** Closed tabs keep nothing; the tab strip reads only
 * `SessionSummary`. The slices are held in a refcounted registry so one
 * `AgentChatView` instance can serve every chat tab in a project (§7.1) and a
 * tab switch never tears down the thread the user is switching *from* until
 * the next snapshot lands.
 *
 * **Server-authoritative, cursor-ordered** (§6.6): every mutation is a command
 * answered with `{seq}`; sends, approvals, answers and interrupts have **no**
 * optimistic path — the user's message appears when its event arrives. The one
 * narrow optimistic rule (tab-local reorder/rename) lives in the app store, not
 * here.
 *
 * No React import — `hooks.ts` is the only React file in this package.
 */

import { createStore, type StoreApi } from "zustand/vanilla";

import {
  ACTIVE_SUBAGENT_STATUSES,
  DEFAULT_INTERACTION_MODE,
  type AgentChatCommandBodies,
  type AgentChatCommandName,
  type ApprovalDecision,
  type AttachmentRef,
  type ComposerContextRecord,
  type InteractionMode,
  type ModelSelection,
  type RuntimeMode,
  type RuntimeSubagent,
  type ThreadActivityItem,
  type ThreadItem,
  type ThreadMessageItem,
  type ThreadTokenUsage
} from "@orquester/api/agent-chat";

import type {
  ActivePlanState,
  AgentChatActions,
  AgentChatThreadSlice,
  AgentChatTimelineRow,
  DisclosureState,
  QueuedComposerMessage,
  RememberedTimelinePosition
} from "./contracts";
import {
  EMPTY_DRAFT,
  type ComposerDraft,
  readPersistedDrafts,
  writePersistedDrafts
} from "./composer.logic";
import {
  deriveTimelineEntriesFromItems,
  EMPTY_TIMELINE_PROJECTION,
  type ThreadTimelineProjection
} from "./entries.logic";
import {
  deriveActivePlanState,
  findLatestProposedPlan,
  hasActionableProposedPlan
} from "./plan.logic";
import {
  applyFrame,
  createReducerState,
  latestTurnSettled,
  needsResync,
  patchSlice,
  type AgentChatReducerState
} from "./reducer.logic";
import {
  computeStableRows,
  deriveTimelineRowsWithState,
  EMPTY_STABLE_ROWS,
  type StableRowsState,
  type TimelineRowsProjection
} from "./rows.logic";
import { providerForRefId, providersStore } from "./providers";
import { liveAgentTaskIds } from "./roster.logic";
import { isCompactingThread, latestContextWindowActivity } from "./status.logic";
import {
  drainQueue,
  EMPTY_QUEUE,
  enqueue,
  holdAtFront,
  latestCompletedToolActivityId,
  nextDueQueuedMessage,
  removeQueued,
  takeQueued,
  type QueuePhase,
  type QueueState
} from "./queue.logic";
import {
  composerHandle,
  insertComposerText,
  stageComposerAttachment
} from "../../components/agent-chat/composer/composer-bridge";
import { nudgeProjectGit } from "../../components/git/git-watch";
import {
  disclosureSets,
  EMPTY_DISCLOSURE_STATE,
  timelinePositionStore
} from "./timeline-position";
import {
  AgentChatCommandError,
  type AgentChatStreamHandle,
  type AgentChatStreamOptions,
  type AgentChatTransport
} from "./transport";
import {
  ThreadRetentionCache,
  THREAD_SNAPSHOT_IDLE_TTL_MS,
  type RetainedThread
} from "./retention";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ThreadStoreDeps {
  transport: AgentChatTransport;
  /** Injected so tests are deterministic. */
  newId?: () => string;
  now?: () => string;
  /** How many times a `HOST_UNAVAILABLE` command is retried with the SAME id. */
  hostUnavailableRetries?: number;
  /** Injected in tests; production uses `setTimeout`. */
  delay?: (ms: number) => Promise<void>;
}

function defaultId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoRef?.randomUUID) {
    return cryptoRef.randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A thread that has never been scrolled is pinned to the end and follows. */
const DEFAULT_SCROLL_POSITION: RememberedTimelinePosition = {
  rowId: null,
  offsetWithinRow: 0,
  scrollOffset: 0,
  atEnd: true,
  disclosures: EMPTY_DISCLOSURE_STATE,
  interactionMode: DEFAULT_INTERACTION_MODE
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface AgentChatThreadState {
  /** What the hooks read (§7.2). */
  slice: AgentChatThreadSlice;
  /** The three memoised projection layers, kept so each can take its fast path. */
  rows: AgentChatTimelineRow[];
  /**
   * The provider is rewriting the conversation right now (§7.3, §7.6). Derived
   * here beside the rows because the phase and the rows read the same three
   * facts, and the status line must never disagree with the timeline about
   * what the turn is doing.
   */
  isCompacting: boolean;
  activePlan: ActivePlanState | null;
  /**
   * The proposal the composer's primary action acts on (§7.3): the latest
   * un-implemented plan, preferring the current turn. `null` when there is
   * none, which is what turns the split button back into a plain send.
   *
   * On the state rather than derived in the view because the plans live in the
   * timeline projection, which only this module holds. `id`/`turnId` ride along
   * so a consumer can tell one proposal from the next without diffing markdown.
   */
  actionableProposedPlan: { id: string; planMarkdown: string; turnId: string | null } | null;
  /**
   * True while a `/revert` is in flight — for `rewindTo`, until the host has
   * answered it on the stream; §7.5's one reason the composer goes inert.
   */
  reverting: boolean;
  /** The composer's persisted draft for this thread. */
  draft: ComposerDraft;
  /** True while an interrupt is in flight; the Stop button reads "Stopping…". */
  stopping: boolean;
  actions: AgentChatActions;
}

interface InternalState extends AgentChatThreadState {
  reducer: AgentChatReducerState;
  queue: QueueState;
  timeline: ThreadTimelineProjection;
  rowsProjection: TimelineRowsProjection | null;
  stableRows: StableRowsState;
  /**
   * The three `Set`-valued row inputs, cached against the arrays they are
   * built from.
   *
   * `shallowEqualInput` compares them by **reference**, so rebuilding them on
   * every projection made the layer-2 fast path unreachable — a single
   * streamed token re-ran the whole grouping and folding pass and allocated a
   * new row array, on a provider that emits hundreds of delta frames per turn
   * (fix-wave Q2-4). Recomputing only when the source identity moves is what
   * makes `replaceStreamingMessageRows` reachable at all.
   */
  derivedSets: {
    disclosures: DisclosureState;
    roster: readonly RuntimeSubagent[];
    expandedTurnIds: ReadonlySet<string>;
    expandedGroupIds: ReadonlySet<string>;
    liveAgentTaskIds: ReadonlySet<string>;
  } | null;
}

export type ThreadStore = StoreApi<AgentChatThreadState>;

// ---------------------------------------------------------------------------
// Retention (spec §6.5, §7.2)
// ---------------------------------------------------------------------------

/**
 * Everything a remount needs to paint the thread **without a network round
 * trip**: the fold, the client-local view state riding on it, and every cached
 * projection layer built from it.
 *
 * Deliberately *not* here: `actions` (they close over a dead store), the
 * in-flight command flags `reverting`/`stopping` (a command of the destroyed
 * generation can never settle), and the composer draft (already persisted, and
 * read back on construction). Those are the fields T3's `cachedThreadState`
 * normalises away for the same reason.
 */
export interface RetainedThreadState {
  reducer: AgentChatReducerState;
  queue: QueueState;
  timeline: ThreadTimelineProjection;
  rowsProjection: TimelineRowsProjection | null;
  stableRows: StableRowsState;
  derivedSets: InternalState["derivedSets"];
  rows: AgentChatTimelineRow[];
  isCompacting: boolean;
  activePlan: ActivePlanState | null;
  actionableProposedPlan: AgentChatThreadState["actionableProposedPlan"];
}

/**
 * The value-only retained-snapshot cache, 5-minute idle TTL. The *live*
 * subscription is released after {@link THREAD_STORE_DISPOSE_GRACE_MS}; this
 * is what makes coming back to it instant anyway.
 */
const retention = new ThreadRetentionCache<RetainedThreadState>();

/** Test seam: drop every retained snapshot. */
export function resetThreadRetention(): void {
  retention.clear();
}

/** How many threads currently hold a retained snapshot. Test/diagnostic seam. */
export function retainedThreadCount(): number {
  return retention.size;
}

/**
 * The retained state as a remount should paint it.
 *
 * A retained **synchronized** connection stays synchronized: the cursor resume
 * that follows only replays what the thread missed, so downgrading here would
 * flash "Connecting…" over a timeline that is already on screen and correct —
 * which is exactly the regression the 15-minute dispose grace was papering
 * over. Anything else falls back to `idle`, from which the stream's own
 * `onOpen` takes it to `connecting` as on a cold start.
 *
 * The error banner is cleared with it: it described a command posted by a
 * generation that no longer exists.
 *
 * *T3: `packages/client-runtime/src/state/threads.ts:161-176`
 * (`cachedThreadState`).*
 */
export function cachedThreadState(retained: RetainedThreadState): RetainedThreadState {
  const slice = retained.reducer.slice;
  const connection =
    slice.connection === "synchronized" && slice.head !== null ? "synchronized" : "idle";
  const reducer = patchSlice(retained.reducer, { connection, errorBanner: null });
  return reducer === retained.reducer ? retained : { ...retained, reducer };
}

/** Snapshot the live state into a retainable value. */
function retainableFrom(state: InternalState): RetainedThread<RetainedThreadState> {
  return {
    state: {
      reducer: state.reducer,
      queue: state.queue,
      timeline: state.timeline,
      rowsProjection: state.rowsProjection,
      stableRows: state.stableRows,
      derivedSets: state.derivedSets,
      rows: state.rows,
      isCompacting: state.isCompacting,
      activePlan: state.activePlan,
      actionableProposedPlan: state.actionableProposedPlan
    },
    // The fold's own cursor, never the slice's: they agree, and the fold is
    // what `applyFrame` compares an incoming event against.
    sequence: state.reducer.fold.seq
  };
}

// ---------------------------------------------------------------------------
// Rewind (§5.5, §7.5)
// ---------------------------------------------------------------------------

/**
 * How long {@link AgentChatActions.rewindTo} holds the composer inert waiting
 * for the host to answer a `/revert`. A rollback is a provider fork — Claude
 * re-reads its native history, in a child process when the account home
 * differs — so it gets minutes, not seconds; but never forever. Past this the
 * composer comes back and the thread still converges from the stream whenever
 * the host finishes.
 */
export const REWIND_TIMEOUT_MS = 120_000;

/** What §5.5 step 6 appends, as an `error` activity, for any failed rewind. */
const REVERT_FAILED_ACTIVITY_KIND = "checkpoint.revert.failed";

const REWIND_TARGET_UNAVAILABLE = "The message to rewind to is no longer available.";
const REWIND_IN_PROGRESS = "A rewind is already in progress.";
const REWIND_TIMED_OUT =
  "The rewind is taking too long; the thread will update when the host finishes.";

type RewindProgress =
  | { kind: "pending" }
  | { kind: "rewound" }
  | { kind: "failed"; reason: string };

function isRevertFailure(item: ThreadItem): item is ThreadActivityItem {
  return item.kind === "activity" && item.activityKind === REVERT_FAILED_ACTIVITY_KIND;
}

/** Every rewind failure already on the thread — only a NEW one answers ours. */
function revertFailureIds(entries: readonly ThreadItem[]): Set<string> {
  return new Set(entries.filter(isRevertFailure).map((item) => item.id));
}

/** The host's reason (`payload.detail`), else the row's own summary. */
function revertFailureReason(activity: ThreadActivityItem): string {
  const payload = activity.payload;
  const detail =
    typeof payload === "object" && payload !== null
      ? (payload as { detail?: unknown }).detail
      : undefined;
  if (typeof detail === "string" && detail.trim().length > 0) {
    return detail.trim();
  }
  return activity.summary.trim().length > 0 ? activity.summary : "The rewind failed.";
}

/**
 * Where a rewind stands, read off the thread alone. The host answers a
 * `/revert` with `{seq}` long before the rollback runs (§6.2), so the command
 * settling proves nothing: the outcome is the truncation — `thread.reverted`,
 * or a snapshot, removing the message — or a new `checkpoint.revert.failed`
 * row. A message that is gone wins over a failure row: the user asked for it
 * to go, and the thread no longer holds it either way.
 */
function rewindProgress(
  entries: readonly ThreadItem[],
  messageId: string,
  knownFailureIds: ReadonlySet<string>
): RewindProgress {
  let messagePresent = false;
  let failure: ThreadActivityItem | null = null;
  for (const item of entries) {
    if (item.kind === "message") {
      messagePresent ||= item.id === messageId;
    } else if (isRevertFailure(item) && !knownFailureIds.has(item.id)) {
      failure = item;
    }
  }
  if (!messagePresent) {
    return { kind: "rewound" };
  }
  return failure === null
    ? { kind: "pending" }
    : { kind: "failed", reason: revertFailureReason(failure) };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * `backgroundLiveness` is the §3.1 registry value: `"working"` while any agent
 * work is live, `"monitoring"` only when watch loops and background shells are
 * the *only* live work, `null` otherwise. The authoritative copy rides
 * `SessionSummary` for the ambient surfaces (§6.4); the open tab derives the
 * same answer from the roster it already has rather than waiting on a bus
 * event, and the two agree because both read the same task classification.
 */
function deriveBackgroundLiveness(
  roster: readonly RuntimeSubagent[]
): "working" | "monitoring" | null {
  let liveAgents = 0;
  let liveBackground = 0;
  for (const agent of roster) {
    if (!ACTIVE_SUBAGENT_STATUSES.has(agent.status)) {
      continue;
    }
    if (agent.agentKind === "background") {
      liveBackground += 1;
    } else {
      liveAgents += 1;
    }
  }
  if (liveAgents > 0) {
    return "working";
  }
  return liveBackground > 0 ? "monitoring" : null;
}

function project(state: InternalState): InternalState {
  const timeline0 = deriveTimelineEntriesFromItems(state.slice.entries, state.timeline);
  const contextWindowEntry = latestContextWindowActivity(timeline0.activities);
  const backgroundLiveness = deriveBackgroundLiveness(state.slice.roster);
  const contextWindow = contextWindowEntry?.usage ?? null;
  const derivedReducer =
    state.slice.backgroundLiveness === backgroundLiveness &&
    sameUsage(state.slice.contextWindow, contextWindow)
      ? state.reducer
      : patchSlice(state.reducer, {
          backgroundLiveness,
          contextWindow: sameUsage(state.slice.contextWindow, contextWindow)
            ? state.slice.contextWindow
            : contextWindow
        });
  if (derivedReducer !== state.reducer) {
    state = { ...state, reducer: derivedReducer, slice: derivedReducer.slice };
  }
  const slice = state.slice;
  const timeline = timeline0;
  // `supportsConversationRollback` is the ADAPTER capability (§6.3). It is
  // read here rather than passed in so one projection covers a snapshot that
  // loads after the thread did; the store re-projects on a providers change.
  const provider = slice.head ? providerForRefId(providersStore.getState().providers, slice.head.refId) : null;
  const supportsRollback = provider ? provider.capabilities.supportsConversationRollback !== false : null;
  // Rebuilt only when their source arrays move (Q2-4) — see `derivedSets`.
  const cachedSets =
    state.derivedSets &&
    state.derivedSets.disclosures === slice.disclosures &&
    state.derivedSets.roster === slice.roster
      ? state.derivedSets
      : (() => {
          const fresh = disclosureSets(slice.disclosures);
          return {
            disclosures: slice.disclosures,
            roster: slice.roster,
            expandedTurnIds: fresh.expandedTurnIds,
            expandedGroupIds: fresh.expandedGroupIds,
            liveAgentTaskIds: liveAgentTaskIds(slice.roster) as ReadonlySet<string>
          };
        })();
  if (cachedSets !== state.derivedSets) {
    state = { ...state, derivedSets: cachedSets };
  }
  const sets = cachedSets;
  const runningTurnId = slice.head?.session.activeTurnId ?? null;
  const latestTurn = slice.turns.at(-1) ?? null;
  const isCompacting = isCompactingThread({
    activities: timeline.activities,
    sessionStatus: slice.sessionStatus,
    turnStatus: slice.turnStatus
  });
  const rowsProjection = deriveTimelineRowsWithState(
    {
      timelineEntries: timeline.entries,
      latestTurn: latestTurn
        ? {
            turnId: latestTurn.turnId,
            state: latestTurn.state,
            startedAt: latestTurn.startedAt,
            completedAt: latestTurn.completedAt
          }
        : null,
      runningTurnId,
      expandedTurnIds: sets.expandedTurnIds,
      expandedWorkGroupIds: sets.expandedGroupIds,
      isWorking:
        slice.sessionStatus === "running" ||
        slice.turnStatus === "running" ||
        slice.turnStatus === "pending",
      isCompacting,
      activeTurnStartedAt: latestTurn?.startedAt ?? latestTurn?.requestedAt ?? null,
      checkpoints: slice.checkpoints,
      // "Rewind to here" is numbered by turn order (§5.5). The fold keeps this
      // array's identity across streamed tokens, so the fast path survives.
      turns: slice.turns,
      // The adapter capability, not "a head exists": stamping `revertTurnCount`
      // on a provider that cannot roll back leaves an affordance that only a
      // second gate in the view saves (fix-wave R7-12). `null` while the
      // snapshot has not loaded means withheld, never offered-and-failing.
      supportsConversationRollback: supportsRollback ?? false,
      liveAgentTaskIds: sets.liveAgentTaskIds,
      queuedMessages: state.queue.messages
    },
    state.rowsProjection
  );
  const stableRows = computeStableRows(rowsProjection.rows, state.stableRows);
  const activities = timeline.activities;
  const activePlan = deriveActivePlanState(activities, latestTurn?.turnId ?? null);
  // The proposal the composer acts on. Recomputed here rather than in the view
  // because `timeline.proposedPlans` never leaves this module.
  const latestPlan = findLatestProposedPlan(timeline.proposedPlans, latestTurn?.turnId ?? null);
  const nextPlan = hasActionableProposedPlan(latestPlan)
    ? { id: latestPlan!.id, planMarkdown: latestPlan!.planMarkdown, turnId: latestPlan!.turnId }
    : null;
  const keptPlan =
    state.actionableProposedPlan?.id === nextPlan?.id &&
    state.actionableProposedPlan?.planMarkdown === nextPlan?.planMarkdown
      ? state.actionableProposedPlan
      : nextPlan;

  if (
    timeline === state.timeline &&
    rowsProjection === state.rowsProjection &&
    stableRows === state.stableRows &&
    activePlan === state.activePlan &&
    isCompacting === state.isCompacting &&
    cachedSets === state.derivedSets &&
    keptPlan === state.actionableProposedPlan
  ) {
    return state;
  }
  return {
    ...state,
    timeline,
    rowsProjection,
    stableRows,
    rows: stableRows.result,
    isCompacting,
    // `deriveActivePlanState` rebuilds its object each call; keep the previous
    // one when nothing about it moved, so the composer's checklist does not
    // re-render on every streamed token.
    activePlan: samePlan(state.activePlan, activePlan) ? state.activePlan : activePlan,
    actionableProposedPlan: keptPlan
  };
}

function sameUsage(
  left: ThreadTokenUsage | null,
  right: ThreadTokenUsage | null
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.usedTokens === right.usedTokens &&
    left.maxTokens === right.maxTokens &&
    left.autoCompactAtTokens === right.autoCompactAtTokens &&
    left.totalProcessedTokens === right.totalProcessedTokens &&
    left.compactsAutomatically === right.compactsAutomatically
  );
}

function samePlan(left: ActivePlanState | null, right: ActivePlanState | null): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.createdAt === right.createdAt &&
    left.turnId === right.turnId &&
    left.explanation === right.explanation &&
    left.steps.length === right.steps.length &&
    left.steps.every(
      (step, index) =>
        step.step === right.steps[index]?.step && step.status === right.steps[index]?.status
    )
  );
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export function createThreadStore(sessionId: string, deps: ThreadStoreDeps): ThreadStore {
  const newId = deps.newId ?? defaultId;
  const now = deps.now ?? (() => new Date().toISOString());
  const delay = deps.delay ?? defaultDelay;
  const maxRetries = deps.hostUnavailableRetries ?? 3;
  const positions = timelinePositionStore();

  // §6.5/§7.2: take the retained snapshot (removing it — this generation is
  // now the live copy) and claim the key, so only this generation may write it
  // back. Reading before claiming is T3's order too: `get.once(resumeAtom)`
  // then `resumeCache.owner = owner`.
  const retained = retention.take(sessionId);
  const retentionOwner = retention.claim(sessionId);

  let stream: AgentChatStreamHandle | null = null;
  let closed = false;
  /** In-flight latch for the §7.4 queue drive loop: one send per boundary. */
  let sending = false;
  /** Decided inside a zustand updater, acted on after `set` returns (Q2-9). */
  let resyncWanted = false;
  let unsubscribeProviders: (() => void) | null = null;
  /**
   * Told when this generation is destroyed. A wait on the stream — the rewind
   * waiting for its truncation — must not outlive the stream it waits on: no
   * frame will ever reach a closed store.
   */
  const destroyListeners = new Set<() => void>();

  const store = createStore<InternalState>()((set, get, storeApi) => {
    const update = (mutate: (state: InternalState) => InternalState): void => {
      set((state) => {
        const next = mutate(state);
        return next === state ? state : project(next);
      });
    };

    const setSlice = (patch: Partial<AgentChatThreadSlice>): void => {
      update((state) => {
        const reducer = patchSlice(state.reducer, patch);
        return reducer === state.reducer ? state : { ...state, reducer, slice: reducer.slice };
      });
    };

    /**
     * §6.2: `commandId` is minted by the client and is the idempotency key. A
     * 503 `HOST_UNAVAILABLE` is retried with the **same** id, which the receipt
     * makes free; anything else is surfaced.
     */
    const command = async <TName extends AgentChatCommandName>(
      name: TName,
      body: Omit<AgentChatCommandBodies[TName], "commandId">,
      commandId = newId()
    ): Promise<void> => {
      const payload = { ...body, commandId } as AgentChatCommandBodies[TName];
      await withCommandRetries(() => deps.transport.command(sessionId, name, payload));
    };

    /**
     * The retry + error-banner half of {@link command}, shared with the §3.4
     * account switch — which posts to a daemon-owned route rather than a §6.2
     * command path but carries the same `commandId` and the same envelope, so
     * it must retry on the same rules. `run` is re-invoked with the SAME body,
     * never a re-minted id.
     */
    const withCommandRetries = async (run: () => Promise<unknown>): Promise<void> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await run();
          return;
        } catch (error) {
          // §6.6: an in-flight command whose response was lost is retried with
          // the SAME `commandId`, which the receipt makes free. That covers a
          // 503 `HOST_UNAVAILABLE` and any transport-level throw — including
          // one from a custom `Transporter.agentChat()` that does not wrap its
          // failures. Only a decoded, non-retryable error envelope stops here.
          const retryable =
            error instanceof AgentChatCommandError ? error.retryable : true;
          if (retryable && attempt < maxRetries && !closed) {
            await delay(Math.min(4_000, 250 * 2 ** attempt));
            continue;
          }
          const message = errorMessage(error);
          // A banner the user already closed for this thread stays closed.
          if (!dismissedErrorBanners.has(`${sessionId}\u0000${message}`)) {
            setSlice({ errorBanner: message });
          }
          throw error;
        }
      }
    };

    const withResponding = async <T>(requestId: string, run: () => Promise<T>): Promise<T> => {
      update((state) => {
        const ids = state.slice.respondingRequestIds;
        if (ids.includes(requestId)) {
          return state;
        }
        const reducer = patchSlice(state.reducer, { respondingRequestIds: [...ids, requestId] });
        return { ...state, reducer, slice: reducer.slice };
      });
      try {
        return await run();
      } finally {
        // A failed command removes the pending marker in a `finally` (§6.6).
        update((state) => {
          const ids = state.slice.respondingRequestIds.filter((id) => id !== requestId);
          const reducer = patchSlice(state.reducer, { respondingRequestIds: ids });
          return reducer === state.reducer ? state : { ...state, reducer, slice: reducer.slice };
        });
        // Answering the last pending request lifts the queue's gate (§7.4).
        driveQueue();
      }
    };

    /**
     * The **session** phase the queue's due-check reads — not the stream's.
     *
     * `"connecting"` is T3's gap between a send and the provider picking it up,
     * so it is `starting`, or a thread with no session yet. Keying it on the
     * stream connection instead was what made the queue undeliverable: every
     * `snapshot` frame sets `connection: "connecting"` on the way to
     * `synchronized`, so a boundary arriving as a snapshot always reported
     * "connecting" and nothing was ever due (fix-wave R7-1).
     *
     * *T3: `apps/web/src/session-logic.ts:1747-1760` (`derivePhase`).*
     */
    const phase = (): QueuePhase => {
      const state = get().slice;
      if (state.sessionStatus === null || state.sessionStatus === "starting") {
        return "connecting";
      }
      if (state.sessionStatus === "stopped" || state.sessionStatus === "error") {
        return "disconnected";
      }
      if (state.sessionStatus === "running" || state.turnStatus === "running") {
        return "running";
      }
      return "ready";
    };

    /**
     * The single writer of this thread's persisted draft (`localStorage`, key
     * `orquester:agent-chat-drafts`). Empty drafts are dropped from storage by
     * `writePersistedDrafts`, so clearing is spelled as saving an empty draft.
     */
    const setDraft = (draft: ComposerDraft): void => {
      update((state) => (state.draft === draft ? state : { ...state, draft }));
      const all = readPersistedDrafts();
      all[sessionId] = draft;
      writePersistedDrafts(all);
    };

    /**
     * Return a message's content to the composer.
     *
     * **There is one visible draft, and a mounted composer owns it.** When a
     * composer is mounted for this session (W13's `composer-bridge` handle) the
     * text goes straight into it at the caret, and the composer's own
     * `saveDraft` persists it from there; with no composer mounted the text
     * merges into the persisted draft below, where the next mount loads it. A
     * queued message returned by an interrupt while the user is on another
     * tab must not be lost, and two live drafts would disagree.
     */
    const appendToDraft = (message: QueuedComposerMessage): void => {
      const handle = composerHandle(sessionId);
      if (handle) {
        insertComposerText(sessionId, message.text, "append");
        // Attachments go back as CHIPS, not into the persisted draft
        // (fix-wave R7-5). A mounted composer owns the draft and saves its own
        // whole draft back, so anything parked here behind its back is invisible
        // until its next mount and is overwritten by its next save: the file the
        // user queued would seem to vanish between Stop and the next send. Only
        // what the composer REFUSES (the attachment budget, the turn's size
        // bounds) falls back here — it is not in the tray either way, and on a
        // thread whose composer is closed the next mount finds it.
        const refused = message.attachments.filter(
          (attachment) => !stageComposerAttachment(sessionId, attachment)
        );
        if (refused.length > 0 || message.context.length > 0) {
          const draft = get().draft;
          setDraft({
            text: draft.text,
            attachments: [...draft.attachments, ...refused],
            context: [...draft.context, ...message.context]
          });
        }
        return;
      }
      const draft = get().draft;
      const text = draft.text.trim().length === 0 ? message.text : `${draft.text.trimEnd()}\n\n${message.text}`;
      setDraft({
        text,
        attachments: [...draft.attachments, ...message.attachments],
        context: [...draft.context, ...message.context]
      });
    };

    /**
     * Settle once the host has answered a `/revert`: resolve when `messageId`
     * is gone from the thread, reject on a NEW `checkpoint.revert.failed` row
     * (its reason is the error) or after {@link REWIND_TIMEOUT_MS}.
     *
     * The thread is read once synchronously before subscribing: the stream can
     * fold the truncation before the command's own response lands, and a
     * subscription only hears what happens after it. A destroyed generation
     * resolves at once — its stream is gone, so nothing could ever answer.
     */
    const waitForRewind = (
      messageId: string,
      knownFailureIds: ReadonlySet<string>
    ): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        let settled = false;
        let unsubscribe: (() => void) | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const onDestroy = (): void => finish(null);
        const finish = (failure: Error | null): void => {
          if (settled) {
            return;
          }
          settled = true;
          unsubscribe?.();
          destroyListeners.delete(onDestroy);
          if (timer !== null) {
            clearTimeout(timer);
          }
          if (failure === null) {
            resolve();
          } else {
            reject(failure);
          }
        };
        const evaluate = (entries: readonly ThreadItem[]): void => {
          const progress = rewindProgress(entries, messageId, knownFailureIds);
          if (progress.kind === "rewound") {
            finish(null);
          } else if (progress.kind === "failed") {
            finish(new Error(progress.reason));
          }
        };

        if (closed) {
          finish(null);
          return;
        }
        evaluate(get().slice.entries);
        if (settled) {
          return;
        }
        unsubscribe = storeApi.subscribe((state, previous) => {
          if (state.slice.entries !== previous.slice.entries) {
            evaluate(state.slice.entries);
          }
        });
        destroyListeners.add(onDestroy);
        timer = setTimeout(() => finish(new Error(REWIND_TIMED_OUT)), REWIND_TIMEOUT_MS);
        timer.unref?.();
      });

    const actions: AgentChatActions = {
      async sendTurn(input) {
        await command("turn", {
          input: input.text,
          ...(input.attachments ? { attachments: input.attachments } : {}),
          ...(input.context ? { context: input.context } : {}),
          interactionMode: input.interactionMode ?? get().slice.interactionMode,
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {})
        });
      },

      async steer(input) {
        await actions.sendTurn(input);
      },

      async interrupt(input) {
        // Interrupting returns EVERY queued message to the composer rather
        // than discarding it (§7.4), and it happens BEFORE the command so the
        // drain generation is already bumped when the post lands.
        actions.drainQueueToComposer();
        update((state) => ({ ...state, stopping: true }));
        const slice = get().slice;
        // The client omits `turnId` whenever the session is not `running`, so
        // a stale interrupt cannot kill the next turn and a background-only
        // stop is still valid (§6.2, §7.6).
        const turnId =
          input?.turnId ??
          (slice.sessionStatus === "running" ? (slice.head?.session.activeTurnId ?? undefined) : undefined);
        try {
          await command("interrupt", turnId === undefined ? {} : { turnId });
        } catch (error) {
          // A failed command clears the pending flag at once and surfaces the
          // error; a successful one holds it until liveness clears (§7.6).
          update((state) => ({ ...state, stopping: false }));
          throw error;
        }
      },

      async respondApproval(input) {
        await withResponding(input.requestId, () =>
          command("approval", {
            requestId: input.requestId,
            decision: input.decision as ApprovalDecision
          })
        );
      },

      async answerQuestion(input) {
        await withResponding(input.requestId, () =>
          command("answer", {
            requestId: input.requestId,
            answers: input.answers,
            ...(input.attachmentsByQuestionId
              ? { attachmentsByQuestionId: input.attachmentsByQuestionId }
              : {})
          })
        );
      },

      async dismissQuestion(input) {
        await withResponding(input.requestId, () =>
          command("dismiss", { requestId: input.requestId })
        );
      },

      async revert(input) {
        // §7.5's ONE reason the composer goes inert: while this is in flight
        // the host is rewriting the thread, and a turn sent into that race
        // lands against history that is about to stop existing. Cleared in a
        // `finally`, so a rejected revert never strands the composer (R8-M2).
        update((state) => ({ ...state, reverting: true }));
        try {
          await command("revert", { targetTurnCount: input.targetTurnCount });
        } finally {
          update((state) => ({ ...state, reverting: false }));
        }
      },

      async rewindTo(input) {
        // One at a time. A second rewind racing the first would post a second
        // `/revert`, and the one truncation would then hand the same message
        // back to the composer twice.
        if (get().reverting) {
          throw new Error(REWIND_IN_PROGRESS);
        }
        const entries = get().slice.entries;
        const target = entries.find(
          (item): item is ThreadMessageItem =>
            item.kind === "message" && item.role === "user" && item.id === input.messageId
        );
        if (target === undefined) {
          throw new Error(REWIND_TARGET_UNAVAILABLE);
        }
        // Taken BEFORE the command: the truncation that proves the rewind
        // worked is the very fold that removes the message.
        const rewound = {
          text: target.text,
          attachments: [...(target.attachments ?? [])],
          context: [...(target.context ?? [])]
        };
        const knownFailureIds = revertFailureIds(entries);
        // §7.5: inert for the WHOLE rewind, not just the post. The host answers
        // `{seq}` long before it has rewritten anything, and a turn sent in
        // between lands against history that is about to stop existing.
        update((state) => ({ ...state, reverting: true }));
        try {
          await command("revert", { targetTurnCount: input.targetTurnCount });
          await waitForRewind(input.messageId, knownFailureIds);
        } finally {
          update((state) => ({ ...state, reverting: false }));
        }
        // The message goes back for editing, as the CLI's own rewind does —
        // through the same path a queued message takes, so a mounted composer
        // gets the text and re-staged chips (the host keeps an unreferenced
        // attachment for a grace period, so they stay valid) and an unmounted
        // one finds it in the persisted draft. A generation destroyed
        // mid-wait lands here too: the outcome can no longer be observed, and
        // a copy of a message that survived is one delete away where a
        // rewound one the user asked back would be lost for good. After
        // `reverting` clears, not inside the `try`: an inert composer cannot
        // take the caret.
        appendToDraft({
          id: newId(),
          ...rewound,
          interactionMode: get().slice.interactionMode,
          queuedAfterToolActivityId: null,
          holdUntilUserAction: false,
          queuedAt: now()
        });
      },

      async compact() {
        await command("compact", {});
      },

      async backgroundTool(input) {
        await command("background", input.toolUseId ? { toolUseId: input.toolUseId } : {});
      },

      async setMode(input) {
        await command("mode", {
          ...(input.runtimeMode ? { runtimeMode: input.runtimeMode as RuntimeMode } : {}),
          ...(input.modelSelection ? { modelSelection: input.modelSelection as ModelSelection } : {})
        });
      },

      async setAccount(input) {
        // §3.4: applied on the NEXT message. Nothing is optimistic here — the
        // head's identity arrives as `thread.meta-updated` on the stream and
        // the tab's as `session.updated`, so a refusal leaves the chip exactly
        // where it was.
        const commandId = newId();
        await withCommandRetries(() =>
          deps.transport.switchAccount(sessionId, { commandId, accountId: input.accountId })
        );
      },

      async stopSession() {
        await command("session/stop", {});
      },

      async uploadAttachment(file, meta) {
        return deps.transport.upload(sessionId, file, meta);
      },

      fetchAttachmentBytes(attachmentId, signal) {
        return deps.transport.fetchAttachment(sessionId, attachmentId, signal);
      },

      queueMessage(message) {
        update((state) => {
          // The anchor is stamped HERE, not by the composer: the boundary a
          // queued message waits for is the newest completed tool call at the
          // moment it was queued, and only the store observes activities. A
          // caller that passes `null` (the composer does — it has no activity
          // feed) would otherwise flush at the very next boundary check
          // instead of the next *new* tool call (§7.4).
          const anchored =
            message.queuedAfterToolActivityId === null
              ? {
                  ...message,
                  queuedAfterToolActivityId: latestCompletedToolActivityId(
                    state.timeline.activities
                  )
                }
              : message;
          const { state: queue } = enqueue(state.queue, anchored, now, newId);
          const reducer = patchSlice(state.reducer, { queue: [...queue.messages] });
          return { ...state, queue, reducer, slice: reducer.slice };
        });
        // A message queued while the thread is already idle is due at once.
        driveQueue();
      },

      async sendQueuedNow(id) {
        const before = get().queue.drainGeneration;
        // Taking the message is computed from the current state and then
        // applied, rather than mutated inside the updater, so exactly one
        // caller can win the race for a given id.
        const current = get();
        const boundary = latestCompletedToolActivityId(current.timeline.activities);
        const taken = takeQueued(current.queue, id, boundary);
        const message = taken.message;
        if (!message) {
          return;
        }
        update((state) =>
          state.queue === current.queue
            ? (() => {
                const reducer = patchSlice(state.reducer, { queue: [...taken.state.messages] });
                return { ...state, queue: taken.state, reducer, slice: reducer.slice };
              })()
            : state
        );
        // Guard 1: a send that grabbed a message before an interrupt and
        // finished after it must detect the drain and give up, or Stop is
        // followed by a queued message starting a new turn (§7.4).
        if (get().queue.drainGeneration !== before) {
          appendToDraft(message);
          return;
        }
        try {
          await actions.sendTurn({
            text: message.text,
            attachments: message.attachments,
            context: message.context,
            interactionMode: message.interactionMode
          });
        } catch (error) {
          // Guard 2: a failed send is re-inserted at the FRONT with
          // `holdUntilUserAction`, so nothing overtakes it (§7.4).
          update((state) => {
            const queue = holdAtFront(state.queue, message);
            const reducer = patchSlice(state.reducer, { queue: [...queue.messages] });
            return { ...state, queue, reducer, slice: reducer.slice };
          });
          throw error;
        }
      },

      returnQueuedToComposer(id) {
        const result = removeQueued(get().queue, id);
        if (!result.message) {
          return;
        }
        update((state) => {
          const reducer = patchSlice(state.reducer, { queue: [...result.state.messages] });
          return { ...state, queue: result.state, reducer, slice: reducer.slice };
        });
        appendToDraft(result.message);
      },

      drainQueueToComposer() {
        const result = drainQueue(get().queue);
        if (result.messages.length === 0) {
          return;
        }
        update((state) => {
          const reducer = patchSlice(state.reducer, { queue: [] });
          return { ...state, queue: result.state, reducer, slice: reducer.slice };
        });
        for (const message of result.messages) {
          appendToDraft(message);
        }
      },

      setInteractionMode(mode: InteractionMode) {
        setSlice({ interactionMode: mode });
        const remembered = positions.read(sessionId);
        if (remembered) {
          positions.remember(sessionId, { ...remembered, interactionMode: mode });
        }
      },

      setFollow(follow) {
        setSlice({ follow });
      },

      setDisclosure(patch: Partial<DisclosureState>) {
        update((state) => {
          const disclosures = { ...state.slice.disclosures, ...patch };
          const reducer = patchSlice(state.reducer, { disclosures });
          return reducer === state.reducer ? state : { ...state, reducer, slice: reducer.slice };
        });
        // The LRU remembers the shape of the page as well as the position, so
        // a disclosure change is written straight through (§7.2).
        const slice = get().slice;
        positions.remember(sessionId, {
          ...(slice.scroll ?? DEFAULT_SCROLL_POSITION),
          disclosures: slice.disclosures,
          interactionMode: slice.interactionMode
        });
      },

      rememberScroll(position) {
        // Computed in the updater, persisted after `set` returns: an updater
        // that writes `localStorage` is not replay-safe (fix-wave Q2-9).
        let remembered: RememberedTimelinePosition | null = null;
        update((state) => {
          const next: RememberedTimelinePosition = {
            ...(state.slice.scroll ?? DEFAULT_SCROLL_POSITION),
            ...position,
            // Never let a caller's stale copy overwrite live client state.
            disclosures: state.slice.disclosures,
            interactionMode: state.slice.interactionMode
          };
          remembered = next;
          const reducer = patchSlice(state.reducer, { scroll: next, follow: next.atEnd });
          return reducer === state.reducer ? state : { ...state, reducer, slice: reducer.slice };
        });
        if (remembered !== null) {
          positions.remember(sessionId, remembered);
        }
      },

      /**
       * Persist what the composer has not sent, for this thread (§7.4).
       *
       * The composer calls this on every change (debounced) and synchronously
       * before it unmounts or swaps threads, so the draft outlives the
       * component: switching to a project whose tabs unmount this one, or
       * reloading the page, must not cost a half-typed message.
       */
      saveDraft(draft) {
        setDraft(draft);
      },
      dismissErrorBanner() {
        // §7.3: a dismissal is remembered per `(threadId, message)` for the
        // session, so navigating away and back cannot resurrect a banner the
        // user closed — while a DIFFERENT error still can.
        const message = get().slice.errorBanner;
        if (message !== null) {
          dismissedErrorBanners.add(`${sessionId}\u0000${message}`);
        }
        setSlice({ errorBanner: null });
      },

      async refresh() {
        const response = await deps.transport.read(sessionId);
        if (response.kind === "snapshot") {
          applyStreamFrame({ kind: "snapshot", thread: response.thread });
          return;
        }
        for (const event of response.events) {
          applyStreamFrame({ kind: "event", seq: event.seq, event });
        }
      }
    };

    const applyStreamFrame: (frame: Parameters<typeof applyFrame>[1]) => void = (frame) => {
      // §7.7: when an open chat tab's stream delivers `thread.turn-diff-completed`
      // the client refreshes the git tab for that project. No new bus event is
      // introduced for it (§6.4) — the thread stream already knows.
      if (frame.kind === "event" && frame.event.type === "thread.turn-diff-completed") {
        const projectPath = get().slice.head?.projectPath;
        if (projectPath) {
          nudgeProjectGit(projectPath);
        }
      }
      update((state) => {
        // §6.3/§8: a different host instance id means re-read, not resume.
        // Decided inside the updater, performed after `set` returns: a zustand
        // updater must be pure, or a replay double-fires the read (Q2-9).
        resyncWanted ||= needsResync(state.reducer.hostInstanceId, frame);
        const reducer = applyFrame(state.reducer, frame);
        if (reducer === state.reducer) {
          return state;
        }
        // A `snapshot` replaces loaded history, so every projection cached
        // against the old one is invalidated by the epoch rather than trusted
        // to self-heal (fix-wave Q2-7). The queue survives — it is the user's
        // live intent — and so do drafts, disclosures and scroll.
        if (reducer.historyEpoch !== state.reducer.historyEpoch) {
          return {
            ...state,
            reducer,
            slice: reducer.slice,
            timeline: EMPTY_TIMELINE_PROJECTION,
            rowsProjection: null,
            stableRows: EMPTY_STABLE_ROWS,
            derivedSets: null
          };
        }
        return { ...state, reducer, slice: reducer.slice };
      });
      if (resyncWanted) {
        resyncWanted = false;
        // A changed host instance id means re-read, not resume; the transport's
        // own sequence floor is reset with it so a host that restarted its
        // sequence space lower cannot have its live frames suppressed (Q2-8).
        stream?.resetCursor();
        void actions.refresh().catch(() => {
          /* the stream's own reconnect will try again */
        });
      }
      // The Stop button reads "Stopping…" until `backgroundLiveness` clears,
      // not until the command returns: an accepted interrupt is not yet a dead
      // process (§7.6).
      const state = get();
      if (
        state.stopping &&
        state.slice.backgroundLiveness === null &&
        latestTurnSettled(state.slice)
      ) {
        set({ stopping: false });
      }
      driveQueue();
    };

    /**
     * **The queue's drive loop** (§7.4).
     *
     * The ghost bubble promises "sends after the next tool call or when the
     * turn ends"; something has to keep that promise. Every state change that
     * could move a boundary — a stream frame, a command settling, a request
     * opening or closing — re-evaluates the head of the queue and dispatches
     * **exactly one** message. Taking it re-anchors the rest, so the next
     * boundary sends the next one rather than the whole queue draining at once.
     *
     * `sending` is the in-flight latch: without it a burst of frames would
     * dispatch the same head twice (`takeQueued` would answer `null` for the
     * second, but the send path would still have run).
     *
     * *T3: `apps/web/src/components/ChatView.tsx:8604-8642` — the same loop and
     * the same pending-request gates.*
     */
    const driveQueue = (): void => {
      if (sending || closed) {
        return;
      }
      const state = get();
      const due = nextDueQueuedMessage(state.queue, {
        phase: phase(),
        latestToolActivityId: latestCompletedToolActivityId(state.timeline.activities),
        // Nothing flushes while an approval or a question is pending (§7.4).
        hasPendingRequests:
          state.slice.pending.approvals.length + state.slice.pending.userInputs.length > 0
      });
      if (!due) {
        return;
      }
      sending = true;
      void actions
        .sendQueuedNow(due.id)
        .catch(() => {
          /* `sendQueuedNow` already held it at the front and banner'd it. */
        })
        .finally(() => {
          sending = false;
          // A boundary may have moved while this send was in flight; re-check
          // once rather than waiting for the next frame.
          driveQueue();
        });
    };

    // A provider snapshot arriving after the thread did changes one row input
    // (`supportsConversationRollback`), so re-project when the catalog moves.
    unsubscribeProviders = providersStore.subscribe((next, previous) => {
      if (next.providers !== previous.providers) {
        update((state) => ({ ...state }));
      }
    });

    const warm = retained ? cachedThreadState(retained.state) : null;
    const initialReducer = warm
      ? warm.reducer
      : (() => {
          const reducer = createReducerState(sessionId);
          const remembered = positions.read(sessionId);
          return remembered
            ? patchSlice(reducer, {
                scroll: remembered,
                disclosures: remembered.disclosures,
                interactionMode: remembered.interactionMode,
                follow: remembered.atEnd
              })
            : reducer;
        })();

    /**
     * **Resume by cursor, never re-download.** A warm remount asks the host for
     * `events?after=<retained seq>`; the host answers with the deltas, or — if
     * that cursor is unusable (above its head, too large a range, a truncated
     * log, a different host) — with a full `snapshot` frame, which
     * `applyFrame` treats as a history replacement and the projections are
     * invalidated by the epoch. Either way nothing empty is ever painted.
     *
     * *T3: `threads.ts:823-841` — `...(canResume ? { afterSequence: sequence } : {})`.*
     */
    const resumeOptions: AgentChatStreamOptions =
      retained !== null && retained.sequence > 0
        ? { after: retained.sequence, hostInstanceId: initialReducer.hostInstanceId }
        : {};

    // The store is created with its stream already wired, so `open()` is not a
    // separate step a caller can forget.
    queueMicrotask(() => {
      if (closed) {
        return;
      }
      stream = deps.transport.stream(
        sessionId,
        resumeOptions,
        {
          onFrame: applyStreamFrame,
          onOpen: () => {
            if (get().slice.connection === "idle") {
              setSlice({ connection: "connecting" });
            }
          },
          onReconnect: () => setSlice({ connection: "reconnecting" }),
          onError: () => setSlice({ connection: "error" })
        }
      );
    });

    return {
      reducer: initialReducer,
      slice: initialReducer.slice,
      queue: warm?.queue ?? EMPTY_QUEUE,
      timeline: warm?.timeline ?? EMPTY_TIMELINE_PROJECTION,
      rowsProjection: warm?.rowsProjection ?? null,
      stableRows: warm?.stableRows ?? EMPTY_STABLE_ROWS,
      derivedSets: warm?.derivedSets ?? null,
      rows: warm?.rows ?? [],
      isCompacting: warm?.isCompacting ?? false,
      activePlan: warm?.activePlan ?? null,
      actionableProposedPlan: warm?.actionableProposedPlan ?? null,
      // An in-flight command belonged to the generation that is gone.
      reverting: false,
      draft: readPersistedDrafts()[sessionId] ?? EMPTY_DRAFT,
      stopping: false,
      actions
    };
  });

  // Expose the teardown on the store object so the registry can call it.
  // `retain: false` is the "drop it for good" path (`resetThreadStores`).
  (store as ThreadStore & { destroy?: (options?: { retain?: boolean }) => void }).destroy = (
    options
  ) => {
    closed = true;
    stream?.close();
    stream = null;
    unsubscribeProviders?.();
    unsubscribeProviders = null;
    // The live subscription is gone; the VALUE survives for the idle TTL so a
    // remount paints it instantly and resumes by cursor (§6.5, §7.2). Refused
    // outright when a newer generation already claimed this key.
    if (options?.retain !== false) {
      retention.retain(sessionId, retentionOwner, retainableFrom(store.getState()));
    }
    // A wait on the stream settles now rather than at its timeout: no frame
    // will ever reach this generation again.
    for (const listener of [...destroyListeners]) {
      listener();
    }
    destroyListeners.clear();
  };

  return store;
}

/**
 * Thread-level error banners the user closed, keyed `threadId\0message`
 * (§7.3). Session-scoped and module-level on purpose: it must survive the
 * slice being dropped and re-created by a tab switch, which is exactly the
 * navigation that would otherwise resurrect the banner.
 */
const dismissedErrorBanners = new Set<string>();

/** Test seam. */
export function resetDismissedErrorBanners(): void {
  dismissedErrorBanners.clear();
}

function errorMessage(error: unknown): string {
  if (error instanceof AgentChatCommandError) {
    return error.message;
  }
  return error instanceof Error ? error.message : "The command failed.";
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

interface RegistryEntry {
  store: ThreadStore;
  /** Effect-held references only. A render-created entry starts at 0. */
  refCount: number;
  disposeTimer: ReturnType<typeof setTimeout> | null;
}

const registry = new Map<string, RegistryEntry>();

/**
 * How long an unreferenced slice lingers before its stream is closed.
 *
 * Two reasons it is not zero. §7.1: one `AgentChatView` serves every chat tab
 * in a project, and the outgoing thread's rows keep painting until the next
 * thread's snapshot lands — tearing its stream down on the same tick would
 * make a tab switch flash. And React's StrictMode mounts, unmounts and
 * re-mounts an effect in development; a zero grace would close and re-open
 * every stream on every mount.
 */
// A short grace, because the LIVE subscription is the expensive half and T3
// gives it TTL 0 — released as soon as its last consumer leaves. What makes a
// return to a recently-viewed tab instant is not a stream held open for
// fifteen minutes (this constant's previous value, a stopgap) but the
// value-only retained snapshot in `retention.ts`: the fold survives the
// teardown for its own 5-minute idle TTL, a remount paints it before anything
// is fetched, and the fresh stream resumes with `after=<retained seq>`.
//
// *T3: `packages/client-runtime/src/state/threads.ts:917-950` — the resume
// family carries `setIdleTTL(THREAD_SNAPSHOT_IDLE_TTL_MS)`, the live state
// family `setIdleTTL(0)`.*
export const THREAD_STORE_DISPOSE_GRACE_MS = 2_000;

/** The retained snapshot's idle TTL, re-exported for callers that report it. */
export { THREAD_SNAPSHOT_IDLE_TTL_MS };

function scheduleDispose(sessionId: string, entry: RegistryEntry): void {
  if (entry.disposeTimer !== null) {
    return;
  }
  entry.disposeTimer = setTimeout(() => {
    const current = registry.get(sessionId);
    if (!current || current !== entry || current.refCount > 0) {
      return;
    }
    registry.delete(sessionId);
    (current.store as ThreadStore & { destroy?: () => void }).destroy?.();
  }, THREAD_STORE_DISPOSE_GRACE_MS);
  entry.disposeTimer.unref?.();
}

function cancelDispose(entry: RegistryEntry): void {
  if (entry.disposeTimer !== null) {
    clearTimeout(entry.disposeTimer);
    entry.disposeTimer = null;
  }
}

/**
 * Get (or create) a thread's slice **without** taking a reference. Safe to
 * call during render: a slice nobody retains is disposed after the grace
 * period rather than leaking a stream.
 */
export function ensureThreadStore(sessionId: string, deps: ThreadStoreDeps): ThreadStore {
  const existing = registry.get(sessionId);
  if (existing) {
    if (existing.refCount === 0) {
      cancelDispose(existing);
      scheduleDispose(sessionId, existing);
    }
    return existing.store;
  }
  const entry: RegistryEntry = {
    store: createThreadStore(sessionId, deps),
    refCount: 0,
    disposeTimer: null
  };
  registry.set(sessionId, entry);
  scheduleDispose(sessionId, entry);
  return entry.store;
}

/** Take a reference (a mounted effect). Cancels any pending disposal. */
export function retainThreadStore(sessionId: string, deps: ThreadStoreDeps): ThreadStore {
  const store = ensureThreadStore(sessionId, deps);
  const entry = registry.get(sessionId)!;
  entry.refCount += 1;
  cancelDispose(entry);
  return store;
}

/** Drop a reference; the slice and its stream go once the grace elapses (§7.2). */
export function releaseThreadStore(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (!entry) {
    return;
  }
  entry.refCount = Math.max(0, entry.refCount - 1);
  if (entry.refCount === 0) {
    scheduleDispose(sessionId, entry);
  }
}

/** The live slice for a session, if any. For surfaces that must not open one. */
export function peekThreadStore(sessionId: string): ThreadStore | null {
  return registry.get(sessionId)?.store ?? null;
}

/** Test seam: drop every slice immediately, retained snapshots included. */
export function resetThreadStores(): void {
  for (const [sessionId, entry] of [...registry.entries()]) {
    cancelDispose(entry);
    registry.delete(sessionId);
    (
      entry.store as ThreadStore & { destroy?: (options?: { retain?: boolean }) => void }
    ).destroy?.({ retain: false });
  }
  retention.clear();
}

export type { AttachmentRef, ComposerContextRecord, InteractionMode };
export { DEFAULT_INTERACTION_MODE };
