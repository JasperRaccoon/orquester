/**
 * Agent chat — the persisted domain event union (spec §5.1).
 *
 * Ported from T3 Code (MIT): `packages/contracts/src/orchestration.ts`
 * (`OrchestrationEventType` + payloads), narrowed to the fourteen types this
 * design persists.
 *
 * **Two event layers, not one.** `events.ndjson` holds these *domain* events —
 * past-tense facts about the thread — not the adapter runtime union of §4.2.
 * Ingestion is a separate hop, so a provider capability can change without
 * changing the persisted shape.
 *
 * **Rollback boundary (§8).** Rolling the deploy back rolls back code, never
 * `<appdir>/daemon/agent/threads/`. Every shape here therefore has to stay
 * decodable by the build before it: add optional fields, never required ones,
 * and never repurpose a name.
 */

import type {
  AccountHomeKind,
  AgentAdapterId,
  AttachmentRef,
  ComposerContextRecord,
  InteractionMode,
  ModelSelection,
  RuntimeMode
} from "./adapter-types.ts";
import type { ApprovalDecision, TurnTokenUsage } from "./runtime-events.ts";
import type {
  CheckpointFile,
  CheckpointStatus,
  ThreadActivityItem,
  ThreadMessageRole,
  ThreadSessionState,
  TurnState
} from "./thread.ts";

// ---------------------------------------------------------------------------
// Envelope (§5.1)
// ---------------------------------------------------------------------------

/**
 * Provider-shaped identifiers that must not leak into payloads but are needed
 * to correlate a domain event with the frame that caused it.
 *
 * *T3: `orchestration.ts:1971-1986`; differs: `aggregateKind`/`aggregateId`/
 * `correlationId`/`origin` are dropped — one aggregate kind, one client
 * identity.*
 */
export interface DomainEventMetadata {
  providerTurnId?: string;
  providerItemId?: string;
  adapterKey?: string;
  requestId?: string;
  ingestedAt?: string;
}

/** *T3: `orchestration.ts:1988-1998` (`EventBaseFields`).* */
export interface DomainEventBase {
  /** Per-thread monotonic sequence. There is no global ordering (§5.1). */
  seq: number;
  eventId: string;
  threadId: string;
  occurredAt: string;
  /** The client-minted idempotency key, or null for a host-originated event. */
  commandId: string | null;
  causationEventId: string | null;
  metadata: DomainEventMetadata;
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export interface ThreadCreatedPayload {
  projectPath: string;
  cwd: string;
  title: string;
  adapter: AgentAdapterId;
  refId: string;
  accountId: string;
  home: AccountHomeKind;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
}

/**
 * The ONLY writer of both the title and the model selection (§5.1) — which is
 * what lets the §7 fold rebuild the head without a second event type, and what
 * the §6.1 `PUT` rename appends. There is deliberately **no** model-set event.
 */
export interface ThreadMetaUpdatedPayload {
  title?: string;
  modelSelection?: ModelSelection;
}

export interface ThreadRuntimeModeSetPayload {
  runtimeMode: RuntimeMode;
}

/**
 * One message, or one streaming delta of it (§5.1). A delta carries **only the
 * new text** with `streaming: true` and the fold concatenates onto the
 * existing id. A completion carries the same type with `streaming: false`:
 * empty text keeps the accumulated body, non-empty text replaces it. There is
 * no separate delta event type.
 */
export interface ThreadMessageSentPayload {
  messageId: string;
  role: ThreadMessageRole;
  text: string;
  streaming: boolean;
  turnId: string | null;
  attachments?: AttachmentRef[];
  context?: ComposerContextRecord[];
  agentId?: string;
  /**
   * `ThreadMessageItem.reasoningKind` / `.messageKind` (§7.3). Neither is
   * recoverable from the text, and only ingestion knows them — the first from
   * the content stream kind, the second from the provider's message phase — so
   * they ride the event that creates the message. Both are optional and are
   * only meaningful on their own role; absent means unknown, and the row then
   * renders without a badge rather than guessing.
   *
   * *Added by W3 for W12's fields; additive (§8 rollback boundary: an older
   * build ignores them, a newer build tolerates a row without them).*
   */
  reasoningKind?: "text" | "summary";
  messageKind?: "answer" | "commentary";
}

export interface ThreadTurnStartRequestedPayload {
  /** Null until the provider mints one; the turn exists as a pending row (§5.1). */
  turnId: string | null;
  messageId: string;
  interactionMode: InteractionMode;
  modelSelection?: ModelSelection;
  /** §3.3 recovery. Validated against `promptlessTurnContinuation` (§4.1). */
  continuation?: boolean;
  /**
   * A turn REPLAYED from the provider's own transcript
   * (`AgentAdapter.projectHistory`), which is already over.
   *
   * Every live turn is settled by the fold from session status (§5.1), and a
   * historical turn must not touch session status at all — it describes
   * something that already happened, so letting it move the live session
   * would settle whatever turn is actually running. So the settlement rides
   * the event that creates the row: the fold builds it settled rather than
   * `running`, and nothing else in the thread moves.
   *
   * *Added additively for the E6 history replay; an older build renders the
   * row as `running`, a newer build tolerates its absence (§8).*
   */
  settled?: {
    state: TurnState;
    tokenUsage?: TurnTokenUsage;
    completedAt: string;
    /** The turn's answer, for the §5.5 "rewind to here" anchor. */
    assistantMessageId?: string;
  };
}

export interface ThreadTurnInterruptRequestedPayload {
  /**
   * Omitted whenever the session is not `running` — an interrupt with no turn
   * id stops every live subagent, background shell and watch loop (§6.2).
   */
  turnId: string | null;
}

export interface ThreadApprovalResponseRequestedPayload {
  requestId: string;
  decision: ApprovalDecision;
}

export interface ThreadUserInputResponseRequestedPayload {
  requestId: string;
  answers: Record<string, unknown>;
  /** Persisted so an answered card renders without the original request (§4.3). */
  questionTextById?: Record<string, string>;
}

export interface ThreadSessionSetPayload {
  session: ThreadSessionState;
  /**
   * The provider's final numbers for the turn this event settles.
   *
   * A turn is settled by the fold FROM the session status (§5.1), so this
   * event is the turn end — and it is the only place the per-turn
   * `tokenUsage` / `totalCostUsd` off `turn.completed` can reach {@link Turn}
   * without inventing a second settlement event that could disagree with this
   * one. Present only on the event that settles a named turn; the fold matches
   * it by `turnId` and never lets it resurrect an already-settled turn.
   *
   * *Added additively for E2E E10; an older build ignores it, a newer build
   * tolerates a row without it (§8 rollback boundary).*
   */
  turn?: {
    turnId: string;
    tokenUsage?: TurnTokenUsage;
    totalCostUsd?: number;
  };
}

export interface ThreadActivityAppendedPayload {
  activity: ThreadActivityItem;
}

export interface ThreadTurnDiffCompletedPayload {
  turnCount: number;
  turnId: string | null;
  ref: string;
  status: CheckpointStatus;
  files: CheckpointFile[];
  assistantMessageId: string | null;
  completedAt: string;
}

export interface ThreadCheckpointRevertRequestedPayload {
  targetTurnCount: number;
}

export interface ThreadRevertedPayload {
  turnCount: number;
}

export interface ThreadDeletedPayload {
  deletedAt: string;
}

// ---------------------------------------------------------------------------
// The union (§5.1)
// ---------------------------------------------------------------------------

type Ev<TType extends string, TPayload> = DomainEventBase & {
  type: TType;
  payload: TPayload;
};

export type ThreadCreatedEvent = Ev<"thread.created", ThreadCreatedPayload>;
export type ThreadMetaUpdatedEvent = Ev<"thread.meta-updated", ThreadMetaUpdatedPayload>;
export type ThreadRuntimeModeSetEvent = Ev<
  "thread.runtime-mode-set",
  ThreadRuntimeModeSetPayload
>;
export type ThreadMessageSentEvent = Ev<"thread.message-sent", ThreadMessageSentPayload>;
export type ThreadTurnStartRequestedEvent = Ev<
  "thread.turn-start-requested",
  ThreadTurnStartRequestedPayload
>;
export type ThreadTurnInterruptRequestedEvent = Ev<
  "thread.turn-interrupt-requested",
  ThreadTurnInterruptRequestedPayload
>;
export type ThreadApprovalResponseRequestedEvent = Ev<
  "thread.approval-response-requested",
  ThreadApprovalResponseRequestedPayload
>;
export type ThreadUserInputResponseRequestedEvent = Ev<
  "thread.user-input-response-requested",
  ThreadUserInputResponseRequestedPayload
>;
export type ThreadSessionSetEvent = Ev<"thread.session-set", ThreadSessionSetPayload>;
export type ThreadActivityAppendedEvent = Ev<
  "thread.activity-appended",
  ThreadActivityAppendedPayload
>;
export type ThreadTurnDiffCompletedEvent = Ev<
  "thread.turn-diff-completed",
  ThreadTurnDiffCompletedPayload
>;
export type ThreadCheckpointRevertRequestedEvent = Ev<
  "thread.checkpoint-revert-requested",
  ThreadCheckpointRevertRequestedPayload
>;
export type ThreadRevertedEvent = Ev<"thread.reverted", ThreadRevertedPayload>;
export type ThreadDeletedEvent = Ev<"thread.deleted", ThreadDeletedPayload>;

/**
 * Everything the timeline shows is one of these; there is **no persisted event
 * per runtime event** (§5.1).
 *
 * Note the two deliberate absences:
 * - a dismissal has **no event of its own** — `/dismiss` appends the ordinary
 *   `user-input.resolved` activity that closes the question;
 * - a model change rides `thread.meta-updated {title?, modelSelection?}`.
 */
export type DomainEvent =
  | ThreadCreatedEvent
  | ThreadMetaUpdatedEvent
  | ThreadRuntimeModeSetEvent
  | ThreadMessageSentEvent
  | ThreadTurnStartRequestedEvent
  | ThreadTurnInterruptRequestedEvent
  | ThreadApprovalResponseRequestedEvent
  | ThreadUserInputResponseRequestedEvent
  | ThreadSessionSetEvent
  | ThreadActivityAppendedEvent
  | ThreadTurnDiffCompletedEvent
  | ThreadCheckpointRevertRequestedEvent
  | ThreadRevertedEvent
  | ThreadDeletedEvent;

export type DomainEventType = DomainEvent["type"];

/** Every persisted type, in the order §5.1 lists them. */
export const DOMAIN_EVENT_TYPES = [
  "thread.created",
  "thread.meta-updated",
  "thread.runtime-mode-set",
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.session-set",
  "thread.activity-appended",
  "thread.turn-diff-completed",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.deleted"
] as const satisfies readonly DomainEventType[];

// ---------------------------------------------------------------------------
// Receipts (§5.1, §6.2)
// ---------------------------------------------------------------------------

export type CommandReceiptStatus = "accepted" | "rejected";

/**
 * Written in the same step that appends the events, so a receipt never exists
 * for events that did not land (§5.1). A repeat of an accepted `commandId`
 * replays its `seq`; a repeat of a rejected one replays the recorded
 * rejection; a `commandId` recorded against a *different* thread is a hard
 * conflict.
 */
export interface CommandReceipt {
  commandId: string;
  threadId: string;
  seq: number;
  status: CommandReceiptStatus;
  acceptedAt: string;
  /** The recorded rejection, replayed verbatim on a retry. */
  error?: { code: string; message: string; detail?: unknown };
}

/** `receipts.json` is a ring of this many entries (§5.1). */
export const RECEIPTS_RING_SIZE = 500;
