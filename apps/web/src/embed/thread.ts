/**
 * The embed's one thread: the frames it was handed, folded by the app's own
 * reducer, and the rows the app's own projection makes of them (design
 * `docs/superpowers/specs/2026-11-13-embeddable-agent-chat-design.md` §5.4).
 *
 * The app's thread store (`lib/agent-chat/store.ts`) owns a transport, a
 * queue, drafts and a registry; none of that exists here, so this holds only
 * what the timeline renders from: the reducer state (`reducer.logic.ts`), the
 * projection layers `store.ts`'s `project` keeps, and the "load older" chain
 * that store runs, asking the host's loader instead of a transport. The
 * projection is that function's, layer for layer, minus what only the app
 * has: no queue, no providers (so no "rewind to here"), no plans.
 *
 * No React here; the element reads it through `subscribe`/`getView`.
 */

import {
  messageStreamingContext,
  repairsReEmittedAssistantCopies,
  THREAD_HISTORY_DEFAULT_TURNS,
  type AgentChatStreamFrame,
  type RuntimeSubagent,
  type ThreadHistoryPage
} from "@orquester/api/agent-chat";

import type {
  AgentChatHistoryState,
  AgentChatThreadSlice,
  AgentChatTimelineRow,
  DisclosureState
} from "../../../../packages/ui/src/lib/agent-chat/contracts";
import {
  deriveTimelineEntriesFromItems,
  EMPTY_TIMELINE_PROJECTION,
  type ThreadTimelineProjection
} from "../../../../packages/ui/src/lib/agent-chat/entries.logic";
import {
  canLoadOlderHistory,
  collectHistoryItems,
  EMPTY_HISTORY_ITEMS,
  EMPTY_HISTORY_ROWS,
  EMPTY_LIVE_SPLIT,
  hasSettledCompaction,
  HISTORY_PAGES_PER_LOAD,
  historyErrorMessage,
  historyWithinCap,
  historyWithPage,
  mergeTimelineRows,
  nextHistoryCursor,
  nextHistoryWindowCut,
  projectHistoryRows,
  showsNewRow,
  splitLiveItems,
  windowHasDropped,
  withoutOrphanBridge,
  type HistoryItemsState,
  type HistoryRowsState,
  type LiveSplit
} from "../../../../packages/ui/src/lib/agent-chat/history.logic";
import {
  applyFrame,
  createReducerState,
  needsResync,
  patchSlice,
  type AgentChatReducerState
} from "../../../../packages/ui/src/lib/agent-chat/reducer.logic";
import { liveAgentTaskIds } from "../../../../packages/ui/src/lib/agent-chat/roster.logic";
import {
  computeStableRows,
  deriveTimelineRowsWithState,
  deriveUnsettledTurnId,
  EMPTY_STABLE_ROWS,
  type StableRowsState,
  type TimelineRowsProjection
} from "../../../../packages/ui/src/lib/agent-chat/rows.logic";
import { isCompactingThread } from "../../../../packages/ui/src/lib/agent-chat/status.logic";
import { disclosureSets } from "../../../../packages/ui/src/lib/agent-chat/timeline-position";

import type { EmbedLoaders, EmbedPendingRequest } from "./types";

/** What the element renders: replaced whole on every change, kept otherwise. */
export interface EmbedThreadView {
  /** The thread the frames describe; null until one named it. */
  sessionId: string | null;
  slice: AgentChatThreadSlice;
  rows: readonly AgentChatTimelineRow[];
  retentionDropped: boolean;
  /** The open questions and approvals, in the dock's order. */
  pending: readonly EmbedPendingRequest[];
  /** Why the host could not deliver the last answer (`respondFailed`), by request. */
  failure: { requestId: string; message: string } | null;
}

/** The store's projection layers (`store.ts` `InternalState`), each kept for its fast path. */
interface Projection {
  timeline: ThreadTimelineProjection;
  rowsProjection: TimelineRowsProjection | null;
  stableRows: StableRowsState;
  historyItems: HistoryItemsState;
  liveSplit: LiveSplit;
  rowTimeline: ThreadTimelineProjection;
  historyRows: HistoryRowsState;
  rowsSource: { history: HistoryRowsState; live: readonly AgentChatTimelineRow[] };
  rows: AgentChatTimelineRow[];
  retentionDropped: boolean;
  derivedSets: {
    disclosures: DisclosureState;
    roster: readonly RuntimeSubagent[];
    expandedTurnIds: ReadonlySet<string>;
    expandedGroupIds: ReadonlySet<string>;
    liveAgentTaskIds: ReadonlySet<string>;
  } | null;
}

const NO_ROWS: AgentChatTimelineRow[] = [];

const EMPTY_PROJECTION: Projection = {
  timeline: EMPTY_TIMELINE_PROJECTION,
  rowsProjection: null,
  stableRows: EMPTY_STABLE_ROWS,
  historyItems: EMPTY_HISTORY_ITEMS,
  liveSplit: EMPTY_LIVE_SPLIT,
  rowTimeline: EMPTY_TIMELINE_PROJECTION,
  historyRows: EMPTY_HISTORY_ROWS,
  rowsSource: { history: EMPTY_HISTORY_ROWS, live: NO_ROWS },
  rows: NO_ROWS,
  retentionDropped: false,
  derivedSets: null
};

/** `store.ts`'s `project`, over this thread's reducer state. */
function project(reducer: AgentChatReducerState, state: Projection): Projection {
  const slice = reducer.slice;
  // Only a Claude log can hold the re-emitted opening paragraphs older hosts
  // wrote; the window, its row timeline and the history pages all ask alike.
  const repair = repairsReEmittedAssistantCopies(slice.head?.adapter)
    ? ({ dropRepeatedAssistantMessages: true } as const)
    : undefined;
  const timeline = deriveTimelineEntriesFromItems(slice.entries, state.timeline, repair);
  const sets =
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
  const historyItems = collectHistoryItems(state.historyItems, slice.history.pages, slice.history.bridge);
  const liveSplit =
    historyItems.ids.size === 0
      ? EMPTY_LIVE_SPLIT
      : splitLiveItems(state.liveSplit, slice.entries, historyItems, slice.history.windowCut);
  const rowTimeline =
    historyItems.ids.size === 0 || liveSplit.rowItems === slice.entries
      ? timeline
      : deriveTimelineEntriesFromItems(liveSplit.rowItems, state.rowTimeline, repair);
  const runningTurnId = slice.head?.session.activeTurnId ?? null;
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
    slice.sessionStatus === "running" || slice.turnStatus === "running" || slice.turnStatus === "pending";
  const activeTurnStartedAt = latestTurn?.startedAt ?? latestTurn?.requestedAt ?? null;
  const isCompacting = isCompactingThread({
    activities: timeline.activities,
    sessionStatus: slice.sessionStatus,
    turnStatus: slice.turnStatus
  });
  const retentionDropped = windowHasDropped(reducer.fold, slice.history);
  const activeTurnHeaderInHistory =
    historyItems.ids.size > 0 &&
    !liveSplit.rowsHavePrompt &&
    (historyItems.hasPrompt || liveSplit.sharedHavePrompt);
  const historyRows = projectHistoryRows(state.historyRows, {
    history: historyItems,
    sharedLive: liveSplit.shared,
    expandedTurnIds: sets.expandedTurnIds,
    expandedWorkGroupIds: sets.expandedGroupIds,
    turns: slice.turns,
    // No "rewind to here" in the embed (design §2 non-goals).
    supportsConversationRollback: false,
    liveCompacted: historyItems.ids.size > 0 && hasSettledCompaction(rowTimeline.workEntries),
    unsettledTurnId: deriveUnsettledTurnId(latestTurnSummary, runningTurnId),
    isWorking,
    isCompacting,
    activeTurnStartedAt,
    activeTurnHeaderHere: activeTurnHeaderInHistory,
    liveAgentTaskIds: sets.liveAgentTaskIds,
    messageStreaming,
    dropRepeatedAssistantMessages: repair !== undefined
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
      turns: slice.turns,
      supportsConversationRollback: false,
      liveAgentTaskIds: sets.liveAgentTaskIds,
      messageStreaming,
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
  const rows = rowsSource === state.rowsSource ? state.rows : mergeTimelineRows(historyRows, stableRows.result);
  if (
    timeline === state.timeline &&
    rowsProjection === state.rowsProjection &&
    stableRows === state.stableRows &&
    historyItems === state.historyItems &&
    liveSplit === state.liveSplit &&
    rowTimeline === state.rowTimeline &&
    historyRows === state.historyRows &&
    rows === state.rows &&
    retentionDropped === state.retentionDropped &&
    sets === state.derivedSets
  ) {
    return state;
  }
  return {
    timeline,
    rowsProjection,
    stableRows,
    historyItems,
    liveSplit,
    rowTimeline,
    historyRows,
    rowsSource,
    rows,
    retentionDropped,
    derivedSets: sets
  };
}

// ---------------------------------------------------------------------------
// Frames from the host
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A frame this bundle knows, by the fields `applyFrame` reads first — or
 * false: a newer kind, a stream `{ kind: "error" }` line, or anything else a
 * host relayed by mistake. `applyFrame` has no default branch, so only these
 * may reach it.
 */
function isKnownFrame(value: unknown): value is AgentChatStreamFrame {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "snapshot": {
      const thread = value.thread;
      return isRecord(thread) && isRecord(thread.head) && Array.isArray(thread.items) && typeof thread.seq === "number";
    }
    case "event":
      return typeof value.seq === "number" && isRecord(value.event) && typeof value.event.type === "string";
    case "synchronized":
      return typeof value.hostInstanceId === "string";
    case "history-import":
      return isRecord(value.progress);
    case "agent-rows":
      return typeof value.seq === "number" && Array.isArray(value.agentIds);
    default:
      return false;
  }
}

/** The thread a frame names, where it names one. */
function threadIdOf(frame: AgentChatStreamFrame): string | null {
  const id = frame.kind === "snapshot" ? frame.thread.head.id : frame.kind === "event" ? frame.event.threadId : null;
  return typeof id === "string" && id.length > 0 ? id : null;
}

const describe = (value: unknown): string =>
  isRecord(value) && typeof value.kind === "string" ? `kind "${value.kind}"` : typeof value;

// ---------------------------------------------------------------------------
// The thread
// ---------------------------------------------------------------------------

/** What one `push` asks of the element. */
export interface PushOutcome {
  /** A `synchronized` frame named another host instance (`needsResync`). */
  resync: boolean;
}

const pendingOf = (slice: AgentChatThreadSlice): EmbedPendingRequest[] => [
  ...slice.pending.approvals.map((approval) => ({ requestId: approval.requestId, kind: "approval" as const })),
  ...slice.pending.userInputs.map((input) => ({ requestId: input.requestId, kind: "question" as const }))
];

const samePending = (left: readonly EmbedPendingRequest[], right: readonly EmbedPendingRequest[]): boolean =>
  left.length === right.length &&
  left.every((entry, index) => entry.requestId === right[index]!.requestId && entry.kind === right[index]!.kind);

export class EmbedThread {
  private reducer: AgentChatReducerState = createReducerState("");
  private projection: Projection = EMPTY_PROJECTION;
  /** Bumped by `reset`: a read started before it lands on nothing. */
  private generation = 0;
  /** The one "load older" chain in flight; overlapping loads share it. */
  private historyInFlight: Promise<void> | null = null;
  private historyAbort: AbortController | null = null;
  /** The command in flight per request: what `respondFailed` names. */
  private commands = new Map<string, string>();
  private failure: EmbedThreadView["failure"] = null;
  private view: EmbedThreadView;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly readLoaders: () => EmbedLoaders) {
    this.view = this.makeView(null);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getView = (): EmbedThreadView => this.view;

  /**
   * Apply frames in order. One the bundle does not know is skipped with a
   * warning and changes nothing; so is an event of another thread, and a
   * frame the reducer throws on.
   */
  push(frames: readonly unknown[]): PushOutcome {
    let reducer = this.reducer;
    let resync = false;
    for (const frame of frames) {
      if (!isKnownFrame(frame)) {
        console.warn(`[orquester-agent-chat] Ignored a frame of ${describe(frame)}: not a frame this bundle knows.`);
        continue;
      }
      const threadId = threadIdOf(frame);
      const current = reducer.slice.sessionId;
      if (threadId !== null && current !== "" && threadId !== current && frame.kind === "event") {
        console.warn(`[orquester-agent-chat] Ignored an event of thread ${threadId}: this element shows ${current}. Call reset() first.`);
        continue;
      }
      try {
        const next = applyFrame(reducer, frame);
        resync ||= needsResync(reducer.hostInstanceId, frame);
        reducer =
          threadId !== null && next.slice.sessionId !== threadId
            ? { ...next, slice: { ...next.slice, sessionId: threadId } }
            : next;
      } catch (error) {
        console.warn(`[orquester-agent-chat] Ignored a frame of ${describe(frame)}: it could not be applied.`, error);
      }
    }
    if (reducer === this.reducer) return { resync };
    // The bridge is the one part of the history that grows on its own, so it
    // is held to its cap here, as the store does after every batch.
    const history = reducer.slice.history;
    if (history.bridge.length > this.reducer.slice.history.bridge.length) {
      const capped = historyWithinCap(history);
      if (capped.history !== history) reducer = patchSlice(reducer, { history: capped.history });
    }
    // A snapshot replaces loaded history: every layer cached against the old
    // one goes (the store's epoch rule).
    if (reducer.historyEpoch !== this.reducer.historyEpoch) this.projection = EMPTY_PROJECTION;
    this.commit(reducer);
    return { resync };
  }

  /** Empty the thread, dropping any read in flight. */
  reset(): void {
    this.generation += 1;
    this.historyAbort?.abort();
    this.historyAbort = null;
    this.historyInFlight = null;
    this.commands.clear();
    this.failure = null;
    this.projection = EMPTY_PROJECTION;
    this.commit(createReducerState(""));
  }

  setFollow(follow: boolean): void {
    this.commit(patchSlice(this.reducer, { follow }));
  }

  setDisclosure(patch: Partial<DisclosureState>): void {
    this.commit(patchSlice(this.reducer, { disclosures: { ...this.reducer.slice.disclosures, ...patch } }));
  }

  /** Whether "load older" can be offered: a loader, and something older to ask for. */
  canLoadOlder(): boolean {
    return this.readLoaders().history !== undefined && canLoadOlderHistory(this.reducer.slice.history);
  }

  /**
   * "Load older turns": the store's `loadHistoryPages`, asking the host's
   * `history` loader. Up to {@link HISTORY_PAGES_PER_LOAD} pages, one after
   * the other, past a page only while it showed no row the timeline did not
   * already show; `loading` holds for the whole chain.
   */
  loadOlder(): Promise<void> {
    if (this.historyInFlight !== null) return this.historyInFlight;
    const loader = this.readLoaders().history;
    const sessionId = this.reducer.slice.sessionId;
    if (loader === undefined || sessionId === "" || !canLoadOlderHistory(this.reducer.slice.history)) {
      return Promise.resolve();
    }
    const generation = this.generation;
    const closed = (): boolean => generation !== this.generation;
    const controller = new AbortController();
    this.historyAbort = controller;
    // From here until the chain ends, what the window evicts goes onto the
    // bridge (`historyAfterEvent` reads `loading`).
    this.patchHistory((history) => (history.loading ? history : { ...history, loading: true }));
    const run = (async (): Promise<void> => {
      for (let loaded = 0; loaded < HISTORY_PAGES_PER_LOAD; loaded += 1) {
        const asked = this.reducer.slice.history;
        if (loaded > 0 && !canLoadOlderHistory(asked)) break;
        const before = nextHistoryCursor(asked);
        const windowCut = nextHistoryWindowCut(asked);
        // A snapshot (or a rewind into a page, or the cap) replaces `pages`:
        // a page asked against the old ones belongs to a log this thread no
        // longer shows, and is dropped.
        const superseded = (history: AgentChatHistoryState): boolean =>
          history.pages !== asked.pages || history.bounds !== asked.bounds;
        let page: ThreadHistoryPage;
        try {
          page = await loader(
            {
              sessionId,
              ...(before === undefined ? {} : { before }),
              ...(windowCut === undefined ? {} : { windowCut }),
              turns: THREAD_HISTORY_DEFAULT_TURNS
            },
            controller.signal
          );
          if (!isHistoryPage(page)) throw new Error("Couldn't load older turns.");
        } catch (error) {
          if (closed()) return;
          this.patchHistory((history) =>
            withoutOrphanBridge(
              superseded(history)
                ? { ...history, loading: false }
                : { ...history, loading: false, error: historyErrorMessage(error) }
            )
          );
          return;
        }
        if (closed()) return;
        if (superseded(this.reducer.slice.history)) {
          this.patchHistory((history) => withoutOrphanBridge({ ...history, loading: false }));
          return;
        }
        const shown = this.projection.rows;
        const windowItems = this.reducer.slice.entries;
        this.patchHistory((history) => ({ ...historyWithPage(history, page, windowItems), error: null }));
        if (showsNewRow(shown, this.projection.rows)) break;
      }
      if (!closed()) this.patchHistory((history) => (history.loading ? { ...history, loading: false } : history));
    })().finally(() => {
      if (this.historyInFlight === run) this.historyInFlight = null;
      if (this.historyAbort === controller) this.historyAbort = null;
    });
    this.historyInFlight = run;
    return run;
  }

  /** An answer or decision for `requestId` went to the host under `commandId`. */
  beginResponding(requestId: string, commandId: string): void {
    this.commands.set(requestId, commandId);
    if (this.failure?.requestId === requestId) this.failure = null;
    const ids = this.reducer.slice.respondingRequestIds;
    this.commit(
      ids.includes(requestId) ? this.reducer : patchSlice(this.reducer, { respondingRequestIds: [...ids, requestId] }),
      true
    );
  }

  /** The host could not deliver `commandId`: its card takes input again. */
  respondFailed(commandId: string, message?: string): void {
    const requestId = [...this.commands].find(([, id]) => id === commandId)?.[0];
    if (requestId === undefined) return;
    this.commands.delete(requestId);
    this.failure = {
      requestId,
      message: typeof message === "string" && message.trim().length > 0 ? message.trim() : "Your answer could not be sent. Try again."
    };
    const ids = this.reducer.slice.respondingRequestIds.filter((id) => id !== requestId);
    this.commit(patchSlice(this.reducer, { respondingRequestIds: ids }), true);
  }

  private patchHistory(mutate: (history: AgentChatHistoryState) => AgentChatHistoryState): void {
    const history = mutate(this.reducer.slice.history);
    if (history !== this.reducer.slice.history) this.commit(patchSlice(this.reducer, { history }));
  }

  /**
   * Adopt a reducer state: a request that left the pending set has settled,
   * so its card's in-flight marker goes; re-project; tell the listeners.
   */
  private commit(reducer: AgentChatReducerState, force = false): void {
    if (reducer === this.reducer && !force) return;
    const open = new Set(pendingOf(reducer.slice).map((entry) => entry.requestId));
    const settled = reducer.slice.respondingRequestIds.filter((id) => !open.has(id));
    if (settled.length > 0) {
      for (const id of settled) this.commands.delete(id);
      reducer = patchSlice(reducer, {
        respondingRequestIds: reducer.slice.respondingRequestIds.filter((id) => open.has(id))
      });
    }
    if (this.failure !== null && !open.has(this.failure.requestId)) this.failure = null;
    this.reducer = reducer;
    this.projection = project(reducer, this.projection);
    this.view = this.makeView(this.view);
    for (const listener of [...this.listeners]) listener();
  }

  private makeView(previous: EmbedThreadView | null): EmbedThreadView {
    const slice = this.reducer.slice;
    const pending = pendingOf(slice);
    return {
      sessionId: slice.sessionId === "" ? null : slice.sessionId,
      slice,
      rows: this.projection.rows,
      retentionDropped: this.projection.retentionDropped,
      pending: previous !== null && samePending(previous.pending, pending) ? previous.pending : pending,
      failure: this.failure
    };
  }
}

/** A `GET …/history` answer, by the fields the history reads. */
function isHistoryPage(value: unknown): value is ThreadHistoryPage {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    Array.isArray(value.turns) &&
    Array.isArray(value.checkpoints) &&
    isRecord(value.page) &&
    (value.page.beforeCursor === null || typeof value.page.beforeCursor === "string")
  );
}
