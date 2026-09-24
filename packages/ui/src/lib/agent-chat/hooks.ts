/**
 * Agent chat — the view-model hooks (spec §7.2, §7.5, §7.6).
 *
 * The **only** React file in `lib/agent-chat/`: everything these hooks return
 * is computed by the `*.logic.ts` modules beside them, so the logic is testable
 * without a renderer and the components have one seam.
 *
 * Each hook reads the per-thread zustand slice `store.ts` owns. The slice is
 * created on tab open and dropped on tab close (§7.2); the registry is
 * refcounted so one `AgentChatView` instance serving every chat tab in a
 * project (§7.1) never re-opens a stream on a tab switch.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import type {
  AgentPanelModel,
  ProviderSnapshot,
  RuntimeSubagent,
  ThreadSessionStatus,
  Turn
} from "@orquester/api/agent-chat";
import {
  deriveAgentPanelModel,
  emptyAgentPanelModel,
  isSettledTurnState
} from "@orquester/api/agent-chat";

import { useApi } from "../../context/orquester-context";
import type {
  AgentChatPendingView,
  AgentChatRosterView,
  AgentChatStatusView,
  AgentChatThreadView,
  AgentChatTimelineRow,
  UseAgentChatPending,
  UseAgentChatRoster,
  UseAgentChatStatus,
  UseAgentChatThread,
  UseProviderSnapshot,
  DisclosureState
} from "./contracts";
import {
  deriveTimelineEntriesFromItems,
  EMPTY_TIMELINE_PROJECTION,
  itemsForAgent,
  type ThreadTimelineProjection
} from "./entries.logic";
import {
  computeStableRows,
  deriveTimelineRowsWithState,
  EMPTY_STABLE_ROWS,
  type StableRowsState,
  type TimelineRowsProjection
} from "./rows.logic";
import { loadProviders, providerForRefId, providersStore } from "./providers";
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

export const useAgentChatRoster: UseAgentChatRoster = (sessionId) => {
  const store = useThreadStore(sessionId);
  const agents = useThreadState(store, (state) => state.slice.roster);
  const backgroundLiveness = useThreadState(store, (state) => state.slice.backgroundLiveness);
  const stopping = useThreadState(store, (state) => state.stopping);

  const panel = useMemo<AgentPanelModel>(
    () => (agents.length === 0 ? emptyAgentPanelModel() : deriveAgentPanelModel({ agents })),
    [agents]
  );

  return useMemo<AgentChatRosterView>(
    () => ({ agents, panel, backgroundLiveness, stopping }),
    [agents, panel, backgroundLiveness, stopping]
  );
};

export const useAgentChatPending: UseAgentChatPending = (sessionId) => {
  const store = useThreadStore(sessionId);
  const pending = useThreadState(store, (state) => state.slice.pending);
  const respondingRequestIds = useThreadState(
    store,
    (state) => state.slice.respondingRequestIds
  );

  return useMemo<AgentChatPendingView>(
    () => ({
      approvals: pending.approvals,
      userInputs: pending.userInputs,
      respondingRequestIds,
      totalCount: pending.approvals.length + pending.userInputs.length
    }),
    [pending, respondingRequestIds]
  );
};

export const useAgentChatStatus: UseAgentChatStatus = (sessionId) => {
  const store = useThreadStore(sessionId);
  const slice = useThreadState(store, (state) => state.slice);
  const rows = useThreadState(store, (state) => state.rows);
  // The same phase the timeline's live placeholders render, read off the store
  // rather than re-derived: the status line and the timeline must never
  // disagree about what the turn is doing (§7.6).
  const isCompacting = useThreadState(store, (state) => state.isCompacting);
  const snapshot = useProviderSnapshot(slice.head?.refId ?? "");

  return useMemo<AgentChatStatusView>(() => {
    const latestTurn = slice.turns.at(-1) ?? null;
    // The live tool label, when there is one: the working row's label is a
    // self-ticking leaf, but the *text* comes from the row model (§7.6).
    const liveRow = rows.find((row) => row.kind === "work-live");
    const liveToolLabel = liveRow && liveRow.kind === "work-live" ? liveRow.entry.label : null;
    return {
      sessionStatus: slice.sessionStatus,
      turnStatus: slice.turnStatus,
      connection: slice.connection,
      contextWindow: slice.contextWindow,
      // Degrade, never zeros: without a snapshot we do not claim a meter.
      reportsContextWindow: snapshot?.capabilities.reportsContextWindow ?? false,
      activityLabel: resolveActivityLabel({
        connection: slice.connection,
        sessionStatus: slice.sessionStatus,
        turnStatus: slice.turnStatus,
        backgroundLiveness: slice.backgroundLiveness,
        liveToolLabel,
        pendingApprovals: slice.pending.approvals.length,
        pendingQuestions: slice.pending.userInputs.length,
        isCompacting
      }),
      // Only an UNSETTLED turn has a start time the status line may tick from.
      // Handing it the last turn's `startedAt` regardless of state left the
      // line showing "● Working 1m 19s" climbing forever against a server that
      // had reported `ready`/`completed` — and it survived a reload, because
      // the settled turn is in the snapshot (fix-wave E1). The status line
      // reads any non-null value as "a turn is running", so `null` is the
      // whole signal that it stopped.
      turnStartedAt: turnStartedAt(latestTurn, slice.sessionStatus)
    };
  }, [slice, rows, snapshot, isCompacting]);
};

/**
 * The start stamp the status line's live timer ticks from, or `null`.
 *
 * A turn is settled **by session status** (§5.1), so a session that is no
 * longer `running`/`starting` settles the row even when a late
 * `turn.completed` has not landed — which is exactly the race that left the
 * timer running.
 */
export function turnStartedAt(
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

/**
 * The drill-in view: **one subagent's own timeline** (§7.6).
 *
 * Its prompt at the top, then its items filtered by `agentId`, streaming live,
 * rendered with the same row components, **read-only**. The parent's slice is
 * reused rather than opened again, which is what keeps the composer and roster
 * mounted so the parent can be steered while watching a child — and the child
 * view dispatches no commands, so no actions are returned.
 */
export function useAgentChatDrillIn(
  sessionId: string,
  agentId: string | null,
  /**
   * The drill-in's own disclosure state. Group toggles honour it; turn folds
   * start OPEN — the child's rows are the reason the view was opened, and a
   * fold keyed on the parent's turns would hide them behind one more click.
   */
  disclosures?: Pick<DisclosureState, "expandedGroupIds" | "expandedTurnIds"> | null
): { rows: AgentChatTimelineRow[]; agent: RuntimeSubagent | null } {
  const store = useThreadStore(sessionId);
  const entries = useThreadState(store, (state) => state.slice.entries);
  const roster = useThreadState(store, (state) => state.slice.roster);

  // One projection per drill-in, held across renders so a streamed token in
  // the child's timeline changes one row object, exactly as in the parent.
  const projections = useRef<{
    agentId: string | null;
    timeline: ThreadTimelineProjection;
    rows: TimelineRowsProjection | null;
    stable: StableRowsState;
  }>({ agentId: null, timeline: EMPTY_TIMELINE_PROJECTION, rows: null, stable: EMPTY_STABLE_ROWS });

  return useMemo(() => {
    if (agentId === null) {
      return { rows: [], agent: null };
    }
    const held = projections.current;
    // A different child is a different timeline: never reuse the previous
    // agent's projection as the fast path's baseline.
    const previous = held.agentId === agentId ? held : null;
    const timeline = deriveTimelineEntriesFromItems(
      itemsForAgent(entries, agentId),
      previous?.timeline ?? null,
      // The agent's own rows are agent-internal to the parent, not to itself.
      { ownerAgentId: agentId }
    );
    const expandedTurnIds = new Set<string>(disclosures?.expandedTurnIds ?? []);
    for (const entry of timeline.entries) {
      const turnId =
        entry.kind === "message"
          ? entry.message.turnId
          : entry.kind === "work"
            ? entry.entry.turnId
            : null;
      if (typeof turnId === "string" && turnId.length > 0) {
        expandedTurnIds.add(turnId);
      }
    }
    const rows = deriveTimelineRowsWithState(
      {
        timelineEntries: timeline.entries,
        isWorking: false,
        activeTurnStartedAt: null,
        expandedTurnIds,
        expandedWorkGroupIds: new Set(disclosures?.expandedGroupIds ?? []),
        // A child timeline offers no rewind: §5.5 rolls back the thread, and
        // a subagent has no turn of the thread's own to roll back to.
        supportsConversationRollback: false
      },
      previous?.rows ?? null
    );
    const stable = computeStableRows(rows.rows, previous?.stable ?? EMPTY_STABLE_ROWS);
    projections.current = { agentId, timeline, rows, stable };
    return {
      rows: stable.result,
      agent: roster.find((candidate) => candidate.id === agentId) ?? null
    };
  }, [agentId, entries, roster, disclosures]);
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
 * The thread's **persisted** draft, and the actions that write it.
 *
 * This is the durable copy of everything unsent: W13's `ChatComposer` loads it
 * on mount and on a thread swap, and saves it back on every change, so a
 * half-typed message outlives the component. It is also where a queued message
 * returned by an interrupt lands while no composer is mounted, and where a
 * failed send goes back once no composer shows its thread (`updateThreadDraft`)
 * — the next mount finds either there.
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
