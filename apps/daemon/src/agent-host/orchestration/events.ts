/**
 * Agent host — building the persisted envelope (spec §5.1).
 *
 * `{seq, eventId, threadId, type, payload, occurredAt, commandId |
 * null, causationEventId | null, metadata}`. Only the store may assign `seq`,
 * so everything built here is an {@link AppendableDomainEvent}.
 */

import type {
  DomainEvent,
  DomainEventMetadata,
  DomainEventType,
  ThreadActivityItem,
  ThreadActivityTone
} from "@orquester/api/agent-chat";

import type { AppendableDomainEvent } from "../services.ts";
import type { Clock, IdGen } from "./runtime-seams.ts";

type PayloadOf<TType extends DomainEventType> = Extract<DomainEvent, { type: TType }>["payload"];

interface EventBuilderOptions {
  commandId?: string | null;
  causationEventId?: string | null;
  metadata?: DomainEventMetadata;
  occurredAt?: string;
}

export function createEventBuilder(input: { clock: Clock; ids: IdGen }) {
  const { clock, ids } = input;
  return function buildEvent<TType extends DomainEventType>(
    threadId: string,
    type: TType,
    payload: PayloadOf<TType>,
    options: EventBuilderOptions = {}
  ): AppendableDomainEvent {
    return {
      eventId: ids.eventId(),
      threadId,
      type,
      payload,
      occurredAt: options.occurredAt ?? clock.nowIso(),
      commandId: options.commandId ?? null,
      causationEventId: options.causationEventId ?? null,
      metadata: options.metadata ?? {}
    } as AppendableDomainEvent;
  };
}

export type BuildEvent = ReturnType<typeof createEventBuilder>;

export function makeActivity(input: {
  id: string;
  tone: ThreadActivityTone;
  activityKind: string;
  summary: string;
  payload: unknown;
  turnId: string | null;
  createdAt: string;
  status?: ThreadActivityItem["status"];
}): ThreadActivityItem {
  return {
    kind: "activity",
    id: input.id,
    tone: input.tone,
    activityKind: input.activityKind,
    summary: input.summary,
    payload: input.payload,
    turnId: input.turnId,
    ...(input.status !== undefined ? { status: input.status } : {}),
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  };
}

/**
 * The row the host writes for a pending request it cancels itself, the
 * provider having answered nothing: on `/interrupt` and `/session/stop`
 * (`settlePendingRequests` in `orchestrator.ts`), on a thread's first load
 * for what a dead process left parked (`leftover-work.ts`), and — through
 * ingestion — for a request an adapter reports withdrawn: nobody answered it
 * and the wait on it has ended (a Codex card the server resolved itself, or a
 * collab child's card whose own turn ended or whose thread closed). "Request
 * cancelled" / "Question cancelled" — never the provider's "resolved" or
 * "submitted", which would say someone answered. Its id is the request's own,
 * prefixed, and the resolution kind closes the request in the fold for good
 * (`closedRequestIds`).
 */
export function cancelledRequestActivity(input: {
  requestId: string;
  kind: "approval" | "question";
  turnId: string | null;
  createdAt: string;
}): ThreadActivityItem {
  const approval = input.kind === "approval";
  return makeActivity({
    id: `settle-cancel:${input.requestId}`,
    tone: "info",
    activityKind: approval ? "approval.resolved" : "user-input.resolved",
    summary: approval ? "Request cancelled" : "Question cancelled",
    payload: approval
      ? { requestId: input.requestId, decision: "cancel" }
      : { requestId: input.requestId },
    turnId: input.turnId,
    createdAt: input.createdAt
  });
}

/** Flatten an unknown throwable into the one-line detail an activity carries. */
export function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
