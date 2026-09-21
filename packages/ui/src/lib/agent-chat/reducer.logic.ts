/**
 * Agent chat — the client reducer (spec §6.3 client side, §6.6, §7.2).
 *
 * One definition of "what the thread looks like after these events" is shared
 * with the host: the fold is `@orquester/api/agent-chat`'s `applyDomainEvent`
 * (package W2). This module owns only what is client-specific — turning
 * `snapshot` / `event` / `synchronized` frames into the `AgentChatThreadSlice`
 * the hooks read, the sequence floor, and the host-instance rule.
 *
 * Nothing here imports React or zustand.
 */

import {
  applyDomainEvent as defaultApplyDomainEvent,
  createEmptyThreadState,
  DEFAULT_INTERACTION_MODE,
  isSettledTurnState,
  type AgentChatStreamFrame,
  type DomainEvent,
  type PendingRequests,
  type ThreadActivityItem,
  type ThreadFoldState,
  type ThreadItem,
  type ThreadSnapshotPayload,
  type TurnState
} from "@orquester/api/agent-chat";

import type {
  AgentChatConnectionState,
  AgentChatThreadSlice,
  DisclosureState
} from "./contracts";

/**
 * The fold is W2's. It is injected rather than imported at the call site so a
 * test can drive the reducer with a hand-written fold, and so this package
 * stayed testable while W2 was still landing.
 */
export interface FoldOps {
  applyDomainEvent(state: ThreadFoldState, event: DomainEvent): ThreadFoldState;
}

export const DEFAULT_FOLD_OPS: FoldOps = {
  applyDomainEvent: defaultApplyDomainEvent
};

/** The whole per-thread reducer state: the shared fold plus the client's view. */
export interface AgentChatReducerState {
  /** W2's fold. The single source of items / turns / checkpoints / pending / roster. */
  fold: ThreadFoldState;
  /** What the hooks read. Field identities are preserved whenever the fold is. */
  slice: AgentChatThreadSlice;
  /** The last `synchronized` instance id; a change is a resync, not a resume (§6.3). */
  hostInstanceId: string | null;
  /**
   * Bumped by every `snapshot`. A snapshot REPLACES loaded history rather than
   * merging into it, so anything the UI cached against the old history (row
   * projections, remembered scroll anchors) must be invalidated by identity.
   *
   * *T3: `packages/client-runtime/src/state/threads.ts:446-458` — the history epoch.*
   */
  historyEpoch: number;
}

export const EMPTY_DISCLOSURES: DisclosureState = {
  expandedTurnIds: [],
  expandedGroupIds: [],
  expandedAgentIds: [],
  expandedReasoningIds: [],
  toolOutputOffsets: {}
};

const EMPTY_ITEMS: ThreadItem[] = [];
const EMPTY_PENDING: PendingRequests = { approvals: [], userInputs: [] };

/** W2's empty fold. Re-exported through a local name so the seam is one import. */
const emptyFold = createEmptyThreadState;

/** A slice for a thread whose stream has not produced anything yet. */
export function emptySlice(sessionId: string): AgentChatThreadSlice {
  return {
    sessionId,
    head: null,
    entries: EMPTY_ITEMS,
    turns: [],
    checkpoints: [],
    pending: EMPTY_PENDING,
    roster: [],
    turnStatus: null,
    sessionStatus: null,
    backgroundLiveness: null,
    contextWindow: null,
    seq: 0,
    connection: "idle",
    follow: true,
    scroll: null,
    disclosures: EMPTY_DISCLOSURES,
    interactionMode: DEFAULT_INTERACTION_MODE,
    queue: [],
    respondingRequestIds: [],
    errorBanner: null,
    reverting: false
  };
}

export function createReducerState(sessionId: string): AgentChatReducerState {
  return {
    fold: emptyFold(),
    slice: emptySlice(sessionId),
    hostInstanceId: null,
    historyEpoch: 0
  };
}

// ---------------------------------------------------------------------------
// Snapshot → fold state
// ---------------------------------------------------------------------------

const isActivity = (item: ThreadItem): item is ThreadActivityItem => item.kind === "activity";

const requestIdOf = (activity: ThreadActivityItem): string | null => {
  const payload = activity.payload;
  if (typeof payload === "object" && payload !== null) {
    const value = (payload as Record<string, unknown>).requestId;
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
};

/**
 * Rebuild a fold state from a §6.3 snapshot.
 *
 * The inverse of W2's `toThreadSnapshot`, with one derivation the payload does
 * not carry: the tombstone set. A snapshot lists only *open* requests, so the
 * ids of every `*.resolved` row still in `items` are re-tombstoned — without
 * that, a replayed `*.requested` arriving after the snapshot (which the
 * overlapping windows of §6.6 make legal) would reopen an answered card.
 */
export function foldStateFromSnapshot(snapshot: ThreadSnapshotPayload): ThreadFoldState {
  const itemIndex = new Map<string, number>();
  const closedRequestIds = new Set<string>();
  // The activity subset, same objects and same order — W2's fold keeps it
  // beside `items` because every derivation over it is activity-only.
  const activities: ThreadActivityItem[] = [];
  snapshot.items.forEach((item, index) => {
    itemIndex.set(item.id, index);
    if (isActivity(item)) {
      activities.push(item);
      if (item.activityKind.endsWith(".resolved")) {
        const requestId = requestIdOf(item);
        if (requestId !== null) {
          closedRequestIds.add(requestId);
        }
      }
    }
  });
  return {
    head: snapshot.head,
    items: snapshot.items,
    itemIndex,
    activities,
    turns: snapshot.turns,
    checkpoints: snapshot.checkpoints,
    pending: snapshot.pending,
    roster: snapshot.roster,
    closedRequestIds,
    seq: snapshot.seq,
    deleted: false
  };
}

// ---------------------------------------------------------------------------
// Fold → slice
// ---------------------------------------------------------------------------

/** §5.1: a turn is settled by session status; `deriveLatestTurn`'s row, locally. */
function latestTurnState(fold: ThreadFoldState): TurnState | null {
  const latest = fold.turns.at(-1);
  return latest ? latest.state : null;
}

/**
 * Re-project the slice from a fold, keeping **every** field identity that did
 * not change. This is the first of the three memoisation layers §7.2 names:
 * one streamed token changes `entries` and nothing else, so the row layers
 * above can take their own fast paths.
 */
export function projectSlice(
  previous: AgentChatThreadSlice,
  fold: ThreadFoldState
): AgentChatThreadSlice {
  const turnStatus = latestTurnState(fold);
  const sessionStatus = fold.head?.session.status ?? null;
  if (
    previous.head === fold.head &&
    previous.entries === fold.items &&
    previous.turns === fold.turns &&
    previous.checkpoints === fold.checkpoints &&
    previous.pending === fold.pending &&
    previous.roster === fold.roster &&
    previous.seq === fold.seq &&
    previous.turnStatus === turnStatus &&
    previous.sessionStatus === sessionStatus
  ) {
    return previous;
  }
  return {
    ...previous,
    head: fold.head,
    entries: fold.items,
    turns: fold.turns,
    checkpoints: fold.checkpoints,
    pending: fold.pending,
    roster: fold.roster,
    seq: fold.seq,
    turnStatus,
    sessionStatus
  };
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * Apply one stream frame.
 *
 * - `snapshot` **replaces** loaded history (§6.6) and bumps the history epoch.
 *   The queue, drafts, disclosures and scroll are client-local and survive it.
 * - `event` is dropped at or below the cursor — that is what makes the
 *   overlapping snapshot / replay / live windows safe.
 * - `synchronized` marks the stream live. A **different** `hostInstanceId`
 *   means the host restarted under us: the caller must re-read rather than
 *   resume, so the connection goes back to `connecting` and
 *   {@link needsResync} answers true.
 */
export function applyFrame(
  state: AgentChatReducerState,
  frame: AgentChatStreamFrame,
  ops: FoldOps = DEFAULT_FOLD_OPS
): AgentChatReducerState {
  switch (frame.kind) {
    case "snapshot": {
      const fold = foldStateFromSnapshot(frame.thread);
      return {
        ...state,
        fold,
        slice: projectSlice({ ...state.slice, connection: "connecting" }, fold),
        historyEpoch: state.historyEpoch + 1
      };
    }
    case "event": {
      if (frame.seq <= state.fold.seq) {
        return state;
      }
      const fold = ops.applyDomainEvent(state.fold, frame.event);
      if (fold === state.fold) {
        return state;
      }
      return { ...state, fold, slice: projectSlice(state.slice, fold) };
    }
    case "synchronized": {
      const changed =
        state.hostInstanceId !== null && state.hostInstanceId !== frame.hostInstanceId;
      const connection: AgentChatConnectionState = changed ? "connecting" : "synchronized";
      if (!changed && state.slice.connection === "synchronized") {
        return state.hostInstanceId === frame.hostInstanceId
          ? state
          : { ...state, hostInstanceId: frame.hostInstanceId };
      }
      return {
        ...state,
        hostInstanceId: frame.hostInstanceId,
        slice: { ...state.slice, connection }
      };
    }
  }
}

/** True when the host that answered is not the one we were following (§6.3, §8). */
export function needsResync(previousInstanceId: string | null, frame: AgentChatStreamFrame): boolean {
  return (
    frame.kind === "synchronized" &&
    previousInstanceId !== null &&
    previousInstanceId !== frame.hostInstanceId
  );
}

/** Apply a batch in wire order. Convenience for replays and tests. */
export function applyFrames(
  state: AgentChatReducerState,
  frames: readonly AgentChatStreamFrame[],
  ops: FoldOps = DEFAULT_FOLD_OPS
): AgentChatReducerState {
  return frames.reduce((acc, frame) => applyFrame(acc, frame, ops), state);
}

// ---------------------------------------------------------------------------
// Client-local view mutations
// ---------------------------------------------------------------------------

/** Set the connection state, preserving identity when it did not move. */
export function withConnection(
  state: AgentChatReducerState,
  connection: AgentChatConnectionState
): AgentChatReducerState {
  if (state.slice.connection === connection) {
    return state;
  }
  return { ...state, slice: { ...state.slice, connection } };
}

/** Patch the client-local view fields of the slice. */
export function patchSlice(
  state: AgentChatReducerState,
  patch: Partial<AgentChatThreadSlice>
): AgentChatReducerState {
  let changed = false;
  for (const key of Object.keys(patch) as Array<keyof AgentChatThreadSlice>) {
    if (patch[key] !== undefined && state.slice[key] !== patch[key]) {
      changed = true;
      break;
    }
  }
  if (!changed) {
    return state;
  }
  return { ...state, slice: { ...state.slice, ...patch } };
}

/** The latest turn is settled — the composer's primary action reads this (§7.4). */
export function latestTurnSettled(slice: AgentChatThreadSlice): boolean {
  return slice.turnStatus === null || isSettledTurnState(slice.turnStatus);
}
