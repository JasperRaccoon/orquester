/**
 * Agent chat — the shared thread fold (spec §5.1).
 *
 * **Signatures only. Package W2 implements every body.** The host projects
 * `meta.json` and the §6.3 snapshot with this, and the client applies the same
 * reducer to stream frames, so there is exactly one definition of "what the
 * thread looks like after these events".
 *
 * Rules the implementation owes (§5.1), restated here because both callers
 * depend on them:
 * - a `thread.message-sent` with `streaming: true` **appends** its text to the
 *   existing id; with `streaming: false`, empty text keeps the accumulated
 *   body and non-empty text replaces it;
 * - a turn is settled **by session status**, not by `turn.completed`, so a
 *   late checkpoint or diff never extends the recorded duration;
 * - the fold retains the last {@link ACTIVITY_RETENTION_LIMIT} activities,
 *   plus every unresolved async question and any long-lived singleton row
 *   regardless of age;
 * - a malformed line truncates the fold at that point rather than discarding
 *   the file.
 */

import type { DomainEvent } from "./domain-events.ts";
import type {
  Checkpoint,
  PendingRequests,
  RuntimeSubagent,
  ThreadHead,
  ThreadItem,
  ThreadSnapshotPayload,
  Turn
} from "./thread.ts";

/** §5.1: the fold retains this many activities per thread. */
export const ACTIVITY_RETENTION_LIMIT = 500;
/** §5.1 (T3 `projector.ts:59-60`): message and checkpoint retention. */
export const MESSAGE_RETENTION_LIMIT = 2_000;
export const CHECKPOINT_RETENTION_LIMIT = 500;

/**
 * Everything a thread fold accumulates. `head` is `null` until
 * `thread.created` lands, so a truncated or empty log is representable rather
 * than an error.
 */
export interface ThreadFoldState {
  head: ThreadHead | null;
  /** Timeline order: messages and activities interleaved by arrival. */
  items: ThreadItem[];
  /** Index into `items` by id, so a streaming delta is O(1). */
  itemIndex: Map<string, number>;
  turns: Turn[];
  checkpoints: Checkpoint[];
  /** Derived from the activity fold, never stored separately (§5.1). */
  pending: PendingRequests;
  roster: RuntimeSubagent[];
  /** Request ids permanently closed by a `*.resolved` row (the tombstone set). */
  closedRequestIds: Set<string>;
  /** Highest `seq` applied. */
  seq: number;
  /** True once `thread.deleted` has been applied. */
  deleted: boolean;
}

/** A fresh, empty fold state. */
export function createEmptyThreadState(): ThreadFoldState {
  throw new Error("agent-chat: createEmptyThreadState not implemented (package W2)");
}

/**
 * Apply one persisted event. MUST be pure with respect to `event` and MUST
 * return `state` unchanged (same reference) when the event changes nothing, so
 * the client's memoised row layers can take their fast path (§7.2).
 *
 * Events with `seq <= state.seq` are dropped — that is what makes the
 * overlapping snapshot/replay/live windows of §6.6 safe.
 */
export function applyDomainEvent(
  state: ThreadFoldState,
  event: DomainEvent
): ThreadFoldState {
  void state;
  void event;
  throw new Error("agent-chat: applyDomainEvent not implemented (package W2)");
}

/** Fold a whole log. Equivalent to reducing {@link applyDomainEvent} from empty. */
export function foldThread(events: Iterable<DomainEvent>): ThreadFoldState {
  void events;
  throw new Error("agent-chat: foldThread not implemented (package W2)");
}

/** Project a fold state onto the §6.3 read shape. `seq` is the floor (§6.3). */
export function toThreadSnapshot(state: ThreadFoldState): ThreadSnapshotPayload {
  void state;
  throw new Error("agent-chat: toThreadSnapshot not implemented (package W2)");
}
