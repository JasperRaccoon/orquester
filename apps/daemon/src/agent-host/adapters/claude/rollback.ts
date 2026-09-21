/**
 * Claude adapter — conversation rollback (spec §4.5 "Rollback is a native
 * fork with a hard failure mode", §5.5).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/ClaudeAdapter.ts:146-225`
 * (`isClaudeHumanTurnStart`, `conversationIndexForUuid`,
 * `remapClaudeForkTurnBoundaries`) and `:5306-5486` (the rollback itself).
 *
 * The pure half lives here so the alignment rules — which are the part that
 * must never guess — are unit-tested without a CLI.
 *
 * A fork **rewrites every uuid**, and `getSessionMessages` then rebuilds the
 * parentUuid chain, so system notices and compaction metadata can change the
 * raw length without dropping retained turns. Retained conversation messages
 * are therefore aligned **from the truncated end**, and every one of them must
 * match on **deep-equal body and role**: matching roles alone once mistook a
 * restored steering message for a retained turn start. Any mismatch, any
 * missing boundary, or a compaction in between is a **hard error** telling the
 * user to start a new thread — refuse rather than guess.
 */

import { isDeepStrictEqual } from "node:util";

/** The `SessionMessage` shape this module needs, read structurally. */
export interface ClaudeHistoryMessage {
  type: "user" | "assistant" | "system";
  uuid: string;
  message?: unknown;
  parent_tool_use_id?: string | null;
  isMeta?: boolean;
  isCompactSummary?: boolean;
}

export const ROLLBACK_BOUNDARY_UNAVAILABLE =
  "The exact Claude turn boundary is unavailable, possibly after compaction or recovery of older history. Start a new thread instead.";
export const ROLLBACK_FORK_MISALIGNED =
  "Claude fork history did not preserve the retained turn boundaries. Start a new thread instead.";
export const ROLLBACK_HISTORY_UNAVAILABLE = "Claude session history is unavailable.";
export const ROLLBACK_COMPACTED =
  "This conversation was compacted after that turn, so Claude no longer holds the messages the rewind would restore. Start a new thread instead.";
export const ROLLBACK_SESSION_UNAVAILABLE = "Claude session id is unavailable.";

export function isClaudeConversationMessage(message: ClaudeHistoryMessage): boolean {
  return message.type === "user" || message.type === "assistant";
}

/**
 * Only human prompts begin a turn. Tool results are user-role messages too,
 * and so are the CLI's synthetic notices, so neither may be counted.
 */
export function isClaudeHumanTurnStart(message: ClaudeHistoryMessage): boolean {
  if (message.type !== "user" || message.isMeta === true) {
    return false;
  }
  if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) {
    return false;
  }
  const body = message.message;
  if (body === null || typeof body !== "object") {
    return false;
  }
  const content = (body as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  // A block array that holds a tool_result is the tool half of a turn, never
  // its start.
  return !content.some(
    (entry) =>
      entry !== null && typeof entry === "object" && (entry as { type?: unknown }).type === "tool_result"
  );
}

export function conversationIndexForUuid(
  messages: readonly ClaudeHistoryMessage[],
  uuid: string
): number {
  let index = -1;
  for (const message of messages) {
    if (!isClaudeConversationMessage(message)) {
      continue;
    }
    index += 1;
    if (message.uuid === uuid) {
      return index;
    }
  }
  return -1;
}

/**
 * Re-align the retained turn boundaries onto the fork's rewritten uuids.
 * Returns `undefined` when the fork did not preserve them — the caller turns
 * that into a hard refusal.
 */
export function remapClaudeForkTurnBoundaries(
  messages: readonly ClaudeHistoryMessage[],
  forkMessages: readonly ClaudeHistoryMessage[],
  firstRemoved: number,
  retainedBoundaries: readonly (string | null)[]
): Array<string | null> | undefined {
  const retainedConversation = messages.slice(0, firstRemoved).filter(isClaudeConversationMessage);
  const forkConversation = forkMessages.filter(isClaudeConversationMessage);

  if (retainedConversation.length === 0) {
    return retainedBoundaries.every((id) => id === null) ? [...retainedBoundaries] : undefined;
  }

  const offset = forkConversation.length - retainedConversation.length;
  if (
    offset < 0 ||
    retainedConversation.some((message, index) => {
      const forkMessage = forkConversation[index + offset];
      return (
        forkMessage === undefined ||
        forkMessage.type !== message.type ||
        !isDeepStrictEqual(forkMessage.message, message.message)
      );
    })
  ) {
    return undefined;
  }

  const remapped = retainedBoundaries.map((originalId) => {
    if (originalId === null) {
      return null;
    }
    const originalIndex = conversationIndexForUuid(messages, originalId);
    const forkIndex = originalIndex + offset;
    const forkMessage =
      originalIndex >= 0 && forkIndex >= 0 ? forkConversation[forkIndex] : undefined;
    const originalMessage = messages.find((message) => message.uuid === originalId);
    return forkMessage !== undefined &&
      originalMessage !== undefined &&
      forkMessage.type === originalMessage.type
      ? forkMessage.uuid
      : null;
  });
  return remapped.some((id) => id === null) ? undefined : remapped;
}

export interface RollbackPlan {
  /** Number of turns kept. */
  retainedCount: number;
  /** The boundaries kept, before any fork remap. */
  retainedBoundaries: Array<string | null>;
  /**
   * The uuid to fork at — the last retained chain entry. `undefined` means
   * everything is removed and the caller starts a fresh session instead.
   */
  rollbackAt: string | undefined;
  /** Index of the first removed message in the raw history. */
  firstRemoved: number;
}

/**
 * Decide what a rollback of `numTurns` removes, from the persisted boundaries
 * and the native history. Throws the exact §4.5 refusal when the boundary
 * cannot be established.
 */
export function planClaudeRollback(input: {
  messages: readonly ClaudeHistoryMessage[];
  boundaries: readonly (string | null)[];
  numTurns: number;
}): RollbackPlan {
  const { messages, numTurns } = input;
  if (messages.length === 0) {
    throw new Error(ROLLBACK_HISTORY_UNAVAILABLE);
  }

  const boundaries = [...input.boundaries];
  // Older cursors did not record native boundaries. Infer them only when their
  // turn count agrees; a steer must never be treated as an extra turn.
  const turnStarts = messages.flatMap((message, index) =>
    isClaudeHumanTurnStart(message) ? [index] : []
  );
  const noNativeBoundaries = !boundaries.some((id) => id !== null);
  if (boundaries.length > 0 && noNativeBoundaries && boundaries.length === turnStarts.length) {
    boundaries.splice(
      0,
      boundaries.length,
      ...turnStarts.map((index) => messages[index]!.uuid)
    );
  }

  const retainedCount = Math.max(0, boundaries.length - numTurns);
  const firstRemovedId = boundaries[retainedCount];
  const firstRemoved = messages.findIndex((message) => message.uuid === firstRemovedId);

  if (
    boundaries.length === 0 ||
    boundaries.some((id) => id === null) ||
    (retainedCount > 0 && firstRemoved < 1)
  ) {
    throw new Error(ROLLBACK_BOUNDARY_UNAVAILABLE);
  }

  return {
    retainedCount,
    retainedBoundaries: boundaries.slice(0, retainedCount),
    rollbackAt: retainedCount > 0 ? messages[firstRemoved - 1]?.uuid : undefined,
    firstRemoved
  };
}

/**
 * A compaction between the anchor and now makes a rollback unreachable, and
 * `compact_metadata.preserved_messages.all_uuids` names exactly the uuids that
 * survived — so the adapter can say so precisely instead of failing the
 * deep-equal scan later (fixtures/claude README observation 17).
 */
export function isAnchorReachableAfterCompaction(input: {
  anchorUuid: string;
  preservedUuids: readonly string[] | undefined;
}): boolean {
  if (input.preservedUuids === undefined || input.preservedUuids.length === 0) {
    return true;
  }
  return input.preservedUuids.includes(input.anchorUuid);
}
