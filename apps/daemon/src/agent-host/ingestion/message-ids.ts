// Ported from T3 Code (MIT): apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:252-308
/**
 * Message identity (spec §5.1 "Message identity and the streaming merge").
 *
 * A message id is minted by the host, never by the provider:
 * `assistant:<itemId ?? turnId ?? eventId>` for the first segment of a turn and
 * `assistant:<baseKey>:segment:<n>` for later ones, with the `reasoning:`
 * prefix and a `summary:`/`raw:` stream key for reasoning, so a provider that
 * streams a summary and a raw chain of thought over one item gets two
 * messages.
 */

import type { RuntimeContentStreamKind, RuntimeEvent } from "@orquester/api/agent-chat";

/**
 * Reasoning shares the assistant segmenting, buffering and finalisation
 * machinery; only the message-id namespace differs. The prefix is what tells a
 * buffered segment apart when it is flushed long after the delta that opened
 * it, so the role never has to be threaded through those paths.
 */
export type MessageStreamRole = "assistant" | "reasoning";

export const ASSISTANT_MESSAGE_ID_PREFIX = "assistant:";
export const REASONING_MESSAGE_ID_PREFIX = "reasoning:";

export function messageStreamRoleOf(messageId: string): MessageStreamRole {
  return messageId.startsWith(REASONING_MESSAGE_ID_PREFIX) ? "reasoning" : "assistant";
}

/**
 * `ThreadMessageItem.reasoningKind` (§7.3): whether the provider sent raw
 * reasoning or a summary of it. The stream key is already baked into the base
 * key by {@link reasoningSegmentBaseKeyFromEvent}, so the id is the record —
 * there is nothing extra to carry. A whole-block snapshot
 * (`reasoning:snapshot:…`) arrived without a stream kind, so it answers
 * `undefined` and the row renders without a badge rather than guessing.
 */
export function reasoningKindOfMessageId(
  messageId: string
): "text" | "summary" | undefined {
  if (!messageId.startsWith(REASONING_MESSAGE_ID_PREFIX)) {
    return undefined;
  }
  const rest = messageId.slice(REASONING_MESSAGE_ID_PREFIX.length);
  if (rest.startsWith("summary:")) {
    return "summary";
  }
  if (rest.startsWith("raw:")) {
    return "text";
  }
  return undefined;
}

/** `assistant:<baseKey>` / `assistant:<baseKey>:segment:<n>` (and `reasoning:` ditto). */
export function segmentMessageId(
  baseKey: string,
  segmentIndex: number,
  role: MessageStreamRole = "assistant"
): string {
  const prefix = role === "reasoning" ? REASONING_MESSAGE_ID_PREFIX : ASSISTANT_MESSAGE_ID_PREFIX;
  return segmentIndex === 0
    ? `${prefix}${baseKey}`
    : `${prefix}${baseKey}:segment:${segmentIndex}`;
}

/**
 * The base key a message's id is built from — **namespaced by its owner**.
 *
 * A subagent's blocks arrive on the parent's stream, inside the parent's turn,
 * and an adapter may name no item at all (the id then falls back to the turn
 * id). Without the owner in the key, the agent's message and the parent's
 * would be the same id and the fold would concatenate a subagent's prose into
 * the parent's bubble.
 */
export function segmentBaseKeyFromEvent(event: RuntimeEvent): string {
  return ownedBaseKey(String(event.itemId ?? event.turnId ?? event.eventId), event.agentId);
}

/** The one place a base key is namespaced by its owning subagent. */
export function ownedBaseKey(baseKey: string, agentId: string | undefined): string {
  return agentId !== undefined && agentId.length > 0 ? `agent:${agentId}:${baseKey}` : baseKey;
}

/**
 * A provider may stream a reasoning summary and the raw chain of thought over
 * the same item. They are different texts, so they get different segments.
 */
export function reasoningSegmentBaseKeyFromEvent(
  event: RuntimeEvent,
  streamKind: Extract<RuntimeContentStreamKind, "reasoning_text" | "reasoning_summary_text">
): string {
  const stream = streamKind === "reasoning_summary_text" ? "summary" : "raw";
  return `${stream}:${segmentBaseKeyFromEvent(event)}`;
}

/** The proposal buffer's identity, stable for a turn (§5.1 plan-text buffer). */
export function proposedPlanIdForTurn(threadId: string, turnId: string): string {
  return `plan:${threadId}:turn:${turnId}`;
}

export function proposedPlanIdFromEvent(event: RuntimeEvent, threadId: string): string {
  if (event.turnId !== undefined) {
    return proposedPlanIdForTurn(threadId, String(event.turnId));
  }
  if (event.itemId !== undefined) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

/** Stable activity ids — a row that is "latest state", not history. */
export function taskProgressActivityId(threadId: string, taskId: string): string {
  return `task-progress:${threadId}:${taskId}`;
}

export function taskUsageActivityId(threadId: string, taskId: string): string {
  return `task-usage:${threadId}:${taskId}`;
}

export function toolProgressActivityId(threadId: string, taskId: string): string {
  return `tool-progress:${threadId}:${taskId}`;
}

/**
 * The goal's hidden `progress` row (goals §4.3, §8.4): one per thread, like a
 * task's progress row. Each tick replaces it in place rather than spending a
 * slot of the 500-row parent window, and the fold still takes the goal from it.
 */
export function goalProgressActivityId(threadId: string): string {
  return `goal-progress:${threadId}`;
}

export function proposedPlanActivityId(planId: string): string {
  return `proposed-plan:${planId}`;
}

export const USER_MESSAGE_ID_PREFIX = "user:";

/**
 * A REPLAYED user prompt's message id (E6). The live path never mints one —
 * `/turn` appends the user message itself — so this namespace exists purely
 * for history, and is derived from the provider's own item id so replaying
 * the same transcript twice rewrites the row rather than duplicating it.
 */
export function historicalUserMessageId(event: {
  itemId?: string;
  turnId?: string;
  eventId: string;
}): string {
  return `${USER_MESSAGE_ID_PREFIX}${String(event.itemId ?? event.turnId ?? event.eventId)}`;
}

/** Command/file-change output deltas are buffered per item id (§5.6). */
export function toolOutputBufferKey(threadId: string, itemId: string): string {
  return `tool-output:${threadId}:${itemId}`;
}
