/**
 * Agent chat — the view-model hooks (spec §7.2, §7.5, §7.6).
 *
 * The **only** React file in `lib/agent-chat/`: everything these hooks return
 * is computed by the `*.logic.ts` modules beside them, so the logic is testable
 * without a renderer and the components have one seam.
 *
 * Each hook reads the per-thread zustand slice `store.ts` owns. The slice is
 * created on tab open and dropped on tab close (§7.2); the registry is
 * refcounted, so every consumer of a thread — each chat tab owns its
 * `AgentChatView` and composer (§7.1's placement note in `AgentChatView.tsx`)
 * — shares one stream, and a tab remounted within the dispose grace re-opens
 * none.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type {
  AgentPanelModel,
  ProviderSnapshot,
  RuntimeSubagent,
  ThreadCatalogResponse,
  ThreadHead,
  ThreadItem,
  ThreadSessionStatus,
  Turn
} from "@orquester/api/agent-chat";
import {
  deriveAgentPanelModel,
  emptyAgentPanelModel,
  isSettledTurnState,
  messageStreamingContext
} from "@orquester/api/agent-chat";

import { useApi } from "../../context/orquester-context";
import type {
  AgentChatPendingView,
  AgentChatRosterView,
  AgentChatStatusView,
  AgentChatThreadSlice,
  AgentChatThreadView,
  AgentChatTimelineRow,
  UseAgentChatPending,
  UseAgentChatRoster,
  UseAgentChatStatus,
  UseAgentChatThread,
  UseProviderSnapshot
} from "./contracts";
import {
  drillInAgentRow,
  EMPTY_AGENT_DRILL_IN,
  projectAgentDrillIn,
  type AgentDrillInDisclosures,
  type AgentDrillInProjection
} from "./drill-in.logic";
import { loadProviders, providerForRefId, providersStore } from "./providers";
import { parseThreadCatalogResponse } from "./thread-catalog";
import { isBackgroundShellItems, isBackgroundShellRow } from "./roster.logic";
import { resolveActivityLabel } from "./status.logic";
import {
  ensureThreadStore,
  releaseThreadStore,
  retainThreadStore,
  type AgentChatThreadState,
  type ThreadStore
} from "./store";

// ---------------------------------------------------------------------------
// Subscription plumbing
// ---------------------------------------------------------------------------

function useThreadStore(sessionId: string): ThreadStore {
  const api = useApi();
  const transport = api.agentChat;

  // The slice must exist during the FIRST render — `useSyncExternalStore`
  // needs a snapshot before any effect runs — so render only *ensures* it and
  // never counts a reference; the effect is the one that takes it. An entry
  // nobody holds is disposed after the grace period, so a render that never
  // commits cannot leak a stream.
  const store = useMemo(
    () => ensureThreadStore(sessionId, { transport }),
    [sessionId, transport]
  );

  useEffect(() => {
    retainThreadStore(sessionId, { transport });
    return () => {
      releaseThreadStore(sessionId);
    };
  }, [sessionId, transport]);

  return store;
}

function useThreadState<T>(store: ThreadStore, select: (state: AgentChatThreadState) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getState()),
    () => select(store.getState())
  );
}

// ---------------------------------------------------------------------------
// The four thread hooks
// ---------------------------------------------------------------------------

export const useAgentChatThread: UseAgentChatThread = (sessionId) => {
  const store = useThreadStore(sessionId);
  const slice = useThreadState(store, (state) => state.slice);
  const rows = useThreadState(store, (state) => state.rows);
  const activePlan = useThreadState(store, (state) => state.activePlan);
  const actionableProposedPlan = useThreadState(store, (state) => state.actionableProposedPlan);
  const reverting = useThreadState(store, (state) => state.reverting);
  const reveal = useThreadState(store, (state) => state.reveal);
  const actions = useThreadState(store, (state) => state.actions);

  return useMemo<AgentChatThreadView>(
    () => ({ slice, actions, rows, activePlan, actionableProposedPlan, reverting, reveal }),
    [slice, actions, rows, activePlan, actionableProposedPlan, reverting, reveal]
  );
};

/**
 * The slice fields the chat view's chrome reads — head, turns, status,
 * banners, queue, history, scroll — each through its own subscription. The
 * reducer keeps every one of them by identity while a reply streams, so a
 * text delta re-renders none of their readers (spec §7.2's first layer; T3's
 * "quiet" thread atoms). What a delta does move — `entries`, `rows`, `seq` —
 * is deliberately absent: the timeline reads its rows itself
 * ({@link useAgentChatThreadSelector}), and the view reads the few facts it
 * needs from them through narrow selectors that answer stable values.
 */
export type AgentChatThreadChrome = Pick<
  AgentChatThreadSlice,
  | "head"
  | "turns"
  | "checkpoints"
  | "connection"
  | "turnStatus"
  | "sessionStatus"
  | "contextWindow"
  | "errorBanner"
  | "scroll"
  | "queue"
  | "interactionMode"
  | "goal"
  | "historyImport"
  | "history"
  | "follow"
  | "disclosures"
>;

/** {@link useAgentChatThread} without what a streamed delta moves: see {@link AgentChatThreadChrome}. */
export function useAgentChatThreadChrome(
  sessionId: string
): Omit<AgentChatThreadView, "slice" | "rows"> & { slice: AgentChatThreadChrome } {
  const store = useThreadStore(sessionId);
  // The fold stamps `seq` and `updatedAt` on the head with every event, a
  // streamed delta included; the chrome reads neither, so it gets the head it
  // already has until something it does read moves (T3's quiet thread shell).
  const quietHeadRef = useRef<ThreadHead | null>(null);
  const head = useThreadState(store, (state) => {
    quietHeadRef.current = quietHead(quietHeadRef.current, state.slice.head);
    return quietHeadRef.current;
  });
  const turns = useThreadState(store, (state) => state.slice.turns);
  const checkpoints = useThreadState(store, (state) => state.slice.checkpoints);
  const connection = useThreadState(store, (state) => state.slice.connection);
  const turnStatus = useThreadState(store, (state) => state.slice.turnStatus);
  const sessionStatus = useThreadState(store, (state) => state.slice.sessionStatus);
  const contextWindow = useThreadState(store, (state) => state.slice.contextWindow);
  const errorBanner = useThreadState(store, (state) => state.slice.errorBanner);
  const scroll = useThreadState(store, (state) => state.slice.scroll);
  const queue = useThreadState(store, (state) => state.slice.queue);
  const interactionMode = useThreadState(store, (state) => state.slice.interactionMode);
  const goal = useThreadState(store, (state) => state.slice.goal);
  const historyImport = useThreadState(store, (state) => state.slice.historyImport);
  const history = useThreadState(store, (state) => state.slice.history);
  const follow = useThreadState(store, (state) => state.slice.follow);
  const disclosures = useThreadState(store, (state) => state.slice.disclosures);
  const activePlan = useThreadState(store, (state) => state.activePlan);
  const actionableProposedPlan = useThreadState(store, (state) => state.actionableProposedPlan);
  const reverting = useThreadState(store, (state) => state.reverting);
  const reveal = useThreadState(store, (state) => state.reveal);
  const actions = useThreadState(store, (state) => state.actions);

  const slice = useMemo<AgentChatThreadChrome>(
    () => ({
      head,
      turns,
      checkpoints,
      connection,
      turnStatus,
      sessionStatus,
      contextWindow,
      errorBanner,
      scroll,
      queue,
      interactionMode,
      goal,
      historyImport,
      history,
      follow,
      disclosures
    }),
    [
      head,
      turns,
      checkpoints,
      connection,
      turnStatus,
      sessionStatus,
      contextWindow,
      errorBanner,
      scroll,
      queue,
      interactionMode,
      goal,
      historyImport,
      history,
      follow,
      disclosures
    ]
  );
  return useMemo(
    () => ({ slice, actions, activePlan, actionableProposedPlan, reverting, reveal }),
    [slice, actions, activePlan, actionableProposedPlan, reverting, reveal]
  );
}

/**
 * `next`, or `previous` when the two differ only in the stamps every event
 * moves (`seq`, `updatedAt`): every other field compared by identity.
 */
// Adapted from T3 Code (MIT): packages/client-runtime/src/state/threadShell.ts
export function quietHead(previous: ThreadHead | null, next: ThreadHead | null): ThreadHead | null {
  if (previous === next || previous === null || next === null) return next;
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if (key === "seq" || key === "updatedAt") continue;
    if (previous[key as keyof ThreadHead] !== next[key as keyof ThreadHead]) return next;
  }
  return previous;
}

/**
 * The thread's whole state, read when it is needed — a keypress, a dialog's
 * preview — rather than subscribed to. Stable for the thread.
 */
export function useAgentChatThreadReader(sessionId: string): () => AgentChatThreadState {
  const store = useThreadStore(sessionId);
  return store.getState;
}

/**
 * ONE value of a thread's state, for a surface OUTSIDE the chat view (the
 * right rail's History) that must not re-render on every streamed token.
 * `select` must return a stable value — a field of the state, or a
 * derivation memoised on its inputs: a fresh object on every call re-renders
 * on every store update. Retains the thread's store as the other hooks do.
 */
export function useAgentChatThreadSelector<T>(
  sessionId: string,
  select: (state: AgentChatThreadState) => T
): T {
  const store = useThreadStore(sessionId);
  return useThreadState(store, select);
}

export const useAgentChatRoster: UseAgentChatRoster = (sessionId) => {
  const store = useThreadStore(sessionId);
  const agents = useThreadState(store, (state) => state.slice.roster);
  const backgroundLiveness = useThreadState(store, (state) => state.slice.backgroundLiveness);
  const stopping = useThreadState(store, (state) => state.stopping);
  const stoppingTaskIds = useThreadState(store, (state) => state.stoppingTaskIds);

  const panel = useMemo<AgentPanelModel>(
    () => (agents.length === 0 ? emptyAgentPanelModel() : deriveAgentPanelModel({ agents })),
    [agents]
  );

  return useMemo<AgentChatRosterView>(
    () => ({ agents, panel, backgroundLiveness, stopping, stoppingTaskIds }),
    [agents, panel, backgroundLiveness, stopping, stoppingTaskIds]
  );
};

const NO_ANSWERED_REQUEST_IDS: readonly string[] = [];
const NO_PENDING: AgentChatThreadSlice["pending"] = { approvals: [], userInputs: [] };

export const useAgentChatPending: UseAgentChatPending = (sessionId) => {
  const store = useThreadStore(sessionId);
  // A device-cache copy the host has not confirmed offers nothing to answer:
  // those requests may have been settled long since (`fromDeviceCache`).
  const pending = useThreadState(store, (state) =>
    state.slice.fromDeviceCache === true ? NO_PENDING : state.slice.pending
  );
  const respondingRequestIds = useThreadState(
    store,
    (state) => state.slice.respondingRequestIds
  );
  const answeredRequestIds = useThreadState(
    store,
    (state) => state.slice.answeredRequestIds ?? NO_ANSWERED_REQUEST_IDS
  );

  return useMemo<AgentChatPendingView>(
    () => ({
      approvals: pending.approvals,
      userInputs: pending.userInputs,
      respondingRequestIds,
      answeredRequestIds,
      totalCount: pending.approvals.length + pending.userInputs.length
    }),
    [pending, respondingRequestIds, answeredRequestIds]
  );
};

export const useAgentChatStatus: UseAgentChatStatus = (sessionId) => {
  const store = useThreadStore(sessionId);
  // Field by field, never the whole slice: a streamed delta moves `entries`
  // and `rows`, and none of what the status line shows.
  const sessionStatus = useThreadState(store, (state) => state.slice.sessionStatus);
  const turnStatus = useThreadState(store, (state) => state.slice.turnStatus);
  const connection = useThreadState(store, (state) => state.slice.connection);
  const contextWindow = useThreadState(store, (state) => state.slice.contextWindow);
  const backgroundLiveness = useThreadState(store, (state) => state.slice.backgroundLiveness);
  const pending = useThreadState(store, (state) => state.slice.pending);
  const turns = useThreadState(store, (state) => state.slice.turns);
  const refId = useThreadState(store, (state) => state.slice.head?.refId ?? "");
  // The live tool label, when there is one: the working row's label is a
  // self-ticking leaf, but the *text* comes from the row model (§7.6). A
  // string, so a delta that leaves it as it was re-renders nothing.
  const liveToolLabel = useThreadState(store, (state) => liveToolLabelOf(state.rows));
  // The same phase the timeline's live placeholders render, read off the store
  // rather than re-derived: the status line and the timeline must never
  // disagree about what the turn is doing (§7.6).
  const isCompacting = useThreadState(store, (state) => state.isCompacting);
  const snapshot = useProviderSnapshot(refId);

  return useMemo<AgentChatStatusView>(() => {
    const latestTurn = turns.at(-1) ?? null;
    return {
      sessionStatus,
      turnStatus,
      connection,
      contextWindow,
      // Degrade, never zeros: without a snapshot we do not claim a meter.
      reportsContextWindow: snapshot?.capabilities.reportsContextWindow ?? false,
      activityLabel: resolveActivityLabel({
        connection,
        sessionStatus,
        turnStatus,
        backgroundLiveness,
        liveToolLabel,
        pendingApprovals: pending.approvals.length,
        pendingQuestions: pending.userInputs.length,
        isCompacting
      }),
      // Only an UNSETTLED turn has a start time the status line may tick from.
      // Handing it the last turn's `startedAt` regardless of state left the
      // line showing "● Working 1m 19s" climbing forever against a server that
      // had reported `ready`/`completed` — and it survived a reload, because
      // the settled turn is in the snapshot (fix-wave E1). The status line
      // reads any non-null value as "a turn is running", so `null` is the
      // whole signal that it stopped.
      turnStartedAt: turnStartedAt(latestTurn, sessionStatus),
      isCompacting
    };
  }, [
    sessionStatus,
    turnStatus,
    connection,
    contextWindow,
    backgroundLiveness,
    pending,
    turns,
    liveToolLabel,
    snapshot,
    isCompacting
  ]);
};

/** The label of the timeline's (first) live tool row, or `null`. */
function liveToolLabelOf(rows: readonly AgentChatTimelineRow[]): string | null {
  const liveRow = rows.find((row) => row.kind === "work-live");
  return liveRow && liveRow.kind === "work-live" ? liveRow.entry.label : null;
}

/**
 * The start stamp the status line's live timer ticks from, or `null`.
 *
 * A turn is settled **by session status** (§5.1), so a session that is no
 * longer `running`/`starting` settles the row even when a late
 * `turn.completed` has not landed — which is exactly the race that left the
 * timer running.
 */
function turnStartedAt(
  latestTurn: Turn | null | undefined,
  sessionStatus: ThreadSessionStatus | null
): string | null {
  if (!latestTurn || latestTurn.startedAt === null) {
    return null;
  }
  if (isSettledTurnState(latestTurn.state)) {
    return null;
  }
  // `pending`/`running` only count while the session is actually live.
  if (sessionStatus !== "running" && sessionStatus !== "starting") {
    return null;
  }
  return latestTurn.startedAt;
}

const NO_TURNS: readonly string[] = [];

/** What {@link useAgentChatDrillIn} is asked for beyond the agent. */
export interface AgentChatDrillInOptions {
  /**
   * The drill-in's own disclosure state. Group toggles honour it; turn folds
   * start OPEN — the child's rows are the reason the view was opened, and a
   * fold keyed on the parent's turns would hide them behind one more click —
   * and the ones the user closed stay closed (`collapsedTurnIds`).
   */
  disclosures?: AgentDrillInDisclosures | null;
  /**
   * The row the drill-in last saw for this agent: read once the roster no
   * longer has one — it keeps 100 rows and evicts the oldest settled ones
   * first (`drillInAgentRow`).
   */
  lastKnownAgent?: RuntimeSubagent | null;
}

/** One drill-in, as {@link useAgentChatDrillIn} projects it. */
export interface AgentChatDrillInView {
  /** The agent's row: the roster's, else the one last seen (`drillInAgentRow`). */
  agent: RuntimeSubagent | null;
  /**
   * `agent` is the row last seen, not the roster's: its title and kind hold,
   * its status is not current, and it is never live (`DrillInAgent`).
   */
  agentRemembered: boolean;
  /**
   * A background shell's drill-in: its row says so, or — with no row at all —
   * its items (`isBackgroundShellItems`). Its rows are then `null`.
   */
  backgroundShell: boolean;
  /**
   * What the drill-in's timeline renders — the ONE projection of it, which the
   * timeline takes as it is. `null` for a background shell: its drill-in is
   * one row, its command, which the caller projects from {@link items}
   * (`roster/background-shell.ts`), so nothing is projected here for it.
   */
  rows: AgentChatTimelineRow[] | null;
  /** The thread's items: the parent's slice, never a second stream. */
  items: readonly ThreadItem[];
  /**
   * The turns whose fold is open (`AgentDrillInProjection.openTurnIds`): the
   * timeline's `expandedTurnIds`, whose patch `collapsedTurnsAfter` reads back.
   */
  openTurnIds: readonly string[];
  /** The thread's retained window has dropped rows (`AgentChatThreadState.retentionDropped`). */
  retentionDropped: boolean;
}

/**
 * The drill-in view: **one subagent's own timeline** (§7.6).
 *
 * Its prompt at the top, then its items filtered by `agentId`, streaming live,
 * rendered with the same row components, **read-only**. The parent's slice is
 * reused rather than opened again, which is what keeps the composer and roster
 * mounted so the parent can be steered while watching a child — and the child
 * view dispatches no commands, so no actions are returned. The rows are
 * `projectAgentDrillIn`'s (`drill-in.logic.ts`), projected here once per
 * change and rendered as they are: a second projection beside this one once
 * won whenever it had rows, and threw a background shell's own rows away. A
 * word streams while the thread's `messageStreamingContext` says it can still
 * be written.
 */
export function useAgentChatDrillIn(
  sessionId: string,
  agentId: string | null,
  options: AgentChatDrillInOptions = {}
): AgentChatDrillInView {
  const { disclosures, lastKnownAgent } = options;
  const store = useThreadStore(sessionId);
  const entries = useThreadState(store, (state) => state.slice.entries);
  const roster = useThreadState(store, (state) => state.slice.roster);
  // Memoised by the roster and the session, so this selector is stable.
  const messageStreaming = useThreadState(store, (state) => messageStreamingContext(state.slice));
  const retentionDropped = useThreadState(store, (state) => state.retentionDropped);

  // One projection per drill-in, held across renders so a streamed token in
  // the child's timeline changes one row object, exactly as in the parent.
  const projection = useRef<AgentDrillInProjection>(EMPTY_AGENT_DRILL_IN);

  return useMemo(() => {
    if (agentId === null) {
      return {
        rows: [],
        agent: null,
        agentRemembered: false,
        backgroundShell: false,
        items: entries,
        openTurnIds: NO_TURNS,
        retentionDropped
      };
    }
    const { row: agent, remembered: agentRemembered } = drillInAgentRow({
      agentId,
      roster,
      lastKnown: lastKnownAgent
    });
    // A shell by its row; with no row at all, by its items — a walk of the
    // window, only while no row is known.
    const backgroundShell = agent !== null ? isBackgroundShellRow(agent) : isBackgroundShellItems(entries, agentId);
    if (backgroundShell) {
      return { rows: null, agent, agentRemembered, backgroundShell, items: entries, openTurnIds: NO_TURNS, retentionDropped };
    }
    projection.current = projectAgentDrillIn(projection.current, {
      items: entries,
      agentId,
      // Its current run's start and its kind: a live agent reads live — by the
      // context's own notion, which a row the roster evicted is never in.
      messageStreaming,
      agent,
      disclosures
    });
    return {
      rows: projection.current.stable.result,
      agent,
      agentRemembered,
      backgroundShell,
      items: entries,
      openTurnIds: projection.current.openTurnIds,
      retentionDropped
    };
  }, [agentId, lastKnownAgent, entries, roster, messageStreaming, disclosures, retentionDropped]);
}

// ---------------------------------------------------------------------------
// Provider snapshots
// ---------------------------------------------------------------------------

export const useProviderSnapshot: UseProviderSnapshot = (refId) => {
  const api = useApi();
  const transport = api.agentChat;

  useEffect(() => {
    void loadProviders(transport);
  }, [transport]);

  const providers = useSyncExternalStore(
    providersStore.subscribe,
    () => providersStore.getState().providers,
    () => providersStore.getState().providers
  );

  return useMemo<ProviderSnapshot | null>(
    () => (refId ? providerForRefId(providers, refId) : null),
    [providers, refId]
  );
};

/** Every adapter's snapshot, for surfaces that list providers rather than one. */
export function useProviderSnapshots(): ProviderSnapshot[] {
  const api = useApi();
  const transport = api.agentChat;

  useEffect(() => {
    void loadProviders(transport);
  }, [transport]);

  return useSyncExternalStore(
    providersStore.subscribe,
    () => providersStore.getState().providers,
    () => providersStore.getState().providers
  );
}

/**
 * An Agent Profile chat's own `/` and `$` catalog (`GET …/catalog`), read when the chat or its
 * profile changes and again whenever `refreshKey` does (its session's status, a turn ending: a
 * live session reports what it loaded once it runs). `null` for a Global chat, while the first
 * read is in flight, or when it failed — `withThreadCatalog` then shows nothing rather than the
 * Global catalog. A later failed read keeps the last answer.
 */
export function useThreadCatalog(
  sessionId: string,
  profileId: string | null | undefined,
  refreshKey: string
): ThreadCatalogResponse | null {
  const api = useApi();
  const key = profileId ? `${sessionId}\u0000${profileId}` : null;
  const [answer, setAnswer] = useState<{ key: string; catalog: ThreadCatalogResponse } | null>(null);

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    void api.getThreadCatalog(sessionId, controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return;
        const catalog = parseThreadCatalogResponse(value, sessionId);
        if (catalog !== null) setAnswer({ key, catalog });
      },
      () => undefined
    );
    return () => controller.abort();
  }, [api, key, sessionId, refreshKey]);

  return answer !== null && answer.key === key ? answer.catalog : null;
}

/**
 * The thread's **persisted** draft, and the actions that write it.
 *
 * This is the durable copy of everything unsent: W13's `ChatComposer` loads it
 * on mount (and, defensively, on a thread swap), and saves it back on every
 * change, so a half-typed message outlives the component. It is also where a
 * queued message returned by an interrupt lands while no composer is mounted,
 * and where a failed send goes back once no composer shows its thread
 * (`updateThreadDraft`) — the next mount finds either there.
 */
export function useAgentChatDraft(sessionId: string): {
  draft: AgentChatThreadState["draft"];
  actions: AgentChatThreadState["actions"];
} {
  const store = useThreadStore(sessionId);
  const draft = useThreadState(store, (state) => state.draft);
  const actions = useThreadState(store, (state) => state.actions);
  return useMemo(() => ({ draft, actions }), [draft, actions]);
}
