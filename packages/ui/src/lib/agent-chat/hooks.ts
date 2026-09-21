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
  RuntimeSubagent
} from "@orquester/api/agent-chat";
import { deriveAgentPanelModel, emptyAgentPanelModel } from "@orquester/api/agent-chat";

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
  UseProviderSnapshot
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
  const actions = useThreadState(store, (state) => state.actions);

  return useMemo<AgentChatThreadView>(
    () => ({ slice, actions, rows, activePlan, actionableProposedPlan, reverting }),
    [slice, actions, rows, activePlan, actionableProposedPlan, reverting]
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
        pendingQuestions: slice.pending.userInputs.length
      }),
      turnStartedAt: latestTurn?.startedAt ?? null
    };
  }, [slice, rows, snapshot]);
};

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
  agentId: string | null
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
      previous?.timeline ?? null
    );
    const rows = deriveTimelineRowsWithState(
      {
        timelineEntries: timeline.entries,
        isWorking: false,
        activeTurnStartedAt: null,
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
  }, [agentId, entries, roster]);
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
 * The store's **fallback** draft for a thread.
 *
 * The composer owns the live draft (W13's `ChatComposer` plus its
 * `composer-bridge` handle); this one only holds what was returned to a thread
 * whose composer is not mounted — a queued message drained by an interrupt
 * while the user is on another tab — plus any attachments that came back with
 * it. A mounted composer should drain it once on mount.
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
