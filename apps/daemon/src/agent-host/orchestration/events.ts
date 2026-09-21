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

export interface EventBuilderOptions {
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

/**
 * The five `provider.*.failed` activity kinds (§6.2): a provider-side failure is
 * never an HTTP error — it lands in the timeline as a row with tone `error`.
 *
 * *T3: `ProviderCommandReactor.ts:268-304` (`appendProviderFailureActivity`).*
 */
export type ProviderFailureKind =
  | "provider.turn.start.failed"
  | "provider.turn.interrupt.failed"
  | "provider.approval.respond.failed"
  | "provider.user-input.respond.failed"
  | "provider.session.stop.failed"
  | "checkpoint.revert.failed"
  | "runtime.error";

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
