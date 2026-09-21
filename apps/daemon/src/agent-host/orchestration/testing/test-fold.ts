/**
 * Agent host — a small fold used **only by the host's own tests** (spec §9).
 *
 * The one real fold is `@orquester/api/agent-chat`'s (package W2), and
 * production wires it through {@link import("../fold-ops.ts").DEFAULT_FOLD_OPS}.
 * This double exists so W1's orchestration — receipts, ordering, the settle
 * order, the compaction queue, the reconcile — can be asserted independently of
 * the projection's own progress. It implements only the arms those assertions
 * observe, and it is never imported by `main.ts`.
 */

import type {
  Checkpoint,
  DomainEvent,
  PendingApproval,
  PendingUserInput,
  ThreadFoldState,
  ThreadHead,
  ThreadItem,
  ThreadMessageItem,
  ThreadSnapshotPayload,
  Turn
} from "@orquester/api/agent-chat";
import { SETTLED_TURN_STATES, settledTurnStateForSessionStatus } from "@orquester/api/agent-chat";

import type { FoldOps } from "../fold-ops.ts";

function emptyState(): ThreadFoldState {
  return {
    head: null,
    items: [],
    itemIndex: new Map<string, number>(),
    turns: [],
    checkpoints: [],
    pending: { approvals: [], userInputs: [] },
    roster: [],
    closedRequestIds: new Set<string>(),
    seq: 0,
    deleted: false
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyActivity(state: ThreadFoldState, event: DomainEvent): void {
  if (event.type !== "thread.activity-appended") return;
  const activity = event.payload.activity;
  const existing = state.itemIndex.get(activity.id);
  if (existing !== undefined) {
    state.items[existing] = activity;
  } else {
    state.itemIndex.set(activity.id, state.items.length);
    state.items.push(activity);
  }
  const payload = isRecord(activity.payload) ? activity.payload : {};
  const requestId = typeof payload.requestId === "string" ? payload.requestId : null;
  if (requestId === null) return;

  switch (activity.activityKind) {
    case "approval.requested": {
      if (state.closedRequestIds.has(requestId)) return;
      const approval: PendingApproval = {
        requestId,
        requestKind:
          (payload.requestKind as PendingApproval["requestKind"] | undefined) ?? "permission",
        createdAt: activity.createdAt,
        ...(typeof payload.detail === "string" ? { detail: payload.detail } : {})
      };
      state.pending = {
        ...state.pending,
        approvals: [
          ...state.pending.approvals.filter((entry) => entry.requestId !== requestId),
          approval
        ]
      };
      return;
    }
    case "user-input.requested": {
      if (state.closedRequestIds.has(requestId)) return;
      const question: PendingUserInput = {
        requestId,
        createdAt: activity.createdAt,
        questions: Array.isArray(payload.questions)
          ? (payload.questions as PendingUserInput["questions"])
          : [],
        dismissible: payload.responseMode === "message" || payload.dismissible === true
      };
      state.pending = {
        ...state.pending,
        userInputs: [
          ...state.pending.userInputs.filter((entry) => entry.requestId !== requestId),
          question
        ]
      };
      return;
    }
    case "approval.resolved":
    case "user-input.resolved": {
      // The tombstone set: a resolved row closes the request id permanently.
      state.closedRequestIds.add(requestId);
      state.pending = {
        approvals: state.pending.approvals.filter((entry) => entry.requestId !== requestId),
        userInputs: state.pending.userInputs.filter((entry) => entry.requestId !== requestId)
      };
      return;
    }
    default:
      return;
  }
}

function settleTurns(state: ThreadFoldState, status: ThreadHead["session"]["status"], at: string): void {
  const settled = settledTurnStateForSessionStatus(status);
  if (settled === null) return;
  state.turns = state.turns.map((turn) =>
    SETTLED_TURN_STATES.has(turn.state)
      ? turn
      : { ...turn, state: settled, completedAt: turn.completedAt ?? at }
  );
}

function applyEvent(state: ThreadFoldState, event: DomainEvent): ThreadFoldState {
  if (event.seq <= state.seq) {
    return state;
  }
  const next: ThreadFoldState = {
    ...state,
    items: [...state.items],
    itemIndex: new Map(state.itemIndex),
    turns: [...state.turns],
    checkpoints: [...state.checkpoints],
    pending: {
      approvals: [...state.pending.approvals],
      userInputs: [...state.pending.userInputs]
    },
    roster: [...state.roster],
    closedRequestIds: new Set(state.closedRequestIds),
    seq: event.seq
  };

  switch (event.type) {
    case "thread.created": {
      const payload = event.payload;
      next.head = {
        id: event.threadId,
        projectPath: payload.projectPath,
        cwd: payload.cwd,
        title: payload.title,
        adapter: payload.adapter,
        refId: payload.refId,
        accountId: payload.accountId,
        home: payload.home,
        modelSelection: payload.modelSelection,
        runtimeMode: payload.runtimeMode,
        session: { status: "idle", activeTurnId: null },
        turnCount: 0,
        seq: event.seq,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt
      };
      break;
    }
    case "thread.meta-updated": {
      if (!next.head) break;
      next.head = {
        ...next.head,
        ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: event.payload.modelSelection }
          : {}),
        updatedAt: event.occurredAt
      };
      break;
    }
    case "thread.runtime-mode-set": {
      if (!next.head) break;
      next.head = {
        ...next.head,
        runtimeMode: event.payload.runtimeMode,
        updatedAt: event.occurredAt
      };
      break;
    }
    case "thread.message-sent": {
      const payload = event.payload;
      const index = next.itemIndex.get(payload.messageId);
      if (index === undefined) {
        const message: ThreadMessageItem = {
          kind: "message",
          id: payload.messageId,
          role: payload.role,
          text: payload.text,
          turnId: payload.turnId,
          streaming: payload.streaming,
          ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
          ...(payload.context !== undefined ? { context: payload.context } : {}),
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt
        };
        next.itemIndex.set(payload.messageId, next.items.length);
        next.items.push(message);
      } else {
        const existing = next.items[index] as ThreadMessageItem;
        const text = payload.streaming
          ? existing.text + payload.text
          : payload.text.length > 0
            ? payload.text
            : existing.text;
        next.items[index] = {
          ...existing,
          text,
          streaming: payload.streaming,
          updatedAt: event.occurredAt
        };
      }
      break;
    }
    case "thread.turn-start-requested": {
      const turn: Turn = {
        turnId: event.payload.turnId,
        state: "pending",
        turnCount: null,
        requestedAt: event.occurredAt,
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
        interactionMode: event.payload.interactionMode
      };
      next.turns.push(turn);
      break;
    }
    case "thread.session-set": {
      if (!next.head) break;
      const session = event.payload.session;
      next.head = { ...next.head, session, updatedAt: event.occurredAt };
      if (session.activeTurnId !== null) {
        const pendingIndex = next.turns.findIndex(
          (turn) => turn.state === "pending" || turn.turnId === session.activeTurnId
        );
        if (pendingIndex >= 0) {
          const turn = next.turns[pendingIndex]!;
          next.turns[pendingIndex] = {
            ...turn,
            turnId: session.activeTurnId,
            state: "running",
            startedAt: turn.startedAt ?? event.occurredAt
          };
        }
      } else {
        settleTurns(next, session.status, event.occurredAt);
      }
      break;
    }
    case "thread.activity-appended": {
      applyActivity(next, event);
      break;
    }
    case "thread.turn-diff-completed": {
      const payload = event.payload;
      const checkpoint: Checkpoint = {
        turnId: payload.turnId,
        checkpointTurnCount: payload.turnCount,
        checkpointRef: payload.ref,
        status: payload.status,
        files: payload.files,
        assistantMessageId: payload.assistantMessageId,
        completedAt: payload.completedAt
      };
      next.checkpoints = [
        ...next.checkpoints.filter(
          (entry) => entry.checkpointTurnCount !== payload.turnCount
        ),
        checkpoint
      ];
      if (next.head) {
        next.head = {
          ...next.head,
          turnCount: next.checkpoints.reduce(
            (max, entry) => Math.max(max, entry.checkpointTurnCount),
            0
          )
        };
      }
      break;
    }
    case "thread.reverted": {
      const target = event.payload.turnCount;
      next.checkpoints = next.checkpoints.filter(
        (entry) => entry.checkpointTurnCount <= target
      );
      const retained = new Set(
        next.checkpoints.map((entry) => entry.turnId).filter((id): id is string => id !== null)
      );
      next.items = next.items.filter(
        (item) => item.turnId === null || retained.has(item.turnId)
      );
      next.itemIndex = new Map(next.items.map((item, index) => [item.id, index]));
      next.turns = next.turns.filter(
        (turn) => turn.turnId === null || retained.has(turn.turnId)
      );
      if (next.head) {
        next.head = { ...next.head, turnCount: target, updatedAt: event.occurredAt };
      }
      break;
    }
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
    case "thread.turn-interrupt-requested":
    case "thread.checkpoint-revert-requested":
      break;
    case "thread.deleted": {
      next.deleted = true;
      break;
    }
    default: {
      const never: never = event;
      void never;
    }
  }

  if (next.head) {
    next.head = { ...next.head, seq: event.seq };
  }
  return next;
}

function snapshot(state: ThreadFoldState): ThreadSnapshotPayload {
  if (!state.head) {
    throw new Error("test-fold: cannot project a thread that was never created.");
  }
  const items: ThreadItem[] = [...state.items];
  return {
    head: state.head,
    items,
    turns: [...state.turns],
    checkpoints: [...state.checkpoints],
    pending: {
      approvals: [...state.pending.approvals],
      userInputs: [...state.pending.userInputs]
    },
    roster: [...state.roster],
    seq: state.seq
  };
}

export const TEST_FOLD_OPS: FoldOps = {
  createEmpty: emptyState,
  apply: applyEvent,
  foldAll(events: Iterable<DomainEvent>): ThreadFoldState {
    let state = emptyState();
    for (const event of events) {
      state = applyEvent(state, event);
    }
    return state;
  },
  snapshot
};
