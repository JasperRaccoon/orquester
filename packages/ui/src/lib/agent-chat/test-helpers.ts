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
  ThreadMessageItem,
  ThreadSessionState,
  ThreadSnapshotPayload
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
    ...(overrides.context !== undefined ? { context: overrides.context } : {})
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
