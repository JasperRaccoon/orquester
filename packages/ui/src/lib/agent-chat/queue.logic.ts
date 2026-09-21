/**
 * Agent chat — the client-side queued-message model (spec §7.4).
 *
 * Ported from T3 Code (MIT): `apps/web/src/queuedMessageStore.ts`.
 *
 * This is the client's own queue of messages it has **not dispatched yet**, and
 * it is a different thing from the host-side queue that holds already-posted
 * `/turn`s behind a running compaction (§3.4). A queued message is a full draft
 * snapshot held **in memory only**: a live intent, not a draft worth persisting.
 *
 * It flushes at the **next tool-call boundary or at turn end**, whichever comes
 * first; taking one re-anchors every remaining message to the new boundary, so
 * exactly one message leaves per boundary instead of the whole queue draining
 * at once.
 *
 * Three guards are load-bearing (§7.4):
 * 1. a send that grabbed a message before an interrupt and finished its upload
 *    after it must detect the drain and give up — otherwise Stop is followed by
 *    a queued message starting a new turn ({@link QueueState.drainGeneration});
 * 2. a failed send is re-inserted at the front with `holdUntilUserAction`, so
 *    nothing overtakes it ({@link holdAtFront});
 * 3. nothing flushes while an approval or a question is pending
 *    ({@link isQueuedMessageDue}).
 *
 * Pure and immutable: every operation returns a new state, so the zustand slice
 * can store it directly. No React import.
 */

import type { ThreadActivityItem } from "@orquester/api/agent-chat";

import type { QueuedComposerMessage } from "./contracts";

export interface QueueState {
  readonly messages: readonly QueuedComposerMessage[];
  /**
   * Bumped by {@link drainQueue}. A send that took a message before a drain and
   * finishes its upload after it compares this to the value it captured and
   * gives up.
   */
  readonly drainGeneration: number;
}

export const EMPTY_QUEUE: QueueState = { messages: [], drainGeneration: 0 };

export function enqueue(
  state: QueueState,
  message: Omit<QueuedComposerMessage, "id" | "queuedAt">,
  now: () => string,
  newId: () => string
): { state: QueueState; message: QueuedComposerMessage } {
  const entry: QueuedComposerMessage = { ...message, id: newId(), queuedAt: now() };
  return {
    state: { ...state, messages: [...state.messages, entry] },
    message: entry
  };
}

/**
 * Remove one message and return it, or `null` when another caller already took
 * it. The remaining messages are **re-anchored** to `toolActivityId`, so only
 * one queued message leaves per tool boundary.
 *
 * *T3: `queuedMessageStore.ts:84-107`.*
 */
export function takeQueued(
  state: QueueState,
  id: string,
  toolActivityId: string | null
): { state: QueueState; message: QueuedComposerMessage | null } {
  const entry = state.messages.find((message) => message.id === id);
  if (!entry) {
    return { state, message: null };
  }
  const remaining = state.messages
    .filter((message) => message.id !== id)
    .map((message) =>
      message.queuedAfterToolActivityId === toolActivityId
        ? message
        : { ...message, queuedAfterToolActivityId: toolActivityId }
    );
  return { state: { ...state, messages: remaining }, message: entry };
}

/** Remove one message without touching the others' anchors. *T3: `:109-127`.* */
export function removeQueued(
  state: QueueState,
  id: string
): { state: QueueState; message: QueuedComposerMessage | null } {
  const entry = state.messages.find((message) => message.id === id);
  if (!entry) {
    return { state, message: null };
  }
  return {
    state: { ...state, messages: state.messages.filter((message) => message.id !== id) },
    message: entry
  };
}

/**
 * Put a message back at the head, held for user action — used when its send
 * failed, so the queue keeps its order and nothing behind it overtakes.
 *
 * *T3: `queuedMessageStore.ts:128-140`.*
 */
export function holdAtFront(state: QueueState, message: QueuedComposerMessage): QueueState {
  const rest = state.messages.filter((entry) => entry.id !== message.id);
  return { ...state, messages: [{ ...message, holdUntilUserAction: true }, ...rest] };
}

/**
 * Remove and return every queued message, oldest first, and bump the drain
 * generation. **Interrupting returns every queued message to the composer**
 * rather than discarding it (§7.4).
 *
 * *T3: `queuedMessageStore.ts:141-152`.*
 */
export function drainQueue(state: QueueState): {
  state: QueueState;
  messages: QueuedComposerMessage[];
} {
  if (state.messages.length === 0) {
    return { state, messages: [] };
  }
  return {
    state: { messages: [], drainGeneration: state.drainGeneration + 1 },
    messages: [...state.messages]
  };
}

/**
 * The newest finished tool call. Its id changing is the boundary a queued
 * message goes out on. Live arrays are ordered, but a snapshot loaded from disk
 * may not be, so pick by sequence rather than by position.
 *
 * *T3: `queuedMessageStore.ts:154-181`.*
 */
export function latestCompletedToolActivityId(
  activities: readonly Pick<ThreadActivityItem, "id" | "activityKind" | "createdAt">[]
): string | null {
  let latest: { id: string; createdAt: string } | null = null;
  for (const activity of activities) {
    if (activity.activityKind !== "tool.completed") {
      continue;
    }
    if (latest === null || activity.createdAt > latest.createdAt) {
      latest = { id: activity.id, createdAt: activity.createdAt };
    }
  }
  return latest?.id ?? null;
}

/** The session phase the due check reads. `connecting` is the gap after a send. */
export type QueuePhase = "connecting" | "running" | "ready" | "disconnected";

/**
 * A queued message is due mid-turn once a tool call finished **after** it was
 * queued, and as soon as the turn is over otherwise. Nothing is due while a
 * request is pending, or while the thread is still connecting.
 *
 * *T3: `queuedMessageStore.ts:183-197`; the pending-request gate is
 * `apps/web/src/components/ChatView.tsx:8604-8642`, folded in here so the one
 * predicate answers the whole question.*
 */
export function isQueuedMessageDue(input: {
  message: Pick<QueuedComposerMessage, "queuedAfterToolActivityId" | "holdUntilUserAction">;
  phase: QueuePhase;
  latestToolActivityId: string | null;
  /** Any open approval or question blocks the whole queue (§7.4). */
  hasPendingRequests?: boolean;
}): boolean {
  if (input.message.holdUntilUserAction) {
    return false;
  }
  if (input.hasPendingRequests) {
    return false;
  }
  if (input.phase === "connecting") {
    return false;
  }
  if (input.phase !== "running") {
    return true;
  }
  return input.latestToolActivityId !== input.message.queuedAfterToolActivityId;
}

/** The one message the next boundary would send, or null. */
export function nextDueQueuedMessage(
  state: QueueState,
  input: Omit<Parameters<typeof isQueuedMessageDue>[0], "message">
): QueuedComposerMessage | null {
  const head = state.messages[0];
  if (!head) {
    return null;
  }
  return isQueuedMessageDue({ ...input, message: head }) ? head : null;
}

// ---------------------------------------------------------------------------
// Steer versus queue (§7.4)
// ---------------------------------------------------------------------------

/**
 * The user's standing preference for what a send does during a live turn.
 *
 * Declared here — the module that acts on it — so it stays free of any
 * component import; `components/agent-chat/composer/composer-submission.ts`
 * (W13) and `lib/chat-prefs.ts` (the persisted setting) both re-export this
 * one. There is exactly one declaration; keep it that way.
 */
export type FollowUpBehavior = "steer" | "queue";

/** `alternate` is mod+Enter: it inverts the preference for that one message. */
export type ComposerSubmissionIntent = "foreground" | "alternate";

/**
 * **One setting with a per-message inversion.** A plain send follows the
 * preference; holding the mod key with Enter does the opposite for that one
 * message.
 *
 * *T3: `apps/web/src/components/ChatView.tsx:7629-7658` — the same XOR.*
 */
export function shouldQueueSubmission(input: {
  followUpBehavior: FollowUpBehavior;
  submissionIntent: ComposerSubmissionIntent;
  isRunning: boolean;
}): boolean {
  if (!input.isRunning) {
    return false;
  }
  return (input.followUpBehavior === "queue") !== (input.submissionIntent === "alternate");
}
