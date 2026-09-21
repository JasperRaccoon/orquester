/**
 * Builders shared by the agent-chat fold tests. Not exported from the package
 * barrel — this is test scaffolding, typechecked with everything else so a
 * contract change breaks it loudly.
 */

import type { DomainEvent, DomainEventType } from "./domain-events.ts";
import type {
  ThreadActivityItem,
  ThreadActivityTone,
  ThreadSessionState
} from "./thread.ts";

let seqCounter = 0;

/** Reset the auto-incrementing sequence between tests. */
export function resetSeq(): void {
  seqCounter = 0;
}

function stamp(seq: number): string {
  // Monotonic, lexicographically ordered, and stable across runs.
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + seq * 1000).toISOString();
}

type EventOverrides = {
  seq?: number;
  threadId?: string;
  occurredAt?: string;
  commandId?: string | null;
  eventId?: string;
};

/** Build one domain event of `type` with `payload`, stamping a fresh `seq`. */
export function ev<T extends DomainEventType>(
  type: T,
  payload: Extract<DomainEvent, { type: T }>["payload"],
  overrides: EventOverrides = {}
): Extract<DomainEvent, { type: T }> {
  const seq = overrides.seq ?? ++seqCounter;
  if (overrides.seq !== undefined) {
    seqCounter = Math.max(seqCounter, overrides.seq);
  }
  return {
    seq,
    eventId: overrides.eventId ?? `e${seq}`,
    threadId: overrides.threadId ?? "thread-1",
    type,
    payload,
    occurredAt: overrides.occurredAt ?? stamp(seq),
    commandId: overrides.commandId ?? null,
    causationEventId: null,
    metadata: {}
  } as Extract<DomainEvent, { type: T }>;
}

/** The `thread.created` payload every fold test starts from. */
export function created(
  overrides: Partial<Extract<DomainEvent, { type: "thread.created" }>["payload"]> = {}
): Extract<DomainEvent, { type: "thread.created" }> {
  return ev("thread.created", {
    projectPath: "/w/p",
    cwd: "/w/p",
    title: "New thread",
    adapter: "claude",
    refId: "claude",
    accountId: "acc-1",
    home: "account",
    modelSelection: { model: "sonnet" },
    runtimeMode: "approval-required",
    ...overrides
  });
}

export function session(
  status: ThreadSessionState["status"],
  activeTurnId: string | null = null,
  extra: Partial<ThreadSessionState> = {}
): ThreadSessionState {
  return { status, activeTurnId, ...extra };
}

let activityCounter = 0;

export function resetActivityIds(): void {
  activityCounter = 0;
}

/** Build one activity item. `createdAt` defaults to a monotonic stamp. */
export function activity(
  activityKind: string,
  payload: unknown,
  overrides: Partial<ThreadActivityItem> = {}
): ThreadActivityItem {
  const n = ++activityCounter;
  const at = overrides.createdAt ?? stamp(n);
  return {
    kind: "activity",
    id: overrides.id ?? `a${n}`,
    tone: (overrides.tone ?? "info") as ThreadActivityTone,
    activityKind,
    summary: overrides.summary ?? activityKind,
    payload,
    turnId: overrides.turnId ?? null,
    createdAt: at,
    updatedAt: overrides.updatedAt ?? at,
    ...(overrides.agentId !== undefined ? { agentId: overrides.agentId } : {}),
    ...(overrides.parentToolUseId !== undefined
      ? { parentToolUseId: overrides.parentToolUseId }
      : {}),
    ...(overrides.status !== undefined ? { status: overrides.status } : {})
  };
}

/** An agent-stamped task payload — the roster's normal input. */
export function agentTask(
  taskId: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { taskId, agentKind: "agent", ...extra };
}
