/**
 * Agent chat — the per-thread zustand slice (spec §7.2, §6.6).
 *
 * **A zustand slice per open thread, created on tab open and dropped on tab
 * close.** Closed tabs keep nothing; the tab strip reads only
 * `SessionSummary`. The slices are held in a refcounted registry: each chat
 * tab owns its `AgentChatView` (the placement note there — `MainView` mounts
 * one per tab and only hides the inactive ones), every consumer of a thread
 * shares its one slice and stream, and a slice its last consumer let go of — a
 * project switch unmounts the whole tab set — lingers for a short grace before
 * it is torn down.
 *
 * **Server-authoritative, cursor-ordered** (§6.6): every mutation is a command
 * answered with `{seq}`; sends, approvals, answers and interrupts have **no**
 * optimistic path — the user's message appears when its event arrives. The one
 * narrow optimistic rule (tab-local reorder/rename) lives in the app store, not
 * here.
 *
 * **Older history rides the slice too** (design 2026-09-23): the pages the
 * user paged in, and the bridge of rows the window evicted since, projected
 * above the window's own rows (`history.logic.ts`). The bridge is the one part
 * that grows on its own, so this is where its cap is held and where a bridge
 * past it asks for fresh bounds.
 *
 * No React import — `hooks.ts` is the only React file in this package.
 */

import { createStore, type StoreApi } from "zustand/vanilla";

import {
  ACTIVE_SUBAGENT_STATUSES,
  DEFAULT_INTERACTION_MODE,
  messageStreamingContext,
  THREAD_HISTORY_DEFAULT_TURNS,
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
  AgentChatHistoryState,
  AgentChatRevealRequest,
  AgentChatThreadSlice,
  AgentChatThreadView,
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
  canLoadOlderHistory,
  collectHistoryItems,
  EMPTY_HISTORY_ITEMS,
  EMPTY_HISTORY_ROWS,
  EMPTY_LIVE_SPLIT,
  hasSettledCompaction,
  HISTORY_REVEAL_PAGE_CAP,
  HISTORY_ROW_CAP,
  historyErrorMessage,
  historyWithinCap,
  historyWithPage,
  isStartedTurn,
  liveTurnIdsOf,
  mergeTimelineRows,
  nextHistoryCursor,
  planReveal,
  projectHistoryRows,
  rowIdForTurn,
  splitLiveItems,
  userMessageIdForTurn,
  withoutOrphanBridge,
  type HistoryItemsState,
  type HistoryRowsState,
  type LiveSplit
} from "./history.logic";
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
  withConnection,
  type AgentChatReducerState
} from "./reducer.logic";
import {
  computeStableRows,
  deriveTimelineRowsWithState,
  deriveUnsettledTurnId,
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
  insertComposerText,
  restoreComposerFailedSend,
  returnComposerMessage
} from "../../components/agent-chat/composer/composer-bridge";
import type { StagedAttachment } from "../../components/agent-chat/composer/ComposerAttachments";
import {
  persistedDraftAfterReturn,
  persistedDraftAfterSend,
  storedChip
} from "../../components/agent-chat/composer/composer-draft";
import {
  adoptOutboxLeftovers,
  holdOutboxQueuedAtFront,
  outboxQueue,
  outboxQueueFresh,
  outboxQueueShownAt,
  outboxReplayable,
  recordOutboxQueuedPost,
  recordOutboxSend,
  removeOutboxEntry,
  stampOutboxQueueShown,
  writeOutboxQueue,
  type OutboxQueued,
  type OutboxQueuedMessage,
  type OutboxSend,
  type OutboxTurn
} from "../../components/agent-chat/composer/composer-outbox";
import {
  beginComposerSend,
  beginQueuedSend,
  isQueuedSendInFlight,
  subscribeQueuedSends
} from "../../components/agent-chat/composer/composer-sends";
import type { FailedSendRestore } from "../../components/agent-chat/composer/composer-submission";
import { nudgeProjectGit } from "../../components/git/git-watch";
import { composerTextForDelivery } from "../composer-inbox";
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
  /**
   * The most rows the history's pages and bridge may hold together
   * ({@link HISTORY_ROW_CAP}). Injected in tests, which cannot stream twenty
   * thousand evictions to reach the real one.
   */
  historyRowCap?: number;
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

/** Store one thread's draft under its id, leaving every other thread's as it is. */
function persistDraft(sessionId: string, draft: ComposerDraft): void {
  const all = readPersistedDrafts();
  all[sessionId] = draft;
  writePersistedDrafts(all);
}

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
  actionableProposedPlan: AgentChatThreadView["actionableProposedPlan"];
  /**
   * True while a `/revert` is in flight — for `rewindTo`, until the host has
   * answered it on the stream; §7.5's one reason the composer goes inert.
   */
  reverting: boolean;
  /** The composer's persisted draft for this thread. */
  draft: ComposerDraft;
  /** True while an interrupt is in flight; the Stop button reads "Stopping…". */
  stopping: boolean;
  /**
   * The turn the timeline should bring on screen (the command palette's
   * search hit), until it acknowledges the nonce. Never retained: a remount
   * must not replay a scroll the user has already been given.
   */
  reveal: AgentChatRevealRequest | null;
  actions: AgentChatActions;
}

interface InternalState extends AgentChatThreadState {
  reducer: AgentChatReducerState;
  queue: QueueState;
  timeline: ThreadTimelineProjection;
  rowsProjection: TimelineRowsProjection | null;
  stableRows: StableRowsState;
  /**
   * Every loaded history page's items and the bridge as one list, memoised
   * by the `pages` and `bridge` arrays (design 2026-09-23 "Client", and fold
   * performance "Client — the history bridge").
   */
  historyItems: HistoryItemsState;
  /**
   * The window's items split against the history: an item a page or the
   * bridge also holds renders at the HISTORY's position with the window's
   * content, and so does every window item before the window cut; all of
   * them leave the window's own rows. Untouched while nothing is loaded.
   */
  liveSplit: LiveSplit;
  /**
   * The layer-1 projection the window's ROWS are built from: `timeline`
   * itself while the window shares nothing with a page, else the same
   * projection over `liveSplit.rowItems`. Everything else the window derives
   * (the context meter, plans, the compaction phase, the queue's boundary)
   * still reads the whole `timeline`.
   */
  rowTimeline: ThreadTimelineProjection;
  /**
   * The loaded history's rows, projected together and memoised (design
   * 2026-09-23 "Client"). Kept beside the window's own layers rather than
   * inside them, so the window's streaming fast path is exactly what it is
   * without history.
   */
  historyRows: HistoryRowsState;
  /**
   * What `rows` was merged from. The merge is redone only when either side
   * moved, so an update that touches neither (a flag, a draft) never hands
   * the timeline a new array.
   */
  rowsSource: { history: HistoryRowsState; live: readonly AgentChatTimelineRow[] };
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
 * in-flight command flags `reverting`/`stopping` (an in-flight command's
 * settle lands in the destroyed generation, never in the next one; the
 * composer's own send state lives in `composer-sends.ts`, outside every
 * generation), and the composer draft (already persisted, and read back on
 * construction). Those are the fields T3's `cachedThreadState` normalises away
 * for the same reason — and so, on the slice itself, is the one in-flight set
 * that rides it, `respondingRequestIds` (see {@link cachedThreadState}).
 */
export interface RetainedThreadState {
  reducer: AgentChatReducerState;
  queue: QueueState;
  timeline: ThreadTimelineProjection;
  rowsProjection: TimelineRowsProjection | null;
  stableRows: StableRowsState;
  derivedSets: InternalState["derivedSets"];
  /** The history's cached layers — a remount paints them without re-deriving. */
  historyItems?: HistoryItemsState;
  liveSplit?: LiveSplit;
  rowTimeline?: ThreadTimelineProjection;
  historyRows?: HistoryRowsState;
  rowsSource?: InternalState["rowsSource"];
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
 * generation that no longer exists. So is a history load's spinner, for the
 * same reason — the `GET …/history` that set it belonged to that generation
 * and will never settle this one; the loaded pages themselves are kept, and
 * so is their bridge — only a bridge begun for a FIRST page that will now
 * never land goes (`withoutOrphanBridge`). And so are the requests with a
 * decision or an answer in flight (`respondingRequestIds`): that command's
 * `finally` clears them in the generation that posted it, never in this one,
 * so carried over they would lock the request's card here for good.
 *
 * *T3: `packages/client-runtime/src/state/threads.ts:161-176`
 * (`cachedThreadState`).*
 */
export function cachedThreadState(retained: RetainedThreadState): RetainedThreadState {
  const slice = retained.reducer.slice;
  const connection =
    slice.connection === "synchronized" && slice.head !== null ? "synchronized" : "idle";
  const history = slice.history.loading
    ? withoutOrphanBridge({ ...slice.history, loading: false })
    : slice.history;
  const reducer = patchSlice(retained.reducer, {
    connection,
    errorBanner: null,
    history,
    ...(slice.respondingRequestIds.length > 0 ? { respondingRequestIds: [] } : {})
  });
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
      historyItems: state.historyItems,
      liveSplit: state.liveSplit,
      rowTimeline: state.rowTimeline,
      historyRows: state.historyRows,
      rowsSource: state.rowsSource,
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

/**
 * How long a reveal waits for the thread's stream to synchronize before it
 * plans against whatever snapshot there is. The palette opens the tab first,
 * so a cold thread is usually mid-connect when the reveal starts.
 */
export const REVEAL_SYNC_TIMEOUT_MS = 10_000;

type RewindProgress =
  | { kind: "pending" }
  | { kind: "rewound" }
  | { kind: "failed"; reason: string };

function isRevertFailure(item: ThreadItem): item is ThreadActivityItem {
  return item.kind === "activity" && item.activityKind === REVERT_FAILED_ACTIVITY_KIND;
}

/** Whether a loaded history page, or the bridge, still holds `messageId`. */
function inLoadedHistory(history: AgentChatHistoryState, messageId: string): boolean {
  return (
    history.bridge.some((item) => item.id === messageId) ||
    history.pages.some((page) => page.items.some((item) => item.id === messageId))
  );
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
  knownFailureIds: ReadonlySet<string>,
  /** The message is still on a loaded history page or the bridge (design 2026-09-23). */
  inHistory = false
): RewindProgress {
  let messagePresent = inHistory;
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
  // An item a loaded history page or the bridge also holds renders at the
  // history's position (design 2026-09-23 "Client"), and so does every window
  // item before the window cut, so the window's rows are built from what the
  // window alone holds after it. With nothing loaded none of this runs: the
  // window's rows read `timeline` exactly as they always did.
  const historyItems = collectHistoryItems(
    state.historyItems,
    slice.history.pages,
    slice.history.bridge
  );
  const liveSplit =
    historyItems.ids.size === 0
      ? EMPTY_LIVE_SPLIT
      : splitLiveItems(state.liveSplit, slice.entries, historyItems, slice.history.windowCut);
  const rowTimeline =
    historyItems.ids.size === 0 || liveSplit.rowItems === slice.entries
      ? timeline
      : deriveTimelineEntriesFromItems(liveSplit.rowItems, state.rowTimeline);
  const runningTurnId = slice.head?.session.activeTurnId ?? null;
  // Whether a message can still be streaming: the rule, never the bare flag a
  // dead host or an unclosed agent left `true` for good. Memoised by the
  // roster and the session, so a streamed token keeps the rows' fast path.
  const messageStreaming = messageStreamingContext(slice);
  const latestTurn = slice.turns.at(-1) ?? null;
  const latestTurnSummary = latestTurn
    ? {
        turnId: latestTurn.turnId,
        state: latestTurn.state,
        startedAt: latestTurn.startedAt,
        completedAt: latestTurn.completedAt
      }
    : null;
  const isWorking =
    slice.sessionStatus === "running" ||
    slice.turnStatus === "running" ||
    slice.turnStatus === "pending";
  const activeTurnStartedAt = latestTurn?.startedAt ?? latestTurn?.requestedAt ?? null;
  const isCompacting = isCompactingThread({
    activities: timeline.activities,
    sessionStatus: slice.sessionStatus,
    turnStatus: slice.turnStatus
  });
  // The timeline's last prompt sits in the history — a running turn so long
  // its early rows went there — when the window's own rows hold none: the
  // turn's "Working…" header then follows that prompt up there.
  const activeTurnHeaderInHistory =
    historyItems.ids.size > 0 &&
    !liveSplit.rowsHavePrompt &&
    (historyItems.hasPrompt || liveSplit.sharedHavePrompt);
  // The loaded history pages and the bridge sit ABOVE the window (design
  // 2026-09-23 "Client"): projected together through the same row derivation,
  // and merged in with the window winning any id both project. With nothing
  // loaded both calls hand their input straight back. A running turn's rows
  // up there render live, exactly as the window renders that turn.
  const historyRows = projectHistoryRows(state.historyRows, {
    history: historyItems,
    sharedLive: liveSplit.shared,
    expandedTurnIds: sets.expandedTurnIds,
    expandedWorkGroupIds: sets.expandedGroupIds,
    turns: slice.turns,
    supportsConversationRollback: supportsRollback ?? false,
    // The window's OWN rows: a compaction marker the pages hold too is theirs
    // to gate, by position, like any other history row.
    liveCompacted: historyItems.ids.size > 0 && hasSettledCompaction(rowTimeline.workEntries),
    unsettledTurnId: deriveUnsettledTurnId(latestTurnSummary, runningTurnId),
    isWorking,
    isCompacting,
    activeTurnStartedAt,
    activeTurnHeaderHere: activeTurnHeaderInHistory,
    liveAgentTaskIds: sets.liveAgentTaskIds,
    messageStreaming
  });
  const rowsProjection = deriveTimelineRowsWithState(
    {
      timelineEntries: rowTimeline.entries,
      latestTurn: latestTurnSummary,
      runningTurnId,
      expandedTurnIds: sets.expandedTurnIds,
      expandedWorkGroupIds: sets.expandedGroupIds,
      isWorking,
      isCompacting,
      activeTurnStartedAt,
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
      messageStreaming,
      queuedMessages: state.queue.messages,
      // Split with the history above: where the running turn's header went,
      // and whether a live row up there already shows the turn working.
      activeTurnHeader: activeTurnHeaderInHistory ? "above" : "here",
      liveActivityAbove: historyRows.hasActivityRow
    },
    state.rowsProjection
  );
  const stableRows = computeStableRows(rowsProjection.rows, state.stableRows);
  const rowsSource =
    state.rowsSource.history === historyRows && state.rowsSource.live === stableRows.result
      ? state.rowsSource
      : { history: historyRows, live: stableRows.result };
  const rows =
    rowsSource === state.rowsSource ? state.rows : mergeTimelineRows(historyRows, stableRows.result);
  const activities = timeline.activities;
  const activePlan = deriveActivePlanState(activities, latestTurn?.turnId ?? null);
  // The proposal the composer acts on. Recomputed here rather than in the view
  // because `timeline.proposedPlans` never leaves this module.
  const latestPlan = findLatestProposedPlan(timeline.proposedPlans, latestTurn?.turnId ?? null);
  const nextPlan = hasActionableProposedPlan(latestPlan)
    ? {
        id: latestPlan!.id,
        planMarkdown: latestPlan!.planMarkdown,
        turnId: latestPlan!.turnId,
        ...(latestPlan!.truncated ? { truncated: true as const } : {})
      }
    : null;
  const keptPlan =
    state.actionableProposedPlan?.id === nextPlan?.id &&
    state.actionableProposedPlan?.planMarkdown === nextPlan?.planMarkdown &&
    state.actionableProposedPlan?.truncated === nextPlan?.truncated
      ? state.actionableProposedPlan
      : nextPlan;

  if (
    timeline === state.timeline &&
    rowsProjection === state.rowsProjection &&
    stableRows === state.stableRows &&
    historyItems === state.historyItems &&
    liveSplit === state.liveSplit &&
    rowTimeline === state.rowTimeline &&
    historyRows === state.historyRows &&
    rows === state.rows &&
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
    historyItems,
    liveSplit,
    rowTimeline,
    historyRows,
    rowsSource,
    rows,
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
// Commands (§6.2, §6.6)
// ---------------------------------------------------------------------------

/**
 * How long one attempt of a command may go unanswered before it is aborted
 * and retried with the SAME `commandId` (§6.6). Longer than the daemon's own
 * 20 s socket-idle timeout to the host (`HOST_REQUEST_TIMEOUT_MS`), which
 * answers a hung host with a 503 first: this bounds what the daemon cannot —
 * a connection that went half-open between the browser and the daemon — so
 * no send can hold its thread "Sending" for longer than its retry budget.
 */
export const COMMAND_ATTEMPT_TIMEOUT_MS = 25_000;

const COMMAND_TIMED_OUT = "The agent host did not answer in time.";

/**
 * The commands whose retries outlive their store generation (§7.4). A turn
 * and an answer are the user's own words, and a lost response of either may
 * be one the host already accepted: giving up when the tab's slice was torn
 * down — 2 s after a project switch unmounted it — turned it into a failed
 * send the user sent again, a duplicate turn. The receipt makes the retry
 * free whether or not anyone still shows the thread.
 */
const RETRIED_PAST_TEARDOWN: ReadonlySet<AgentChatCommandName> = new Set<AgentChatCommandName>([
  "turn",
  "answer"
]);

/**
 * Why a send a reload left behind is back, unsent, rather than re-posted: it
 * is past `OUTBOX_REPLAY_MAX_AGE_MS`, so the host may no longer know its
 * `commandId` — it may have landed, and a re-post would send it twice.
 */
const STALE_SEND_NOTICE =
  "This message was on its way when the page reloaded, too long ago to send it again safely — check the thread before sending it.";

/**
 * Why a queued message that came back waits for its Send now: nobody had seen
 * its queue for longer than `OUTBOX_QUEUE_ABSENCE_MAX_MS`, so it does not go
 * out by itself on the thread's first frame (§7.4).
 */
const QUEUE_AWAY_NOTICE =
  "These queued messages were last on screen more than ten minutes ago, so they wait for Send now instead of going out by themselves.";

/** A send a reload left behind that did not go through on its re-post: said as such, then why. */
const repostFailedNotice = (reason: string): string =>
  `This message was on its way when the page reloaded, and it did not go through: ${reason}`;

/**
 * A queued message coming back — after a reload, or into a generation that
 * starts from the queue its page kept — as it may be shown: held, with the
 * reason it waits, once its queue has been neither on screen nor driven by a
 * live page for longer than `OUTBOX_QUEUE_ABSENCE_MAX_MS`
 * (`outboxQueueFresh`); as it was otherwise. A message already held keeps its
 * own reason.
 */
function heldIfUnseen(
  message: QueuedComposerMessage,
  shownAt: number | null,
  now: number
): QueuedComposerMessage {
  if (message.holdUntilUserAction || outboxQueueFresh({ shownAt, queuedAt: message.queuedAt, now })) {
    return message;
  }
  return { ...message, holdUntilUserAction: true, holdReason: QUEUE_AWAY_NOTICE };
}

/** Why the first held message of a queue waits, for the thread's banner. */
function firstHoldReason(messages: readonly QueuedComposerMessage[]): string | null {
  return messages.find((message) => message.holdUntilUserAction && message.holdReason)?.holdReason ?? null;
}

/**
 * One attempt of a command, bounded by {@link COMMAND_ATTEMPT_TIMEOUT_MS}:
 * past it the request is aborted and the attempt fails as a lost response
 * (status 0, retryable). Raced rather than left to the signal alone, so a
 * transport that ignores the abort is bounded too.
 */
function attemptCommand(run: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
  const controller = new AbortController();
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new AgentChatCommandError(0, "HOST_UNAVAILABLE", COMMAND_TIMED_OUT));
    }, COMMAND_ATTEMPT_TIMEOUT_MS);
    timer.unref?.();
    // Whichever settles first wins; the other is a no-op on a settled promise.
    try {
      Promise.resolve(run(controller.signal)).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    } catch (error) {
      // A transport that throws before its first `await` fails the attempt the same way.
      clearTimeout(timer);
      reject(error);
    }
  });
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** A generation's hook for the thread's other generations (§7.4) — see `holdQueuedMessageInThread`. */
type HoldingThreadStore = ThreadStore & {
  holdQueuedAtFront?: (
    message: QueuedComposerMessage,
    reason?: string,
    behind?: ReadonlySet<string>
  ) => void;
};

export function createThreadStore(sessionId: string, deps: ThreadStoreDeps): ThreadStore {
  const newId = deps.newId ?? defaultId;
  const now = deps.now ?? (() => new Date().toISOString());
  const delay = deps.delay ?? defaultDelay;
  const maxRetries = deps.hostUnavailableRetries ?? 3;
  const historyRowCap = deps.historyRowCap ?? HISTORY_ROW_CAP;
  const positions = timelinePositionStore();
  /** Epoch ms on the injected clock: when a send left, as the tab's outbox measures it. */
  const clock = (): number => {
    const at = Date.parse(now());
    return Number.isFinite(at) ? at : Date.now();
  };

  // §6.5/§7.2: take the retained snapshot (removing it — this generation is
  // now the live copy) and claim the key, so only this generation may write it
  // back. Reading before claiming is T3's order too: `get.once(resumeAtom)`
  // then `resumeCache.owner = owner`.
  const retained = retention.take(sessionId);
  const retentionOwner = retention.claim(sessionId);

  let stream: AgentChatStreamHandle | null = null;
  let closed = false;
  /**
   * The §7.4 queue's drive loop re-checks when a queued send of this thread
   * settles — this generation's or one a torn-down generation still had out
   * (`beginQueuedSend`, which is also its in-flight latch).
   */
  let unsubscribeQueuedSends: (() => void) | null = null;
  /** Decided inside a zustand updater, acted on after `set` returns (Q2-9). */
  let resyncWanted = false;
  /**
   * The history's bridge outgrew its cap and everything loaded was dropped
   * (`historyWithinCap`): fresh bounds are wanted. Decided and acted on as
   * `resyncWanted` is, through `resyncHistory`.
   */
  let historyResyncWanted = false;
  /** The one `GET …/history` in flight; overlapping loads share it. */
  let historyInFlight: Promise<void> | null = null;
  /** Mints each reveal request's nonce, so an acknowledgement names exactly one. */
  let revealNonce = 0;
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
     * 503 `HOST_UNAVAILABLE`, and an attempt left unanswered for
     * {@link COMMAND_ATTEMPT_TIMEOUT_MS}, is retried with the **same** id,
     * which the receipt makes free; anything else is surfaced. A turn or an
     * answer keeps retrying after this generation is torn down
     * ({@link RETRIED_PAST_TEARDOWN}).
     */
    const command = async <TName extends AgentChatCommandName>(
      name: TName,
      body: Omit<AgentChatCommandBodies[TName], "commandId">,
      commandId = newId()
    ): Promise<void> => {
      const payload = { ...body, commandId } as AgentChatCommandBodies[TName];
      await withCommandRetries(
        (signal) => deps.transport.command(sessionId, name, payload, signal),
        { outlivesGeneration: RETRIED_PAST_TEARDOWN.has(name) }
      );
    };

    /**
     * The retry + error-banner half of {@link command}, shared with the §3.4
     * account switch — which posts to a daemon-owned route rather than a §6.2
     * command path but carries the same `commandId` and the same envelope, so
     * it must retry on the same rules. `run` is re-invoked with the SAME body,
     * never a re-minted id, and each attempt with its own abort signal.
     */
    const withCommandRetries = async (
      run: (signal: AbortSignal) => Promise<unknown>,
      options: { outlivesGeneration?: boolean } = {}
    ): Promise<void> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await attemptCommand(run);
          return;
        } catch (error) {
          // §6.6: an in-flight command whose response was lost is retried with
          // the SAME `commandId`, which the receipt makes free. That covers a
          // 503 `HOST_UNAVAILABLE`, an attempt that timed out, and any
          // transport-level throw — including one from a custom
          // `Transporter.agentChat()` that does not wrap its failures. Only a
          // decoded, non-retryable error envelope stops here — and a torn-down
          // generation, for every command but a turn or an answer (§7.4).
          const retryable =
            error instanceof AgentChatCommandError ? error.retryable : true;
          if (
            retryable &&
            attempt < maxRetries &&
            (!closed || options.outlivesGeneration === true)
          ) {
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
     * The single writer of this thread's persisted draft while this slice is
     * open (`localStorage`, key `orquester:agent-chat-drafts`) —
     * `updateThreadDraft` writes storage itself only when no slice of the
     * thread is. Empty drafts are dropped from storage by
     * `writePersistedDrafts`, so clearing is spelled as saving an empty draft.
     */
    const setDraft = (draft: ComposerDraft): void => {
      update((state) => (state.draft === draft ? state : { ...state, draft }));
      persistDraft(sessionId, draft);
    };

    /**
     * Return a message's content to the composer (§7.4): a queued message
     * returned, the queue a Stop drained, a rewound message, a queued send
     * that lost the race with an interrupt.
     *
     * **There is one visible draft, and a mounted composer owns it.** When a
     * composer is mounted for this session the whole message goes to it
     * through W13's `composer-bridge` (`returnMessage`): merged behind its live
     * draft, every file staged as a returning chip — never refused for the
     * count; the send gate holds a draft over the eight — and its
     * `[Image #N]` following its own images, never naming one of the
     * composer's (`draftAfterReturn`, the merge a failed send makes the other
     * way round). A file it still refuses (a type or a size it never stages)
     * comes back into its draft as the path the user can see — the bridge's
     * documented fallback — and nothing is parked in this store's draft behind
     * it: the composer saves its own whole draft back, so anything left here
     * was invisible until its next mount and overwritten by its next save
     * (fix-wave R7-5). With no composer mounted the same merge runs over the
     * persisted draft (`persistedDraftAfterReturn`), every file kept — a file
     * a bound refuses as its path — where the next mount loads it; from a
     * torn-down generation, over the thread's live slice or storage, never its
     * own stale copy. A queued message returned by an interrupt while the user
     * is on another tab must not be lost, and two live drafts would disagree.
     */
    const appendToDraft = (message: QueuedComposerMessage): void => {
      const returned: ComposerDraft = {
        text: message.text,
        attachments: message.attachments,
        context: message.context
      };
      const unstaged = returnComposerMessage(sessionId, returned);
      if (unstaged !== null) {
        if (unstaged.length > 0) {
          insertComposerText(
            sessionId,
            composerTextForDelivery({ text: "", attachments: unstaged }),
            "append"
          );
        }
        return;
      }
      const merge = (draft: ComposerDraft): ComposerDraft =>
        persistedDraftAfterReturn({ persisted: draft, message: returned });
      if (closed) {
        // A generation torn down before the append ran — a rewind whose
        // `/revert` was still out when the tab's slice went — holds a stale
        // draft, and a newer slice of the thread keeps its own copy: merged
        // through the thread's live slice, or with none into its storage, as
        // `holdQueuedMessageInThread` does. Never over this one's copy.
        updateThreadDraft(sessionId, merge);
        return;
      }
      setDraft(merge(get().draft));
    };

    /**
     * Guard 2's hold (§7.4): the failed message goes back to the FRONT, held
     * for the user — right behind the last of the messages `behind` names
     * still in the queue (`holdAtFront`), so failures that land one after the
     * other keep the order they were posted in. `reason` is the failure's
     * banner, for a message another generation sent: its own banner went to
     * that generation, and a held row with no banner never says why it waits.
     * A banner the user closed for this thread stays closed, as
     * `withCommandRetries` has it.
     */
    const holdQueuedAtFront = (
      message: QueuedComposerMessage,
      reason?: string,
      behind?: ReadonlySet<string>
    ): void => {
      update((state) => {
        const queue = holdAtFront(state.queue, message, behind);
        const banner =
          reason === undefined || dismissedErrorBanners.has(`${sessionId}\u0000${reason}`)
            ? {}
            : { errorBanner: reason };
        const reducer = patchSlice(state.reducer, { queue: [...queue.messages], ...banner });
        return { ...state, queue, reducer, slice: reducer.slice };
      });
    };
    // Reachable by the thread's other generations: a queued send that fails
    // after this one's successor took over is held here (`holdQueuedMessageInThread`).
    (storeApi as unknown as HoldingThreadStore).holdQueuedAtFront = holdQueuedAtFront;

    /**
     * A send that did not go out, given back from this store (§7.4): a re-post
     * a reload left behind that the host refused, or one too old to re-post.
     * It goes where `restoreFailedSendDraft` puts any send whose composer is
     * gone — the live draft of the composer that shows the thread, through the
     * bridge, else the thread's draft (`persistedDraftAfterSend`), in both
     * ahead of what the draft holds — its files back as the chips a draft load
     * stages. From a torn-down generation through the thread's live slice or
     * storage, never over this one's stale copy, as `appendToDraft` does.
     */
    const restoreSend = (turn: OutboxTurn, notice: string): void => {
      const restore: FailedSendRestore<StagedAttachment> = {
        outcome: { kind: "failed", text: turn.input, notice },
        sent: (turn.attachments ?? []).map(storedChip)
      };
      if (restoreComposerFailedSend(sessionId, restore)) return;
      const merge = (draft: ComposerDraft): ComposerDraft | null =>
        persistedDraftAfterSend({ outcome: restore.outcome, sent: restore.sent, persisted: draft });
      if (closed) {
        updateThreadDraft(sessionId, merge);
        return;
      }
      const next = merge(get().draft);
      if (next !== null) setDraft(next);
    };

    /** The thread's banner, unless the user already closed this one (§7.3). */
    const showBanner = (message: string): void => {
      if (!closed && !dismissedErrorBanners.has(`${sessionId}\u0000${message}`)) {
        setSlice({ errorBanner: message });
      }
    };

    /**
     * A composer send a reload left behind, re-posted under its own
     * `commandId` (§7.4): the host's receipt answers one that had landed with
     * the seq it recorded, and one that had not goes out now — once, either
     * way. The thread reads "Sending" meanwhile (`settleSending`, opened when
     * the thread took it over), whichever composer shows it, so none offers
     * the message to send again; one the host refuses comes back as any failed
     * send does — saying it dates from before the reload — before the thread
     * stops reading "Sending".
     */
    const replaySend = async (entry: OutboxSend, settleSending: () => void): Promise<void> => {
      try {
        await command("turn", entry.turn, entry.commandId);
      } catch (error) {
        const notice = repostFailedNotice(errorMessage(error));
        if (entry.generatedPrompt !== true) restoreSend(entry.turn, notice);
        showBanner(notice);
      } finally {
        removeOutboxEntry(entry.commandId);
        settleSending();
      }
    };

    /**
     * Guard 2 (§7.4): a queued send that failed goes back to the FRONT with
     * `holdUntilUserAction`, so nothing overtakes it — in the queue the user
     * sees: this generation's, or — its turn keeps retrying after this one is
     * torn down — the thread's live generation's, else its persisted draft.
     * Under a new `commandId`: its next send is the user's own new command, as
     * it always was — the old one may be recorded as refused, and a receipt
     * only replays a refusal.
     */
    const holdFailedQueued = (
      message: QueuedComposerMessage,
      reason: string,
      behind?: ReadonlySet<string>
    ): void => {
      const held = { ...message, commandId: newId(), holdReason: reason };
      if (closed) {
        holdQueuedMessageInThread(sessionId, held, reason, behind);
      } else {
        holdQueuedAtFront(held, reason, behind);
      }
    };

    /**
     * A queued message on its way (§7.4), from the moment it left the queue
     * until it settles: posted under the `commandId` it was queued with — which
     * a re-post after a reload shares, so the host's receipt dedupes the two —
     * and holding the thread's queue meanwhile (`beginQueuedSend`), in every
     * generation of it. Delivered, its outbox entry goes and the queue moves
     * on; failed, it is held at the front FIRST (behind the messages `behind`
     * names) and only then is the queue let go, so the next message never
     * slips ahead of it. `describe` words the failure — a re-post after a
     * reload says so.
     */
    const postQueued = async (
      message: OutboxQueuedMessage,
      behind?: ReadonlySet<string>,
      describe: (reason: string) => string = (reason) => reason
    ): Promise<void> => {
      const settleQueued = beginQueuedSend(sessionId);
      try {
        await command(
          "turn",
          {
            input: message.text,
            attachments: message.attachments,
            context: message.context,
            interactionMode: message.interactionMode
          },
          message.commandId
        );
        removeOutboxEntry(message.commandId);
      } catch (error) {
        holdFailedQueued(message, describe(errorMessage(error)), behind);
        removeOutboxEntry(message.commandId);
        throw error;
      } finally {
        settleQueued();
      }
    };

    /**
     * What a reload left on its way, re-posted ONE AT A TIME in the order it
     * was first posted — a composer send among the queued ones — so none can
     * land ahead of one posted before it (§7.4). The queue holds for the whole
     * run: what waits in it goes only once every one of these has settled.
     * Each composer send reads "Sending" from the start, not only on its turn.
     * A queued one the host refuses is held right behind the last message the
     * run has held so far (`placed`: the stale ones held when the thread took
     * the leftovers over, then each failure), in post order, ahead of the
     * rest. One step going wrong never strands the others: each runs on its
     * own, and every "Sending" the run opened is settled when it ends.
     */
    const replayInOrder = async (
      ordered: ReadonlyArray<OutboxSend | OutboxQueued>,
      placed: Set<string>
    ): Promise<void> => {
      const settleQueue = beginQueuedSend(sessionId);
      const sending = new Map<OutboxSend, () => void>();
      for (const entry of ordered) {
        if (entry.kind === "send") sending.set(entry, beginComposerSend(sessionId));
      }
      try {
        for (const entry of ordered) {
          try {
            if (entry.kind === "send") {
              await replaySend(entry, sending.get(entry)!);
              continue;
            }
            const failed = await postQueued(entry.message, placed, repostFailedNotice).then(
              () => false,
              () => true
            );
            if (failed) placed.add(entry.message.id);
          } catch {
            /* the step's own settle and restore ran as far as they could; the rest still go */
          }
        }
      } finally {
        for (const settle of sending.values()) settle();
        settleQueue();
      }
    };

    /**
     * What a previous page of this tab left for this thread (§7.4) — the sends
     * and the queue a reload interrupted, handed to the thread's first store
     * after it (`adoptOutboxLeftovers`). A send posted less than
     * `OUTBOX_REPLAY_MAX_AGE_MS` ago is re-posted under its own `commandId`,
     * the host's receipt deduping one that had landed — all of them one at a
     * time, in the order they were posted (`replayInOrder`). An older one is
     * not — the host may no longer know its id, and it may have landed: a
     * composer send comes back to the draft, a queued one is held at the front
     * of the queue, both saying why. The queue comes back behind them, in
     * order — held, if nobody has seen it for `OUTBOX_QUEUE_ABSENCE_MAX_MS`
     * (`heldIfUnseen`); a message held before the reload comes back held, with
     * its reason on the banner.
     */
    const resumeFromOutbox = (): void => {
      const leftovers = adoptOutboxLeftovers(sessionId);
      if (leftovers.length === 0) {
        return;
      }
      const at = clock();
      const shownAt = outboxQueueShownAt(sessionId);
      const stale: OutboxSend[] = [];
      const replays: Array<OutboxSend | OutboxQueued> = [];
      const held: QueuedComposerMessage[] = [];
      const waiting: QueuedComposerMessage[] = [];
      for (const entry of leftovers) {
        if (entry.kind === "send") {
          if (outboxReplayable(entry.sentAt, at)) {
            replays.push(entry);
          } else {
            stale.push(entry);
          }
        } else if (entry.sentAt === undefined) {
          waiting.push(heldIfUnseen(entry.message, shownAt, at));
        } else if (outboxReplayable(entry.sentAt, at)) {
          replays.push(entry);
        } else {
          held.push({
            ...entry.message,
            commandId: newId(),
            holdUntilUserAction: true,
            holdReason: STALE_SEND_NOTICE
          });
          removeOutboxEntry(entry.message.commandId);
        }
      }
      // Newest first: each goes ahead of what the draft holds, so the oldest
      // ends up first, as they were sent. An Implement's prompt gives nothing
      // back — the plan is still there to implement.
      let givenBack = false;
      for (const entry of [...stale].reverse()) {
        if (entry.generatedPrompt !== true) {
          restoreSend(entry.turn, STALE_SEND_NOTICE);
          givenBack = true;
        }
        removeOutboxEntry(entry.commandId);
      }
      // Said on the thread too, not only by a composer that happens to be
      // mounted: whoever opens it next sees why a message is back, unsent, or
      // why one waits.
      const reason = firstHoldReason([...held, ...waiting]) ?? (givenBack ? STALE_SEND_NOTICE : null);
      const banner =
        reason !== null && !dismissedErrorBanners.has(`${sessionId}\u0000${reason}`)
          ? { errorBanner: reason }
          : {};
      if (held.length > 0 || waiting.length > 0) {
        update((state) => {
          const queue: QueueState = {
            ...state.queue,
            messages: [...held, ...waiting, ...state.queue.messages]
          };
          const reducer = patchSlice(state.reducer, { queue: [...queue.messages], ...banner });
          return { ...state, queue, reducer, slice: reducer.slice };
        });
      } else if (reason !== null) {
        setSlice(banner);
      }
      if (replays.length > 0) {
        const bySentAt = (entry: OutboxSend | OutboxQueued): number => entry.sentAt ?? 0;
        void replayInOrder(
          [...replays].sort((left, right) => bySentAt(left) - bySentAt(right)),
          new Set(held.map((message) => message.id))
        );
      }
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
        // A prompt only a loaded history page or the bridge holds is present
        // until the revert drops them (`historyAfterRevert`), exactly as a
        // window prompt is until the fold drops it.
        const evaluate = (slice: AgentChatThreadSlice): void => {
          const progress = rewindProgress(
            slice.entries,
            messageId,
            knownFailureIds,
            inLoadedHistory(slice.history, messageId)
          );
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
        evaluate(get().slice);
        if (settled) {
          return;
        }
        unsubscribe = storeApi.subscribe((state, previous) => {
          if (
            state.slice.entries !== previous.slice.entries ||
            state.slice.history.pages !== previous.slice.history.pages ||
            state.slice.history.bridge !== previous.slice.history.bridge
          ) {
            evaluate(state.slice);
          }
        });
        destroyListeners.add(onDestroy);
        timer = setTimeout(() => finish(new Error(REWIND_TIMED_OUT)), REWIND_TIMEOUT_MS);
        timer.unref?.();
      });

    /** Replace the slice's history. */
    const patchHistory = (
      mutate: (history: AgentChatHistoryState) => AgentChatHistoryState
    ): void => {
      update((state) => {
        const history = mutate(state.slice.history);
        if (history === state.slice.history) {
          return state;
        }
        const reducer = patchSlice(state.reducer, { history });
        return { ...state, reducer, slice: reducer.slice };
      });
    };

    /**
     * Resolve once the stream is live, so a reveal plans against the thread as
     * it is — a warm remount paints a retained fold that may predate the very
     * turn it was asked to show. Past {@link REVEAL_SYNC_TIMEOUT_MS} it goes
     * ahead on whatever snapshot there is (`false` with none); a destroyed
     * generation answers `false` at once.
     */
    const waitForSynchronized = (): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        if (closed) {
          resolve(false);
          return;
        }
        if (get().slice.connection === "synchronized") {
          resolve(true);
          return;
        }
        let settled = false;
        const finish = (ready: boolean): void => {
          if (settled) {
            return;
          }
          settled = true;
          unsubscribe();
          destroyListeners.delete(onDestroy);
          clearTimeout(timer);
          resolve(ready);
        };
        const onDestroy = (): void => finish(false);
        const unsubscribe = storeApi.subscribe((state) => {
          if (state.slice.connection === "synchronized") {
            finish(true);
          }
        });
        destroyListeners.add(onDestroy);
        const timer = setTimeout(() => finish(get().slice.head !== null), REVEAL_SYNC_TIMEOUT_MS);
        timer.unref?.();
      });

    const actions: AgentChatActions = {
      async sendTurn(input) {
        const turn: OutboxTurn = {
          input: input.text,
          ...(input.attachments ? { attachments: input.attachments } : {}),
          ...(input.context ? { context: input.context } : {}),
          interactionMode: input.interactionMode ?? get().slice.interactionMode,
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {})
        };
        const commandId = newId();
        // In the tab's outbox from before its first post until it settles:
        // `submit` already cleared the draft, so after a reload this is the
        // one copy of the message — re-posted under this id, which the host's
        // receipt dedupes, or given back to the draft (§7.4).
        recordOutboxSend({
          sessionId,
          commandId,
          sentAt: clock(),
          turn,
          ...(input.generatedPrompt === true ? { generatedPrompt: true } : {})
        });
        try {
          await command("turn", turn, commandId);
        } finally {
          removeOutboxEntry(commandId);
        }
      },

      async steer(input) {
        await actions.sendTurn(input);
      },

      async readFullPlanMarkdown(plan) {
        if (plan.truncated !== true) {
          return plan.planMarkdown;
        }
        const response = await deps.transport.readItem(sessionId, plan.id).catch(() => null);
        const item = response?.item;
        const payload = item?.kind === "activity" ? item.payload : null;
        const markdown =
          typeof payload === "object" && payload !== null
            ? (payload as { planMarkdown?: unknown }).planMarkdown
            : undefined;
        if (typeof markdown !== "string" || markdown.trim().length === 0) {
          throw new Error("The full plan could not be loaded, so nothing was sent. Try again.");
        }
        return markdown;
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
        const isTarget = (item: ThreadItem): item is ThreadMessageItem =>
          item.kind === "message" && item.role === "user" && item.id === input.messageId;
        // A rewind from a history row (design 2026-09-23 "Client") names a
        // prompt the window no longer holds; the bridge or a page still does.
        const { history } = get().slice;
        const target =
          entries.find(isTarget) ??
          history.bridge.find(isTarget) ??
          history.pages.flatMap((page) => page.items).find(isTarget);
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
        await withCommandRetries((signal) =>
          deps.transport.switchAccount(sessionId, { commandId, accountId: input.accountId }, signal)
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
        // Minted now and carried by every post of it (§7.4): the tab's outbox
        // keeps it with the message, so a reload that re-posts it, or a copy of
        // the tab that sends it too, is deduped by the host's receipt.
        const commandId = message.commandId ?? newId();
        update((state) => {
          // The anchor is stamped HERE, not by the composer: the boundary a
          // queued message waits for is the newest completed tool call at the
          // moment it was queued, and only the store observes activities. A
          // caller that passes `null` (the composer does — it has no activity
          // feed) would otherwise flush at the very next boundary check
          // instead of the next *new* tool call (§7.4).
          const anchored = {
            ...message,
            commandId,
            queuedAfterToolActivityId:
              message.queuedAfterToolActivityId === null
                ? latestCompletedToolActivityId(state.timeline.activities)
                : message.queuedAfterToolActivityId
          };
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
        if (!taken.message) {
          return;
        }
        const message: OutboxQueuedMessage = {
          ...taken.message,
          commandId: taken.message.commandId ?? newId()
        };
        // On its way from here: marked so in the tab's outbox, in its place,
        // before the queue drops it — a reload in between re-posts it first,
        // under the same id, and never finds it in neither place.
        recordOutboxQueuedPost(sessionId, message, clock());
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
          removeOutboxEntry(message.commandId);
          appendToDraft(message);
          return;
        }
        // Guard 2 lives in `postQueued`: a failure is held at the FRONT.
        await postQueued(message);
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
      },

      loadOlderHistory() {
        if (historyInFlight !== null) {
          return historyInFlight;
        }
        const asked = get().slice.history;
        if (closed || !canLoadOlderHistory(asked)) {
          return Promise.resolve();
        }
        // Without a cursor once the window has evicted since its snapshot
        // (`windowEvicted`): that snapshot's cursor no longer meets it.
        const before = nextHistoryCursor(asked);
        // From here until the page lands, what the window evicts goes onto
        // the bridge (`historyAfterEvent` reads `loading`): the page ends
        // where the window stood when it was asked for.
        patchHistory((history) => (history.loading ? history : { ...history, loading: true }));
        // What the page is asked against. A snapshot (or a rewind into a page
        // or the bridge, or the cap) replaces `pages` with a fresh array and a
        // snapshot mints new bounds, so a page that lands after either
        // belongs to a log this thread no longer shows as it did: it is
        // dropped, never merged — and a bridge begun for it, with nothing
        // loaded to join, goes too (`withoutOrphanBridge`).
        const superseded = (history: AgentChatHistoryState): boolean =>
          history.pages !== asked.pages || history.bounds !== asked.bounds;
        const run = (async (): Promise<void> => {
          try {
            const page = await deps.transport.readHistory(sessionId, {
              ...(before === undefined ? {} : { before }),
              turns: THREAD_HISTORY_DEFAULT_TURNS
            });
            if (closed) {
              return;
            }
            // The page's end cuts the window where it lies, so the window's
            // rows below it render with the history, in their place.
            const windowItems = get().slice.entries;
            patchHistory((history) =>
              superseded(history)
                ? withoutOrphanBridge({ ...history, loading: false })
                : { ...historyWithPage(history, page, windowItems), loading: false, error: null }
            );
          } catch (error) {
            if (closed) {
              return;
            }
            // Recorded in words on the history row — never the thread's error
            // banner: the live thread is fine, only the index is not.
            patchHistory((history) =>
              withoutOrphanBridge(
                superseded(history)
                  ? { ...history, loading: false }
                  : { ...history, loading: false, error: historyErrorMessage(error) }
              )
            );
          }
        })().finally(() => {
          // Released in a `.finally` on the returned promise — always a later
          // microtask — never inside the body: a transport that throws before
          // its first `await` would otherwise clear the latch BEFORE the
          // assignment below, which would then pin a settled promise and
          // silently refuse every later load.
          historyInFlight = null;
        });
        historyInFlight = run;
        return run;
      },

      async revealTurn(turnId) {
        if (!(await waitForSynchronized())) {
          return false;
        }
        // One look per page the cap allows, plus the look after the last one.
        for (let look = 0; look <= HISTORY_REVEAL_PAGE_CAP; look += 1) {
          if (closed) {
            return false;
          }
          const state = get();
          const { slice } = state;
          // The fold keeps every turn (retention evicts rows, never turns), so
          // a turn it does not know was reverted away: no page can hold it.
          if (!isStartedTurn(slice.turns, turnId)) {
            return false;
          }
          const plan = planReveal(turnId, {
            liveTurnIds: liveTurnIdsOf(slice.entries, slice.turns),
            // A turn the window evicted into the bridge is on screen too.
            bridgeTurnIds: liveTurnIdsOf(slice.history.bridge, slice.turns),
            pages: slice.history.pages,
            hasOlder: canLoadOlderHistory(slice.history)
          });
          if (plan === "absent") {
            return false;
          }
          if (plan === "present") {
            const rowId = rowIdForTurn(
              state.rows,
              turnId,
              userMessageIdForTurn(turnId, slice.turns, slice.history.pages)
            );
            if (rowId === null) {
              return false;
            }
            revealNonce += 1;
            const reveal: AgentChatRevealRequest = { turnId, rowId, nonce: revealNonce };
            update((current) => ({ ...current, reveal }));
            return true;
          }
          await actions.loadOlderHistory();
          if (get().slice.history.error !== null) {
            return false;
          }
        }
        return false;
      },

      acknowledgeReveal(nonce) {
        update((state) => (state.reveal?.nonce === nonce ? { ...state, reveal: null } : state));
      }
    };

    const applyStreamFrame = (
      frame: Parameters<typeof applyFrame>[1],
      options: {
        /**
         * Keep the connection state the frame would reset: a re-read's
         * snapshot rides beside a live stream, and no `synchronized` frame
         * follows it to take the thread out of "connecting" again.
         */
        keepConnection?: boolean;
      } = {}
    ): void => {
      // §7.7: when an open chat tab's stream delivers `thread.turn-diff-completed`
      // the client refreshes the git tab for that project. No new bus event is
      // introduced for it (§6.4) — the thread stream already knows.
      if (frame.kind === "event" && frame.event.type === "thread.turn-diff-completed") {
        const projectPath = get().slice.head?.projectPath;
        if (projectPath) {
          nudgeProjectGit(projectPath);
        }
      }
      const historyBefore = get().slice.history;
      update((state) => {
        // §6.3/§8: a different host instance id means re-read, not resume.
        // Decided inside the updater, performed after `set` returns: a zustand
        // updater must be pure, or a replay double-fires the read (Q2-9).
        resyncWanted ||= needsResync(state.reducer.hostInstanceId, frame);
        let reducer = applyFrame(state.reducer, frame);
        if (reducer === state.reducer) {
          return state;
        }
        if (options.keepConnection === true) {
          reducer = withConnection(reducer, state.slice.connection);
        }
        // The bridge is the one part of the history that grows without the
        // user asking, so it is where the cap is held (design 2026-09-23 fold
        // performance, "Client"): the oldest pages go first, and a bridge that
        // no longer fits takes everything with it, for fresh bounds — asked
        // for after `set` returns, like the resync above.
        const history = reducer.slice.history;
        if (history.bridge.length > state.slice.history.bridge.length) {
          const capped = historyWithinCap(history, historyRowCap);
          if (capped.history !== history) {
            reducer = patchSlice(reducer, { history: capped.history });
          }
          historyResyncWanted ||= capped.resync;
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
            historyItems: EMPTY_HISTORY_ITEMS,
            liveSplit: EMPTY_LIVE_SPLIT,
            rowTimeline: EMPTY_TIMELINE_PROJECTION,
            historyRows: EMPTY_HISTORY_ROWS,
            derivedSets: null
          };
        }
        return { ...state, reducer, slice: reducer.slice };
      });
      // A snapshot replaces the rows wholesale, and a rewind or the cap can
      // drop pages and bridge rows: an unhandled reveal whose row went with
      // them is dropped, or it would fire whenever that row reappeared — long
      // after anyone asked.
      const revealed = get().reveal;
      const historyAfter = get().slice.history;
      if (
        revealed !== null &&
        (frame.kind === "snapshot" ||
          (frame.kind === "event" && frame.event.type === "thread.reverted") ||
          historyAfter.pages.length < historyBefore.pages.length ||
          historyAfter.bridge.length < historyBefore.bridge.length) &&
        !get().rows.some((row) => row.id === revealed.rowId)
      ) {
        set({ reveal: null });
      }
      if (resyncWanted) {
        resyncWanted = false;
        // The re-read below brings fresh history bounds as well.
        historyResyncWanted = false;
        // A changed host instance id means re-read, not resume; the transport's
        // own sequence floor is reset with it so a host that restarted its
        // sequence space lower cannot have its live frames suppressed (Q2-8).
        stream?.resetCursor();
        void actions.refresh().catch(() => {
          /* the stream's own reconnect will try again */
        });
      } else if (historyResyncWanted) {
        historyResyncWanted = false;
        void resyncHistory().catch(() => {
          /* the next load asks without a cursor anyway (`nextHistoryCursor`) */
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
     * The history's re-read (design 2026-09-23 fold performance, "Client"):
     * once the cap dropped everything loaded, fresh bounds — and in them a
     * "load older" cursor for the window as it now stands — come from a fresh
     * snapshot.
     *
     * The store's resync path, minus what only a changed host needs. The host
     * is the same one, so the stream's sequence floor stays where it is. And
     * the read rides beside a live stream: a snapshot older than what that
     * stream has folded since would roll those events back for good (the
     * stream never sends them again), so it is refused — the next load then
     * asks without a cursor, which the host answers for the window as it
     * stands anyway (`nextHistoryCursor`). An applied one keeps the stream's
     * connection state.
     */
    const resyncHistory = async (): Promise<void> => {
      const response = await deps.transport.read(sessionId);
      if (closed || response.kind !== "snapshot" || response.thread.seq < get().reducer.fold.seq) {
        return;
      }
      applyStreamFrame({ kind: "snapshot", thread: response.thread }, { keepConnection: true });
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
     * The in-flight latch is the thread's, not this generation's
     * (`isQueuedSendInFlight`): without one a burst of frames would dispatch
     * the same head twice, and with only this generation's the thread's next
     * generation sent the next message while a torn-down one was still
     * posting the head — landing it first, or overtaking the head when that
     * failed and was held at the front. A queued send settling, in any
     * generation, re-runs this loop (`subscribeQueuedSends` below): a boundary
     * may have moved while it was out.
     *
     * *T3: `apps/web/src/components/ChatView.tsx:8604-8642` — the same loop and
     * the same pending-request gates.*
     */
    const driveQueue = (): void => {
      if (closed || isQueuedSendInFlight(sessionId)) {
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
      void actions.sendQueuedNow(due.id).catch(() => {
        /* `sendQueuedNow` already held it at the front and banner'd it. */
      });
    };
    unsubscribeQueuedSends = subscribeQueuedSends((changed) => {
      if (changed === sessionId) {
        driveQueue();
      }
    });

    // A provider snapshot arriving after the thread did changes one row input
    // (`supportsConversationRollback`), so re-project when the catalog moves.
    unsubscribeProviders = providersStore.subscribe((next, previous) => {
      if (next.providers !== previous.providers) {
        update((state) => ({ ...state }));
      }
    });

    const warm = retained ? cachedThreadState(retained.state) : null;
    // The queue starts from the one this page keeps in the tab's outbox
    // (§7.4) — the thread's queue as it last stood, a message held while no
    // generation was live included (`holdQueuedMessageInThread`), which the
    // retained snapshot, taken at the teardown, does not have — else from that
    // snapshot. Dropping it when the snapshot expired lost every message still
    // waiting; a queue nobody has seen for a while comes back held.
    const keptQueue = outboxQueue(sessionId);
    const seedFrom = seedQueueFrom({
      kept: keptQueue,
      keptCurrent: keptQueueCurrent.get(sessionId) !== false,
      retained: warm?.queue.messages ?? null
    });
    const seedShownAt = outboxQueueShownAt(sessionId);
    const seedAt = clock();
    const seedMessages = seedFrom.map((message) => heldIfUnseen(message, seedShownAt, seedAt));
    // Unchanged when it is the retained queue — the same messages, held the
    // same way — whose rows are already painted: the kept copy parses into
    // fresh objects, and taking those would project every row again.
    const retainedMessages = warm?.queue.messages;
    const sameAsRetained =
      retainedMessages !== undefined &&
      seedMessages.length === retainedMessages.length &&
      seedMessages.every(
        (message, index) =>
          message.commandId === retainedMessages[index]!.commandId &&
          message.holdUntilUserAction === retainedMessages[index]!.holdUntilUserAction
      );
    const seedChanged = !sameAsRetained;
    const seededQueue: QueueState =
      warm !== null && sameAsRetained
        ? warm.queue
        : seedMessages.length === 0
          ? EMPTY_QUEUE
          : { messages: seedMessages, drainGeneration: warm?.queue.drainGeneration ?? 0 };
    const seedReason = firstHoldReason(seedMessages);
    const seedBanner =
      seedReason !== null && !dismissedErrorBanners.has(`${sessionId}\u0000${seedReason}`)
        ? { errorBanner: seedReason }
        : {};
    const baseReducer = warm
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
    const initialReducer =
      seedChanged || seedReason !== null
        ? patchSlice(baseReducer, { queue: [...seededQueue.messages], ...seedBanner })
        : baseReducer;

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
      // The queue this generation holds, held flags and all, is the page's
      // copy from here on: a message held because nobody had seen it stays
      // held across the next reload, whose stamp will be fresh. The queue as
      // it stands NOW, never the seed: a torn-down generation's failing send
      // may have been held into it since it was created.
      const live = get().queue.messages;
      if (live.length > 0 || seededQueue.messages.length > 0) {
        keptQueueCurrent.set(sessionId, writeOutboxQueue(sessionId, live));
      }
      // Before the stream: what a reload interrupted is on its way again, and
      // the queue back, before the thread's first frame can make anything due.
      resumeFromOutbox();
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

    const initialState: InternalState = {
      reducer: initialReducer,
      slice: initialReducer.slice,
      queue: seededQueue,
      timeline: warm?.timeline ?? EMPTY_TIMELINE_PROJECTION,
      rowsProjection: warm?.rowsProjection ?? null,
      stableRows: warm?.stableRows ?? EMPTY_STABLE_ROWS,
      derivedSets: warm?.derivedSets ?? null,
      historyItems: warm?.historyItems ?? EMPTY_HISTORY_ITEMS,
      liveSplit: warm?.liveSplit ?? EMPTY_LIVE_SPLIT,
      rowTimeline: warm?.rowTimeline ?? EMPTY_TIMELINE_PROJECTION,
      historyRows: warm?.historyRows ?? EMPTY_HISTORY_ROWS,
      rowsSource: warm?.rowsSource ?? {
        history: warm?.historyRows ?? EMPTY_HISTORY_ROWS,
        live: (warm?.stableRows ?? EMPTY_STABLE_ROWS).result
      },
      rows: warm?.rows ?? [],
      isCompacting: warm?.isCompacting ?? false,
      activePlan: warm?.activePlan ?? null,
      actionableProposedPlan: warm?.actionableProposedPlan ?? null,
      // An in-flight command belonged to the generation that is gone.
      reverting: false,
      draft: readPersistedDrafts()[sessionId] ?? EMPTY_DRAFT,
      stopping: false,
      reveal: null,
      actions
    };
    // A queue that is not the retained one gets its rows now — its ghost
    // bubbles, held or not — rather than at the thread's first frame.
    return seedChanged ? project(initialState) : initialState;
  });

  // The tab's outbox holds this thread's queue as it stands (§7.4): a reload
  // brings it back in order, and so does a generation that starts with
  // nothing retained. Written by the live generation only — a torn-down one's
  // queue is a snapshot of the past.
  const unsubscribeQueueMirror = store.subscribe((state, previous) => {
    if (state.queue.messages !== previous.queue.messages) {
      keptQueueCurrent.set(sessionId, writeOutboxQueue(sessionId, state.queue.messages));
    }
  });

  // When this thread's queue was last on screen or driven by this live page
  // (§7.4), for the absence bound a queue coming back is measured against:
  // stamped as the page is hidden, on `pagehide`, and when this generation is
  // torn down — unless the page is hidden then, when the stamp it took on
  // hiding stands.
  const stampQueueShown = (): void => stampOutboxQueueShown(sessionId, clock());
  const pageHidden = (): boolean =>
    typeof document !== "undefined" && document.visibilityState === "hidden";
  const onVisibilityChange = (): void => {
    if (pageHidden()) stampQueueShown();
  };
  const lifecycle =
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof window.addEventListener === "function" &&
    typeof document.addEventListener === "function";
  if (lifecycle) {
    window.addEventListener("pagehide", stampQueueShown);
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

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
    unsubscribeQueuedSends?.();
    unsubscribeQueuedSends = null;
    unsubscribeQueueMirror();
    if (lifecycle) {
      window.removeEventListener("pagehide", stampQueueShown);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    if (!pageHidden()) stampQueueShown();
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
 * Two reasons it is not zero. §7.1's paint hold: a view handed another thread
 * keeps painting the outgoing thread's rows until the next thread's snapshot
 * lands, and tearing its stream down on the same tick would flash — a
 * defensive case, since each chat tab owns its `AgentChatView` (the placement
 * note there). And React's StrictMode mounts, unmounts and re-mounts an effect
 * in development; a zero grace would close and re-open every stream on every
 * mount. What a torn-down generation still had in flight settles into it, not
 * into its successor: a turn or an answer retries past the teardown, the
 * composer's own "Sending" lives in `composer-sends.ts`, a queued send holds
 * the thread's queue in every generation until it settles
 * (`beginQueuedSend`), and one that fails there is held by the thread's live
 * generation, or with none at the front of the queue the page keeps for the
 * thread (`holdQueuedMessageInThread`).
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

/**
 * Rewrite one thread's persisted draft from outside its composer (§7.4): a
 * send that did not go out, settling after the composer it left from stopped
 * showing its thread. `change` gets the draft as it is now and answers the
 * draft to write, or `null` to leave it as it is.
 *
 * Through the thread's own live slice when one is open — its `saveDraft`, so
 * the draft the thread's next composer mount loads is the rewritten one — and
 * otherwise straight into the storage every new slice of the thread seeds its
 * draft from. Never through a slice captured earlier: one the registry has
 * since dropped would still write storage, but a newer slice of the same
 * thread keeps its own copy in memory, which the next mount would load
 * instead, and its next save would write back over the change.
 */
export function updateThreadDraft(
  sessionId: string,
  change: (draft: ComposerDraft) => ComposerDraft | null
): void {
  const live = peekThreadStore(sessionId);
  if (live) {
    const next = change(live.getState().draft);
    if (next !== null) live.getState().actions.saveDraft(next);
    return;
  }
  const next = change(readPersistedDrafts()[sessionId] ?? EMPTY_DRAFT);
  if (next !== null) persistDraft(sessionId, next);
}

/**
 * Hold a queued message whose send failed after the generation that sent it
 * was torn down (§7.4) — its turn retries past the teardown — where the user
 * will see it: at the front of the thread's live generation's queue, held for
 * the user's action like any failed queued send — nothing queued behind it
 * went meanwhile: the queue waited for it (`beginQueuedSend`) — and with the
 * failure's banner (`reason`) beside it. With no slice of the thread open, at
 * the FRONT of the queue this page keeps for the thread in the tab's outbox,
 * held and with its reason, where the thread's next generation starts from —
 * the messages queued behind it are there too, and a message put back in the
 * draft instead would watch them drain ahead of it. Only a tab with no storage
 * to keep it in merges it into the persisted draft. Never in the destroyed
 * queue: the next generation was seeded from a snapshot taken after the
 * message had already left it, so nobody would show it again.
 */
function holdQueuedMessageInThread(
  sessionId: string,
  message: QueuedComposerMessage,
  reason: string,
  behind?: ReadonlySet<string>
): void {
  const live = registry.get(sessionId)?.store as HoldingThreadStore | undefined;
  if (live?.holdQueuedAtFront) {
    live.holdQueuedAtFront(message, reason, behind);
    return;
  }
  const { commandId } = message;
  if (
    commandId !== undefined &&
    holdOutboxQueuedAtFront(sessionId, { ...message, commandId, holdReason: reason }, behind)
  ) {
    return;
  }
  updateThreadDraft(sessionId, (draft) => persistedDraftAfterReturn({ persisted: draft, message }));
}

/**
 * Per thread, whether the last write of its queue to the tab's outbox reached
 * the storage (§7.4). A write that failed — the storage full — leaves the kept
 * queue behind the thread's own, so a generation does not start from it as
 * if it were current (`seedQueueFrom`). Module-level, as the queue it
 * describes outlives every generation; forgotten with the page.
 */
const keptQueueCurrent = new Map<string, boolean>();

/**
 * Which queue a store generation starts from (§7.4): the page's kept queue —
 * the thread's queue as it last stood, a message held while no generation was
 * live included, which the retained snapshot (taken at the teardown) lacks —
 * unless its last write failed and a snapshot was retained: then the snapshot,
 * with any held message only the kept queue has (a hold stored after the
 * failed write) put back in front. With no snapshot, the kept queue is all
 * there is, current or not.
 */
function seedQueueFrom(input: {
  kept: readonly QueuedComposerMessage[];
  keptCurrent: boolean;
  retained: readonly QueuedComposerMessage[] | null;
}): QueuedComposerMessage[] {
  const { kept, keptCurrent, retained } = input;
  if (retained === null) return [...kept];
  if (kept.length === 0) return [...retained];
  if (keptCurrent) return [...kept];
  const retainedIds = new Set(retained.map((message) => message.commandId));
  return [
    ...kept.filter((message) => message.holdUntilUserAction && !retainedIds.has(message.commandId)),
    ...retained
  ];
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
  keptQueueCurrent.clear();
}

export type { AttachmentRef, ComposerContextRecord, InteractionMode };
export { DEFAULT_INTERACTION_MODE };
