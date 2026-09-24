/**
 * Builders shared by the agent-chat client tests. Not exported from the
 * barrel — test scaffolding, typechecked with everything else so a contract
 * change breaks it loudly.
 */

import type {
  DomainEvent,
  DomainEventType,
  ThreadActivityItem,
  ThreadActivityTone,
  ThreadHead,
  ThreadHistoryPage,
  ThreadHistoryTurn,
  ThreadMessageItem,
  ThreadSessionState,
  ThreadSnapshotPayload,
  Turn
} from "@orquester/api/agent-chat";

let seqCounter = 0;
let idCounter = 0;

export function resetBuilders(): void {
  seqCounter = 0;
  idCounter = 0;
}

export function stamp(n: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + n * 1000).toISOString();
}

export function ev<T extends DomainEventType>(
  type: T,
  payload: Extract<DomainEvent, { type: T }>["payload"],
  overrides: { seq?: number; threadId?: string; commandId?: string | null } = {}
): Extract<DomainEvent, { type: T }> {
  const seq = overrides.seq ?? ++seqCounter;
  if (overrides.seq !== undefined) {
    seqCounter = Math.max(seqCounter, overrides.seq);
  }
  return {
    seq,
    eventId: `e${seq}`,
    threadId: overrides.threadId ?? "s1",
    type,
    payload,
    occurredAt: stamp(seq),
    commandId: overrides.commandId ?? null,
    causationEventId: null,
    metadata: {}
  } as Extract<DomainEvent, { type: T }>;
}

export function head(overrides: Partial<ThreadHead> = {}): ThreadHead {
  const session: ThreadSessionState = { status: "ready", activeTurnId: null };
  return {
    id: "s1",
    projectPath: "/w/p",
    cwd: "/w/p",
    title: "New thread",
    adapter: "claude",
    refId: "claude",
    accountId: "acc-1",
    home: "account",
    modelSelection: { model: "sonnet" },
    runtimeMode: "approval-required",
    session,
    turnCount: 0,
    seq: 0,
    createdAt: stamp(0),
    updatedAt: stamp(0),
    ...overrides
  };
}

export function message(
  role: ThreadMessageItem["role"],
  text: string,
  overrides: Partial<ThreadMessageItem> = {}
): ThreadMessageItem {
  const n = ++idCounter;
  const at = overrides.createdAt ?? stamp(n);
  return {
    kind: "message",
    id: overrides.id ?? `m${n}`,
    role,
    text,
    turnId: overrides.turnId ?? null,
    streaming: overrides.streaming ?? false,
    createdAt: at,
    updatedAt: overrides.updatedAt ?? at,
    ...(overrides.agentId !== undefined ? { agentId: overrides.agentId } : {}),
    ...(overrides.attachments !== undefined ? { attachments: overrides.attachments } : {}),
    ...(overrides.context !== undefined ? { context: overrides.context } : {}),
    ...(overrides.messageKind !== undefined ? { messageKind: overrides.messageKind } : {}),
    ...(overrides.reasoningKind !== undefined ? { reasoningKind: overrides.reasoningKind } : {})
  };
}

export function activity(
  activityKind: string,
  payload: unknown,
  overrides: Partial<ThreadActivityItem> = {}
): ThreadActivityItem {
  const n = ++idCounter;
  const at = overrides.createdAt ?? stamp(n);
  return {
    kind: "activity",
    id: overrides.id ?? `a${n}`,
    tone: (overrides.tone ?? "tool") as ThreadActivityTone,
    activityKind,
    summary: overrides.summary ?? activityKind,
    payload,
    turnId: overrides.turnId ?? null,
    createdAt: at,
    updatedAt: overrides.updatedAt ?? at,
    ...(overrides.agentId !== undefined ? { agentId: overrides.agentId } : {}),
    ...(overrides.status !== undefined ? { status: overrides.status } : {})
  };
}

export function snapshot(
  overrides: Partial<ThreadSnapshotPayload> = {}
): ThreadSnapshotPayload {
  return {
    head: head(),
    items: [],
    turns: [],
    checkpoints: [],
    pending: { approvals: [], userInputs: [] },
    roster: [],
    seq: 0,
    ...overrides
  };
}

/** A fold turn row: started once the provider minted its id, pending before. */
export function foldTurn(turnId: string | null, userMessageId?: string): Turn {
  return {
    turnId,
    state: turnId === null ? "pending" : "completed",
    turnCount: null,
    requestedAt: stamp(0),
    startedAt: turnId === null ? null : stamp(0),
    completedAt: turnId === null ? null : stamp(0),
    assistantMessageId: null,
    ...(userMessageId !== undefined ? { userMessageId } : {})
  };
}

/** One turn of a `GET …/history` page, as the index reports it. */
export function historyTurn(
  turnId: string,
  ordinal: number,
  overrides: Partial<ThreadHistoryTurn> = {}
): ThreadHistoryTurn {
  return {
    turnId,
    ordinal,
    userMessageId: null,
    requestedAt: stamp(ordinal * 10),
    startedAt: stamp(ordinal * 10),
    completedAt: stamp(ordinal * 10 + 5),
    rewindable: true,
    ...overrides
  };
}

/** A `GET …/history` answer. */
export function historyPage(overrides: Partial<ThreadHistoryPage> = {}): ThreadHistoryPage {
  return {
    threadId: "s1",
    turns: [],
    items: [],
    checkpoints: [],
    page: { beforeCursor: null },
    seq: 0,
    ...overrides
  };
}
